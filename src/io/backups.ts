/**
 * Rolling project backups: the last few GOOD autosaves (snapshots that rendered a frame) per project.
 * The ring maths is pure (`pushBackup`, `shouldSnapshot`); `BackupStore` puts it on a tiny key-value interface.
 */
import type { GraphDoc } from '../engine/types';

export const MAX_BACKUPS = 10;
/** Per project. A project that is huge on its own still keeps its newest backup. */
export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
/** Minimum time between two snapshots of a project. */
export const MIN_BACKUP_GAP_MS = 30_000;

export interface BackupEntry {
  id: string;
  /** ms since epoch. */
  at: number;
  name: string;
  nodes: number;
  /** Size of the serialised graph. */
  bytes: number;
  /** Cheap content signature, to skip identical snapshots. */
  sig: string;
  graph: GraphDoc;
}

export type BackupInfo = Omit<BackupEntry, 'graph'>;

/** Length plus a 32-bit FNV-1a of the JSON text. */
export function signature(json: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${json.length}:${(h >>> 0).toString(16)}`;
}

export function makeEntry(graph: GraphDoc, at: number, id: string): BackupEntry {
  const json = JSON.stringify(graph);
  return { id, at, name: graph.name || 'Untitled', nodes: graph.nodes.length, bytes: json.length, sig: signature(json), graph };
}

/**
 * Add `entry` (newest first). Identical to the newest one: the list is returned unchanged. Then the oldest entries go until at most
 * `max` remain and the total is within `maxBytes` (the newest entry is never dropped).
 */
export function pushBackup(list: readonly BackupEntry[], entry: BackupEntry, opts: { max?: number; maxBytes?: number } = {}): BackupEntry[] {
  const max = Math.max(1, opts.max ?? MAX_BACKUPS);
  const maxBytes = opts.maxBytes ?? MAX_BACKUP_BYTES;
  if (list[0] && list[0].sig === entry.sig) return [...list];
  const out = [entry, ...list].slice(0, max);
  let total = out.reduce((n, e) => n + e.bytes, 0);
  while (out.length > 1 && total > maxBytes) total -= out.pop()!.bytes;
  return out;
}

/** True when enough time has passed since the last snapshot (or there is none). */
export function shouldSnapshot(lastAt: number | null, now: number, gapMs: number = MIN_BACKUP_GAP_MS): boolean {
  return lastAt === null || now - lastAt >= gapMs;
}

export interface KVLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY = (project: string) => `backups:${project}`;

export class BackupStore {
  /** Called after each stored snapshot (the desktop app mirrors it to a file). */
  onStored: ((project: string, entry: BackupEntry) => void) | null = null;

  constructor(
    private kv: KVLike,
    private now: () => number = () => Date.now(),
    private newId: () => string = () => `b${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
    private limits: { max?: number; maxBytes?: number } = {},
  ) {}

  private async read(project: string): Promise<BackupEntry[]> {
    try {
      const v = await this.kv.get<BackupEntry[]>(KEY(project));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  /** Store a snapshot. Returns false when it was identical to the newest one. */
  async record(project: string, graph: GraphDoc): Promise<boolean> {
    const list = await this.read(project);
    const entry = makeEntry(graph, this.now(), this.newId());
    const next = pushBackup(list, entry, this.limits);
    if (next[0] !== entry) return false;
    await this.kv.put(KEY(project), next);
    this.onStored?.(project, entry);
    return true;
  }

  async list(project: string): Promise<BackupInfo[]> {
    return (await this.read(project)).map((e) => ({ id: e.id, at: e.at, name: e.name, nodes: e.nodes, bytes: e.bytes, sig: e.sig }));
  }

  async get(project: string, id: string): Promise<GraphDoc | null> {
    return (await this.read(project)).find((e) => e.id === id)?.graph ?? null;
  }

  async drop(project: string): Promise<void> {
    await this.kv.delete(KEY(project));
  }
}
