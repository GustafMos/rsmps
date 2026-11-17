/**
 * The render queue wired to the app: the real runner (the exporter's public API, one job at a time), storage (its own small IndexedDB so
 * nothing else is touched), and the destination (a folder chosen once through the File System Access API when the browser has it,
 * otherwise sequential downloads). The pure state machine is in io/queue.ts.
 */
import { JobQueue, jobGraph, jobOutputs, safePathParts, type JobRunner, type QueueJob, type QueueStorage, type StoredQueue } from '../../io/queue';
import type { ExportedFile } from '../../io/api';
import { parseGraph } from '../../io/projects';
import type { AppCtx } from './context';
import { createStore, type Store } from './createStore';

const DB = 'rsmps-queue';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet<T>(key: string): Promise<T | null> {
  const db = await open();
  return new Promise((resolve) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve((r.result as T | undefined) ?? null);
    r.onerror = () => resolve(null);
  });
}
async function kvPut(key: string, value: unknown): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const storage: QueueStorage = {
  load: () => kvGet<StoredQueue>('queue'),
  save: (q) => kvPut('queue', q),
};

/* ------------------------------ destination ------------------------------ */

interface DirHandle {
  name: string;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}

export interface QueueUi {
  /** Name of the chosen folder, or null (downloads). */
  folder: string | null;
  canPickFolder: boolean;
  /** True while a queue runs (interactive export should wait). */
  busy: boolean;
}

let dir: DirHandle | null = null;
export const queueUi: Store<QueueUi> = createStore<QueueUi>({ folder: null, canPickFolder: typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function', busy: false });

/** Ask for a folder (call from a click). */
export async function chooseFolder(): Promise<boolean> {
  const w = window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> };
  if (!w.showDirectoryPicker) return false;
  try {
    dir = await w.showDirectoryPicker({ mode: 'readwrite', id: 'rsmps-queue' });
    await kvPut('folder', dir).catch(() => undefined);
    queueUi.set((s) => ({ ...s, folder: dir!.name }));
    return true;
  } catch {
    return false; // cancelled
  }
}

/** Bring back the folder chosen last time; permission is asked again from a click (see `ensureFolderPermission`). */
async function restoreFolder(): Promise<void> {
  const h = await kvGet<DirHandle>('folder').catch(() => null);
  if (h && typeof h.getFileHandle === 'function') {
    dir = h;
    queueUi.set((s) => ({ ...s, folder: h.name }));
  }
}

/** From a click: make sure the saved folder may be written to. False = the user said no (downloads are used instead). */
export async function ensureFolderPermission(): Promise<boolean> {
  if (!dir) return true;
  try {
    if ((await dir.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    return (await dir.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

async function writeInto(root: DirHandle, files: ExportedFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    if (!f.blob.size) continue; // already saved by the desktop app (FFmpeg formats)
    const parts = safePathParts(f.name);
    if (!parts) throw new Error(`Refused to write "${f.name}": the name is not safe inside the chosen folder.`);
    let d = root;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(f.blob);
    await w.close();
    written.push(parts.join('/'));
  }
  return written;
}

/* ------------------------------ the queue ------------------------------ */

let queue: JobQueue | null = null;
export const queueState: Store<{ v: number }> = createStore({ v: 0 });

export function getQueue(app: AppCtx): JobQueue {
  if (queue) return queue;
  const { io, ed } = app;
  const runner: JobRunner = {
    async run(job, onProgress, signal) {
      const ids = job.outputs.filter((o) => o.enabled).map((o) => o.id);
      if (!ids.length) throw new Error('No output is switched on for this job.');
      // never overlap with an export started by hand: wait until its floating bar is gone
      while (ed.state.exportJob && !signal.aborted) await new Promise((r) => setTimeout(r, 500));
      const useDir = !!dir;
      const files = await io.exporter.run({
        graph: jobGraph(job),
        outputs: ids,
        items: 'all',
        item: 0,
        zip: !useDir, // a folder gets the files themselves; downloads get one zip per job instead of hundreds of files
        signal,
        runProcesses: true, // unattended: run what has to run first, never stop to ask
        onProgress: (p) => onProgress(p.fraction, p.label),
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (dir && (await dir.queryPermission?.({ mode: 'readwrite' })) === 'granted') return { files: await writeInto(dir, files) };
      io.exporter.download(files);
      return { files: files.map((f) => f.savedPath ?? f.name) };
    },
    between: () => io.freeMemory(),
  };
  queue = new JobQueue(runner, storage);
  queue.subscribe(() => {
    queueState.set((s) => ({ v: s.v + 1 }));
    const busy = queue!.get().running;
    if (queueUi.get().busy !== busy) queueUi.set((s) => ({ ...s, busy }));
  });
  void queue.restore();
  void restoreFolder();
  window.addEventListener('pagehide', () => void queue?.flush());
  return queue;
}

/* ------------------------------ adding jobs ------------------------------ */

export function addCurrent(app: AppCtx): QueueJob | null {
  const { ed, io } = app;
  const graph = ed.state.graph;
  const outputs = jobOutputs(graph, io.registry);
  if (!outputs.length) {
    ed.toast('This project has no output to render.', 'info');
    return null;
  }
  const proj = ed.state.projects.find((p) => p.id === ed.state.activeProject);
  return getQueue(app).add({ name: proj?.name || graph.name, source: { kind: 'current' }, graph, outputs });
}

/** Another open tab (its saved copy; the active tab's latest edits are written first). */
export async function addTab(app: AppCtx, projectId: string, name: string): Promise<QueueJob | null> {
  const { ed, io } = app;
  if (projectId === ed.state.activeProject) return addCurrent(app);
  await io.projects.flush();
  const graph = await io.projects.loadProject(projectId);
  if (!graph) {
    ed.toast(`Could not read "${name}".`, 'error');
    return null;
  }
  const outputs = jobOutputs(graph, io.registry);
  if (!outputs.length) {
    ed.toast(`"${name}" has no output to render.`, 'info');
    return null;
  }
  return getQueue(app).add({ name, source: { kind: 'tab', projectId }, graph, outputs });
}

/** A saved `.rsmps.json` file, without opening it as a tab. */
export async function addFile(app: AppCtx): Promise<QueueJob | null> {
  const { ed, io } = app;
  try {
    const graph = await io.projects.openFromFile();
    if (!graph) return null;
    const parsed = parseGraph(graph);
    const outputs = jobOutputs(parsed, io.registry);
    if (!outputs.length) {
      ed.toast(`"${parsed.name}" has no output to render.`, 'info');
      return null;
    }
    return getQueue(app).add({ name: parsed.name, source: { kind: 'file', fileName: parsed.name }, graph: parsed, outputs });
  } catch (err) {
    ed.toast(`Could not add the file: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return null;
  }
}
