/**
 * ProjectStore: autosave, `.rsmps.json` files and presets.
 * Presets are graphs without media (asset lists are emptied on save). Built-in presets are the JSON
 * files in src/io/presets (none is fine).
 */
import type { Registry } from '../engine/define';
import { validateGraph } from '../engine/graph';
import { DEFAULT_PROJECT, type GraphDoc } from '../engine/types';
import type { ProjectStore } from './api';
import type { ScanSession } from './api';
import { ProjectSession, type OpenProject } from './session';
import { idbAll, idbDelete, idbGet, idbPut } from './db';
import { errorMessage, uniqueId } from './util';

const AUTOSAVE_DELAY_MS = 400;
const FILE_TYPES = [{ description: 'RSMPS project', accept: { 'application/json': ['.rsmps.json', '.json'] } }];

interface StoredPreset {
  id: string;
  name: string;
  graph: GraphDoc;
  thumbnail?: Blob;
  created: number;
}

const builtinModules = import.meta.glob('./presets/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

/** Normalise and sanity-check a parsed document. Throws a readable error when it is not an RSMPS v2 graph. */
export function parseGraph(raw: unknown): GraphDoc {
  if (!raw || typeof raw !== 'object') throw new Error('This file is not an RSMPS project.');
  const doc = raw as Partial<GraphDoc>;
  if (doc.schema !== 'rsmps/graph') throw new Error('This file is not an RSMPS project (missing "rsmps/graph" schema).');
  if (doc.version !== 2) throw new Error(`Unsupported project version ${String(doc.version)}; this app reads version 2.`);
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('The project file is damaged (nodes or wires missing).');
  return {
    schema: 'rsmps/graph',
    version: 2,
    name: typeof doc.name === 'string' ? doc.name : 'Untitled',
    project: { ...DEFAULT_PROJECT, ...(doc.project ?? {}) },
    nodes: doc.nodes,
    edges: doc.edges,
    frames: Array.isArray(doc.frames) ? doc.frames : [],
  };
}

export class ProjectStoreImpl implements ProjectStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private session = new ProjectSession({
    get: (k) => idbGet('projects', k),
    put: (k, v) => idbPut('projects', k, v),
    delete: (k) => idbDelete('projects', k),
  });
  private thumbUrls = new Map<string, string>();
  /** Problems found in the last opened file (unknown node types, bad wires). The nodes are kept. */
  lastOpenProblems: { nodeId?: string; message: string }[] = [];

  /** Called when a project is dropped for good (see ProjectSession.onPurge). */
  set onPurge(fn: ((id: string, kind: "graph" | "scan") => void) | null) {
    this.session.onPurge = fn;
  }

  constructor(private registry: Registry) {
    if (typeof window !== 'undefined') {
      const flush = () => void this.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  /* ------------------------- session (open projects) ------------------------- */

  private pending = new Map<string, { graph: GraphDoc; thumbnail?: Blob }>();
  /** Pending autosave of "whatever project is active" (legacy API); resolved at flush time. */
  private pendingActive: GraphDoc | null = null;

  listOpen(): Promise<OpenProject[]> {
    return this.session.listOpen();
  }
  listClosed(): Promise<OpenProject[]> {
    return this.session.listClosed();
  }
  activeId(): Promise<string | null> {
    return this.session.activeId();
  }
  setActive(id: string): Promise<void> {
    return this.session.setActive(id);
  }
  loadProject(id: string): Promise<GraphDoc | null> {
    return this.session.loadProject(id).then((g) => (g ? parseGraph(g) : null));
  }
  markSaved(id: string): Promise<void> {
    return this.session.markSaved(id);
  }
  async createProject(graph: GraphDoc, name?: string): Promise<OpenProject> {
    await this.flush();
    return this.session.createProject(graph, name);
  }
  async closeProject(id: string): Promise<string | null> {
    await this.flush(); // keep the latest edits in the recently-closed copy
    return this.session.closeProject(id);
  }
  reopen(id: string): Promise<OpenProject | null> {
    return this.session.reopen(id);
  }
  async renameProject(id: string, name: string): Promise<void> {
    await this.flush();
    await this.session.renameProject(id, name);
  }
  reorderOpen(ids: string[]): Promise<void> {
    return this.session.reorderOpen(ids);
  }
  async duplicateProject(id: string): Promise<OpenProject | null> {
    await this.flush();
    return this.session.duplicateProject(id);
  }

  async createScanProject(name?: string): Promise<OpenProject> {
    await this.flush();
    return this.session.createScanProject(name);
  }
  loadScanSession(id: string): Promise<ScanSession | null> {
    return this.session.loadScanSession(id) as Promise<ScanSession | null>;
  }
  /** Debounced like saveProject. The thumbnail is the first photo, downscaled (made once per first photo). */
  saveScanSession(id: string, session: ScanSession): void {
    this.pendingScan.set(id, session);
    this.schedule();
  }
  private pendingScan = new Map<string, ScanSession>();
  private thumbOf = new Map<string, Blob>();

  /** Debounced (~400 ms). Updates the project's body, name, time and thumbnail only. */
  saveProject(id: string, graph: GraphDoc, thumbnail?: Blob): void {
    const prev = this.pending.get(id);
    this.pending.set(id, { graph, thumbnail: thumbnail ?? prev?.thumbnail });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS);
  }

  /** Write every pending save now. Await it before switching projects. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const jobs = [...this.pending];
    this.pending.clear();
    const scans = [...this.pendingScan];
    this.pendingScan.clear();
    const legacy = this.pendingActive;
    this.pendingActive = null;
    this.writing = this.writing.then(async () => {
      try {
        for (const [id, p] of jobs) await this.session.saveProject(id, p.graph, p.thumbnail);
        for (const [id, s] of scans) {
          const first = s.photos[0]?.blob;
          let thumb: Blob | undefined;
          if (first && this.thumbOf.get(id) !== first) {
            thumb = (await photoThumbnail(first)) ?? undefined;
            this.thumbOf.set(id, first);
          }
          await this.session.saveScanSession(id, s, thumb);
        }
        if (legacy) {
          const id = await this.session.activeId();
          if (id) await this.session.saveProject(id, legacy);
          else await this.session.createProject(legacy);
        }
      } catch (err) {
        console.warn('Autosave failed:', errorMessage(err));
      }
    });
    return this.writing;
  }

  /* -------------------------------- autosave (legacy wrappers) ------------------- */

  async loadAutosave(): Promise<GraphDoc | null> {
    try {
      const id = await this.session.activeId();
      return id ? await this.loadProject(id) : null;
    } catch (err) {
      console.warn('Could not load the autosave:', err);
      return null;
    }
  }

  /** Saves into the active project (creating one if the session is empty). */
  autosave(graph: GraphDoc): void {
    this.pendingActive = graph;
    this.schedule();
  }

  /* ---------------------------------- files --------------------------------- */

  async saveToFile(graph: GraphDoc): Promise<void> {
    const text = JSON.stringify(graph, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const suggested = `${safeName(graph.name)}.rsmps.json`;
    const w = window as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
    };
    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return; // user cancelled
        console.warn('File System Access save failed, falling back to a download:', err);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggested;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async openFromFile(): Promise<GraphDoc | null> {
    const w = window as unknown as {
      showOpenFilePicker?: (o: unknown) => Promise<{ getFile(): Promise<File> }[]>;
    };
    let file: File | null = null;
    if (typeof w.showOpenFilePicker === 'function') {
      try {
        const [handle] = await w.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
        file = await handle.getFile();
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return null;
        console.warn('File System Access open failed, falling back to a file input:', err);
        file = await pickWithInput();
      }
    } else file = await pickWithInput();
    if (!file) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error(`"${file.name}" is not valid JSON.`);
    }
    const graph = parseGraph(parsed);
    this.lastOpenProblems = validateGraph(graph, this.registry);
    if (this.lastOpenProblems.length) {
      // Unknown node types stay in the graph (a plugin may be missing); the player reports them per node.
      console.warn(`"${file.name}" opened with ${this.lastOpenProblems.length} problem(s):`, this.lastOpenProblems);
    }
    return graph;
  }

  /* --------------------------------- presets -------------------------------- */

  private builtins(): { id: string; name: string; graph: GraphDoc }[] {
    const out: { id: string; name: string; graph: GraphDoc }[] = [];
    for (const [path, raw] of Object.entries(builtinModules).sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const graph = parseGraph(raw);
        const stem = path.replace(/^.*\//, '').replace(/\.json$/, '');
        out.push({ id: `builtin:${stem}`, name: graph.name && graph.name !== 'Untitled' ? graph.name : stem.replace(/[-_]+/g, ' '), graph });
      } catch (err) {
        console.warn(`Built-in preset ${path} is invalid:`, errorMessage(err));
      }
    }
    return out;
  }

  async listPresets(): Promise<{ id: string; name: string; builtin: boolean; thumbnail?: string }[]> {
    const list: { id: string; name: string; builtin: boolean; thumbnail?: string }[] = this.builtins().map((b) => ({ id: b.id, name: b.name, builtin: true }));
    try {
      const stored = await idbAll<StoredPreset>('presets');
      stored.sort((a, b) => a.created - b.created);
      for (const p of stored) list.push({ id: p.id, name: p.name, builtin: false, thumbnail: this.thumbUrl(p) });
    } catch (err) {
      console.warn('Could not list presets:', err);
    }
    return list;
  }

  private thumbUrl(p: StoredPreset): string | undefined {
    if (!p.thumbnail) return undefined;
    let url = this.thumbUrls.get(p.id);
    if (!url) {
      url = URL.createObjectURL(p.thumbnail);
      this.thumbUrls.set(p.id, url);
    }
    return url;
  }

  async loadPreset(id: string): Promise<GraphDoc | null> {
    if (id.startsWith('builtin:')) {
      const b = this.builtins().find((x) => x.id === id);
      return b ? structuredClone(b.graph) : null;
    }
    const p = await idbGet<StoredPreset>('presets', id);
    return p ? parseGraph(structuredClone(p.graph)) : null;
  }

  async savePreset(name: string, graph: GraphDoc, thumbnail?: Blob): Promise<void> {
    const id = uniqueId('preset');
    const record: StoredPreset = { id, name: name.trim() || 'Preset', graph: this.stripMedia(graph, name), thumbnail, created: Date.now() };
    await idbPut('presets', id, record);
  }

  async deletePreset(id: string): Promise<void> {
    if (id.startsWith('builtin:')) return;
    const url = this.thumbUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.thumbUrls.delete(id);
    await idbDelete('presets', id);
  }

  /** Presets carry no media: every `assets` param is emptied (asset ids mean nothing in another session). */
  private stripMedia(graph: GraphDoc, name: string): GraphDoc {
    const copy = structuredClone(graph);
    copy.name = name.trim() || copy.name;
    for (const n of copy.nodes) {
      const def = this.registry.get(n.type);
      if (!def) continue;
      for (const [key, p] of Object.entries(def.params)) {
        if ((p as { type: string }).type === 'assets') n.params[key] = [];
      }
    }
    return copy;
  }
}

/** First photo, shrunk to a small WebP for the tab. */
async function photoThumbnail(blob: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  } catch {
    return null;
  }
}

function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return (name || 'project').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'project';
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.rsmps.json,application/json';
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
