/**
 * Model store: downloads an optional AI model ONLY when the user asks, checks it, and keeps it on this computer.
 * The same code runs in the browser and in the desktop app (both have fetch, SubtleCrypto and IndexedDB).
 *
 *  - `download(id)` fetches the pinned file (src/io/model-catalogue.ts) with progress, retries a broken connection a few times
 *    (continuing with a Range request where the server allows it), checks the size and the SHA-256 of the WHOLE file, and only then
 *    stores it. A file that does not match is refused and nothing is stored.
 *  - Nothing downloads by itself: no node, no process and no page load calls `download`.
 *  - Storage is IndexedDB (a Blob record: Chromium keeps big blobs on disk, so a 50 MB model costs no RAM while idle). A memory backend
 *    serves the tests.
 */
import { MODEL_CATALOGUE, modelEntry, type ModelEntry } from './model-catalogue';

export type ModelStatus =
  | { state: 'absent' }
  | { state: 'downloading'; received: number; total: number; phase: 'downloading' | 'verifying' }
  | { state: 'ready'; bytes: number }
  | { state: 'failed'; error: string };

export interface ModelBackend {
  /** Stored size in bytes, or null when absent. */
  size(id: string): Promise<number | null>;
  get(id: string): Promise<Blob | null>;
  put(id: string, data: Blob): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ModelStoreDeps {
  fetch: typeof fetch;
  backend: ModelBackend;
  /** SHA-256 of the bytes as lower-case hex. Default: SubtleCrypto. */
  sha256?: (data: Uint8Array) => Promise<string>;
  catalogue?: readonly ModelEntry[];
  /** Tries after the first one when the connection breaks half way. */
  retries?: number;
  /** Wait between tries (ms). Tests pass 0. */
  retryDelayMs?: number;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  let s = '';
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, '0');
  return s;
}

/** A plain network error as a sentence for the panel. */
export function describeNetworkError(e: unknown, host: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === 'AbortError') return 'The download was canceled.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return `Could not reach ${host}. Check your internet connection and try again.`;
  return msg;
}

export class ModelStore {
  private readonly deps: Required<Omit<ModelStoreDeps, 'catalogue'>> & { catalogue: readonly ModelEntry[] };
  private readonly state = new Map<string, ModelStatus>();
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change so React can use it as a snapshot. */
  version = 0;

  constructor(deps: ModelStoreDeps) {
    this.deps = { sha256: sha256Hex, catalogue: MODEL_CATALOGUE, retries: 3, retryDelayMs: 1500, ...deps };
  }

  private entry(id: string): ModelEntry {
    const e = this.deps.catalogue.find((m) => m.id === id) ?? modelEntry(id);
    if (!e) throw new Error(`Unknown model "${id}".`);
    return e;
  }

  private set(id: string, s: ModelStatus): void {
    this.state.set(id, s);
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What is known right now (synchronous). Call `refresh` once at start to learn what is already stored. */
  status(id: string): ModelStatus {
    return this.state.get(id) ?? { state: 'absent' };
  }

  /** Looks in the storage. A stored file of the wrong size (a half-written one) counts as absent and is removed. */
  async refresh(id: string): Promise<ModelStatus> {
    if (this.running.has(id)) return this.status(id);
    const e = this.entry(id);
    try {
      const size = await this.deps.backend.size(id);
      if (size === e.bytes) this.set(id, { state: 'ready', bytes: size });
      else {
        if (size !== null) await this.deps.backend.delete(id);
        if (this.status(id).state !== 'failed') this.set(id, { state: 'absent' });
      }
    } catch (err) {
      this.set(id, { state: 'failed', error: `The model storage of this browser is not available: ${err instanceof Error ? err.message : String(err)}` });
    }
    return this.status(id);
  }

  /** Stored size in bytes, or null. */
  async bytes(id: string): Promise<number | null> {
    return this.deps.backend.size(id);
  }

  /** The stored file, for the inference runtime. Null when it is not downloaded. */
  async read(id: string): Promise<Uint8Array | null> {
    const blob = await this.deps.backend.get(id);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async remove(id: string): Promise<void> {
    this.running.get(id)?.abort();
    await this.deps.backend.delete(id);
    this.set(id, { state: 'absent' });
  }

  cancel(id: string): void {
    this.running.get(id)?.abort();
  }

  /** Download, check, store. Only ever called from a button the user pressed. Resolves with the final status (never throws). */
  async download(id: string): Promise<ModelStatus> {
    const e = this.entry(id);
    if (this.running.has(id)) return this.status(id);
    const ctl = new AbortController();
    this.running.set(id, ctl);
    this.set(id, { state: 'downloading', received: 0, total: e.bytes, phase: 'downloading' });
    try {
      const data = await this.fetchAll(e, ctl.signal);
      this.set(id, { state: 'downloading', received: e.bytes, total: e.bytes, phase: 'verifying' });
      if (data.length !== e.bytes) throw new Error(`The file has the wrong size (${data.length} bytes, expected ${e.bytes}). Nothing was stored.`);
      const hash = await this.deps.sha256(data);
      if (hash !== e.sha256) throw new Error('The downloaded file does not match its checksum, so it was not stored. Try again later.');
      if (ctl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await this.deps.backend.put(id, new Blob([data as unknown as ArrayBuffer], { type: 'application/octet-stream' }));
      this.set(id, { state: 'ready', bytes: data.length });
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === 'AbortError';
      this.set(id, cancelled ? { state: 'absent' } : { state: 'failed', error: describeNetworkError(err, e.host) });
    } finally {
      this.running.delete(id);
    }
    return this.status(id);
  }

  private async fetchAll(e: ModelEntry, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let attempt = 0;
    for (;;) {
      try {
        const headers: Record<string, string> = {};
        if (received > 0) headers.Range = `bytes=${received}-`;
        const res = await this.deps.fetch(e.url, { signal, headers, redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (received > 0 && res.status !== 206) {
          // the server ignored the Range request: start again from zero
          chunks.length = 0;
          received = 0;
        }
        if (!res.ok) throw new Error(`${e.host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
        if (!res.body) {
          const all = new Uint8Array(await res.arrayBuffer());
          chunks.push(all);
          received += all.length;
        } else {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            this.set(e.id, { state: 'downloading', received: Math.min(received, e.bytes), total: e.bytes, phase: 'downloading' });
            if (received > e.bytes) throw new Error('The server sent more data than expected. Nothing was stored.');
          }
        }
        if (received >= e.bytes) break;
        throw new Error(`The connection ended after ${received} of ${e.bytes} bytes.`);
      } catch (err) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (err instanceof Error && /more data than expected/.test(err.message)) throw err;
        if (attempt >= this.deps.retries) throw err;
        attempt++;
        if (this.deps.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.deps.retryDelayMs * attempt));
      }
    }
    const out = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Storage backends                                                                                                   */
/* ----------------------------------------------------------------------------------------------------------------- */

export class MemoryModelBackend implements ModelBackend {
  readonly files = new Map<string, Blob>();
  async size(id: string) {
    return this.files.get(id)?.size ?? null;
  }
  async get(id: string) {
    return this.files.get(id) ?? null;
  }
  async put(id: string, data: Blob) {
    this.files.set(id, data);
  }
  async delete(id: string) {
    this.files.delete(id);
  }
}

const DB_NAME = 'rsmps-models';
const STORE = 'files';

/** IndexedDB, one record per model. The record is written in one transaction, so a failed write leaves nothing behind. */
export class IdbModelBackend implements ModelBackend {
  private dbp: Promise<IDBDatabase> | null = null;
  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    });
    return this.dbp;
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error('The model could not be stored (is the disk full?)'));
    });
  }
  async size(id: string) {
    const v = await this.tx<Blob | undefined>('readonly', (s) => s.get(id));
    return v ? v.size : null;
  }
  async get(id: string) {
    return (await this.tx<Blob | undefined>('readonly', (s) => s.get(id))) ?? null;
  }
  async put(id: string, data: Blob) {
    await this.tx('readwrite', (s) => s.put(data, id));
  }
  async delete(id: string) {
    await this.tx('readwrite', (s) => s.delete(id));
  }
}

let shared: ModelStore | null = null;

/** The app-wide store (browser and desktop). Created on first use; nothing is fetched by creating it. */
export function modelStore(): ModelStore {
  shared ??= new ModelStore({ fetch: (...a) => fetch(...a), backend: new IdbModelBackend() });
  return shared;
}
