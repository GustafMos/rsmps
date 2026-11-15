/**
 * The persistent session of open projects (tabs). Pure logic over a tiny key-value interface so it can be
 * tested without IndexedDB.
 *
 * Layout in the 'projects' store:
 *   'session'      one small record: ordered open list, active id, recently closed list (metadata only)
 *   'graph:<id>'   one graph body per project, read only when that project is opened
 *   'thumb:<id>'   optional small preview Blob
 *   'autosave'     legacy single-project autosave (migrated into the first project once)
 * Opening the app reads 'session' + the active graph; background tabs cost one metadata row.
 */
import type { GraphDoc } from '../engine/types';

export type ProjectKind = 'graph' | 'scan';

/** Stored form of a scan session (photos live under their own keys). */
export interface ScanSessionLike {
  photos: { name: string; blob: Blob }[];
  manual: Record<number, unknown>;
  options: Record<string, unknown>;
  committedAssetId?: string;
  graph?: GraphDoc;
}

export interface OpenProject {
  /** 'graph' (a node graph) or 'scan' (a print-and-scan session). Old stored projects are graphs. */
  kind: ProjectKind;
  id: string;
  name: string;
  /** ms since epoch of the last edit. */
  updatedAt: number;
  /** Small preview (object URL) of the last saved thumbnail. */
  thumbnail?: string;
  /** True when edited since the last `markSaved` (i.e. not written to a .rsmps.json file). */
  dirty?: boolean;
}

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Meta {
  kind?: ProjectKind;
  id: string;
  name: string;
  updatedAt: number;
  dirty?: boolean;
}

interface SessionRecord {
  version: 1;
  open: Meta[];
  activeId: string | null;
  closed: Meta[];
}

export const MAX_CLOSED = 10;
const GRAPH = (id: string) => `graph:${id}`;
const THUMB = (id: string) => `thumb:${id}`;
const SCAN = (id: string) => `scan:${id}`;
const SCAN_PHOTO = (id: string, i: number) => `scanphoto:${id}:${i}`;

interface ScanRecord {
  version: 1;
  photos: { name: string }[];
  manual: Record<number, unknown>;
  options: Record<string, unknown>;
  committedAssetId?: string;
}

export class ProjectSession {
  private rec: SessionRecord | null = null;
  private loading: Promise<SessionRecord> | null = null;
  private urls = new Map<string, { blob: Blob; url: string }>();
  /** Photo blobs last written/read per scan project, so unchanged photos are not rewritten. */
  private photoBlobs = new Map<string, Blob[]>();

  constructor(
    private kv: KV,
    private now: () => number = () => Date.now(),
    private newId: () => string = () => `proj_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`,
    private makeUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
    private revokeUrl: (u: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  /* ---------------------------------- load --------------------------------- */

  private load(): Promise<SessionRecord> {
    this.loading ??= (async () => {
      let rec = await this.kv.get<SessionRecord>('session');
      if (!rec || rec.version !== 1) {
        rec = { version: 1, open: [], activeId: null, closed: [] };
        const legacy = await this.kv.get<GraphDoc>('autosave');
        if (legacy && Array.isArray(legacy.nodes)) {
          // First run after the upgrade: the single autosave becomes the first project.
          const id = this.newId();
          await this.kv.put(GRAPH(id), legacy);
          rec.open.push({ id, name: legacy.name || 'Untitled', updatedAt: this.now() });
          rec.activeId = id;
          await this.kv.delete('autosave');
        }
        await this.kv.put('session', rec);
      }
      this.rec = rec;
      return rec;
    })();
    return this.loading;
  }

  private persist(): Promise<void> {
    return this.kv.put('session', this.rec);
  }

  private async thumbUrl(id: string): Promise<string | undefined> {
    const blob = await this.kv.get<Blob>(THUMB(id));
    if (!blob) return undefined;
    const have = this.urls.get(id);
    if (have && have.blob === blob) return have.url;
    if (have) this.revokeUrl(have.url);
    const url = this.makeUrl(blob);
    this.urls.set(id, { blob, url });
    return url;
  }

  private dropThumbUrl(id: string): void {
    const have = this.urls.get(id);
    if (have) this.revokeUrl(have.url);
    this.urls.delete(id);
  }

  private async toOpen(m: Meta): Promise<OpenProject> {
    return { kind: m.kind ?? 'graph', id: m.id, name: m.name, updatedAt: m.updatedAt, thumbnail: await this.thumbUrl(m.id), dirty: m.dirty || undefined };
  }

  /* --------------------------------- queries ------------------------------- */

  /** Metadata only: never reads a graph body. */
  async listOpen(): Promise<OpenProject[]> {
    const rec = await this.load();
    return Promise.all(rec.open.map((m) => this.toOpen(m)));
  }

  async listClosed(): Promise<OpenProject[]> {
    const rec = await this.load();
    return Promise.all(rec.closed.map((m) => this.toOpen(m)));
  }

  async activeId(): Promise<string | null> {
    return (await this.load()).activeId;
  }

  async setActive(id: string): Promise<void> {
    const rec = await this.load();
    if (!rec.open.some((m) => m.id === id)) return;
    rec.activeId = id;
    await this.persist();
  }

  /** Reads exactly one graph body. */
  async loadProject(id: string): Promise<GraphDoc | null> {
    const rec = await this.load();
    if (!rec.open.some((m) => m.id === id)) return null;
    // A scan project's graph is the one that processes its recovered frames (null until it has one).
    return (await this.kv.get<GraphDoc>(GRAPH(id))) ?? null;
  }

  /* --------------------------------- changes ------------------------------- */

  /** Write one project's body and update its metadata row. Other projects are not touched. */
  async saveProject(id: string, graph: GraphDoc, thumbnail?: Blob): Promise<void> {
    const rec = await this.load();
    const meta = rec.open.find((m) => m.id === id);
    if (!meta) return;
    await this.kv.put(GRAPH(id), graph);
    if (thumbnail) {
      await this.kv.put(THUMB(id), thumbnail);
    }
    if ((meta.kind ?? 'graph') === 'graph') meta.name = graph.name || meta.name; // a scan tab keeps its own name
    meta.updatedAt = this.now();
    meta.dirty = true;
    await this.persist();
  }

  async markSaved(id: string): Promise<void> {
    const meta = (await this.load()).open.find((m) => m.id === id);
    if (!meta || !meta.dirty) return;
    meta.dirty = false;
    await this.persist();
  }

  /** Add a project (becomes active). `name` overrides the graph's name. */
  async createProject(graph: GraphDoc, name?: string): Promise<OpenProject> {
    const rec = await this.load();
    const id = this.newId();
    const doc = name ? { ...graph, name } : graph;
    await this.kv.put(GRAPH(id), doc);
    const meta: Meta = { id, name: doc.name || 'Untitled', updatedAt: this.now() };
    rec.open.push(meta);
    rec.activeId = id;
    await this.persist();
    return this.toOpen(meta);
  }

  /* ------------------------------------ scan projects --------------------------------- */

  async createScanProject(name?: string): Promise<OpenProject> {
    const rec = await this.load();
    const id = this.newId();
    const meta: Meta = { kind: 'scan', id, name: name?.trim() || 'Scan', updatedAt: this.now() };
    rec.open.push(meta);
    rec.activeId = id;
    await this.persist();
    return this.toOpen(meta);
  }

  /** Write a scan session. Photo blobs are only rewritten when the list of photos changed. */
  async saveScanSession(id: string, session: ScanSessionLike, thumbnail?: Blob): Promise<void> {
    const rec = await this.load();
    const meta = rec.open.find((m) => m.id === id);
    if (!meta || meta.kind !== 'scan') return;
    const written = this.photoBlobs.get(id) ?? [];
    for (let i = 0; i < session.photos.length; i++) {
      if (written[i] !== session.photos[i].blob) await this.kv.put(SCAN_PHOTO(id, i), session.photos[i].blob);
    }
    for (let i = session.photos.length; i < written.length; i++) await this.kv.delete(SCAN_PHOTO(id, i));
    this.photoBlobs.set(id, session.photos.map((p) => p.blob));
    const record: ScanRecord = {
      version: 1,
      photos: session.photos.map((p) => ({ name: p.name })),
      manual: session.manual,
      options: session.options,
      committedAssetId: session.committedAssetId,
    };
    await this.kv.put(SCAN(id), record);
    if (session.graph) await this.kv.put(GRAPH(id), session.graph);
    if (thumbnail) await this.kv.put(THUMB(id), thumbnail);
    meta.updatedAt = this.now();
    meta.dirty = true;
    await this.persist();
  }

  /** The stored session of a scan project (empty when nothing was saved yet), or null for other projects. */
  async loadScanSession(id: string): Promise<ScanSessionLike | null> {
    const rec = await this.load();
    const meta = rec.open.find((m) => m.id === id);
    if (!meta || meta.kind !== 'scan') return null;
    const stored = await this.kv.get<ScanRecord>(SCAN(id));
    if (!stored) return { photos: [], manual: {}, options: {}, graph: (await this.kv.get<GraphDoc>(GRAPH(id))) ?? undefined };
    const photos: ScanSessionLike['photos'] = [];
    for (let i = 0; i < stored.photos.length; i++) {
      const blob = await this.kv.get<Blob>(SCAN_PHOTO(id, i));
      if (blob) photos.push({ name: stored.photos[i].name, blob });
    }
    this.photoBlobs.set(id, photos.map((p) => p.blob));
    const graph = (await this.kv.get<GraphDoc>(GRAPH(id))) ?? undefined;
    return { photos, manual: stored.manual ?? {}, options: stored.options ?? {}, committedAssetId: stored.committedAssetId, graph };
  }

  /** Called when a project is dropped for good (falls off the recently-closed list). */
  onPurge: ((id: string, kind: ProjectKind) => void) | null = null;

  private async deleteBodies(meta: Meta): Promise<void> {
    this.onPurge?.(meta.id, meta.kind ?? 'graph');
    await this.kv.delete(GRAPH(meta.id));
    await this.kv.delete(THUMB(meta.id));
    if (meta.kind === 'scan') {
      const stored = await this.kv.get<ScanRecord>(SCAN(meta.id));
      for (let i = 0; i < (stored?.photos.length ?? 0); i++) await this.kv.delete(SCAN_PHOTO(meta.id, i));
      await this.kv.delete(SCAN(meta.id));
      this.photoBlobs.delete(meta.id);
    }
    this.dropThumbUrl(meta.id);
  }

  async renameProject(id: string, name: string): Promise<void> {
    const rec = await this.load();
    const meta = rec.open.find((m) => m.id === id);
    const clean = name.trim();
    if (!meta || !clean) return;
    meta.name = clean;
    meta.updatedAt = this.now();
    if ((meta.kind ?? 'graph') === 'graph') {
      const body = await this.kv.get<GraphDoc>(GRAPH(id));
      if (body) await this.kv.put(GRAPH(id), { ...body, name: clean });
    }
    await this.persist();
  }

  async reorderOpen(ids: string[]): Promise<void> {
    const rec = await this.load();
    const byId = new Map(rec.open.map((m) => [m.id, m]));
    const next: Meta[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m) {
        next.push(m);
        byId.delete(id);
      }
    }
    next.push(...byId.values()); // ids the caller forgot keep their relative order at the end
    rec.open = next;
    await this.persist();
  }

  async duplicateProject(id: string): Promise<OpenProject | null> {
    const rec = await this.load();
    const src = rec.open.find((m) => m.id === id);
    if (src?.kind === 'scan') return this.duplicateScan(rec, src);
    const body = src ? await this.kv.get<GraphDoc>(GRAPH(id)) : undefined;
    if (!src || !body) return null;
    const copyId = this.newId();
    const name = `${src.name} copy`;
    await this.kv.put(GRAPH(copyId), { ...structuredClone(body), name });
    const thumb = await this.kv.get<Blob>(THUMB(id));
    if (thumb) await this.kv.put(THUMB(copyId), thumb);
    const meta: Meta = { id: copyId, name, updatedAt: this.now() };
    rec.open.splice(rec.open.indexOf(src) + 1, 0, meta);
    await this.persist();
    return this.toOpen(meta);
  }

  private async duplicateScan(rec: SessionRecord, src: Meta): Promise<OpenProject> {
    const copyId = this.newId();
    const name = `${src.name} copy`;
    const stored = await this.kv.get<ScanRecord>(SCAN(src.id));
    if (stored) {
      for (let i = 0; i < stored.photos.length; i++) {
        const blob = await this.kv.get<Blob>(SCAN_PHOTO(src.id, i));
        if (blob) await this.kv.put(SCAN_PHOTO(copyId, i), blob);
      }
      await this.kv.put(SCAN(copyId), structuredClone({ ...stored, committedAssetId: undefined }));
    }
    const graph = await this.kv.get<GraphDoc>(GRAPH(src.id));
    if (graph) await this.kv.put(GRAPH(copyId), { ...structuredClone(graph), name });
    const thumb = await this.kv.get<Blob>(THUMB(src.id));
    if (thumb) await this.kv.put(THUMB(copyId), thumb);
    const meta: Meta = { kind: 'scan', id: copyId, name, updatedAt: this.now() };
    rec.open.splice(rec.open.indexOf(src) + 1, 0, meta);
    await this.persist();
    return this.toOpen(meta);
  }

  /**
   * Remove from the session. The graph stays recoverable in the last MAX_CLOSED closed projects.
   * Returns the id that should become active (neighbour) when the closed one was active, else the unchanged active id.
   */
  async closeProject(id: string): Promise<string | null> {
    const rec = await this.load();
    const at = rec.open.findIndex((m) => m.id === id);
    if (at < 0) return rec.activeId;
    const [meta] = rec.open.splice(at, 1);
    rec.closed.unshift(meta);
    while (rec.closed.length > MAX_CLOSED) {
      const old = rec.closed.pop()!;
      await this.deleteBodies(old);
    }
    if (rec.activeId === id) rec.activeId = (rec.open[at] ?? rec.open[at - 1])?.id ?? null;
    await this.persist();
    return rec.activeId;
  }

  /** Bring a recently closed project back as the last tab (and make it active). */
  async reopen(id: string): Promise<OpenProject | null> {
    const rec = await this.load();
    const at = rec.closed.findIndex((m) => m.id === id);
    if (at < 0) return null;
    const [meta] = rec.closed.splice(at, 1);
    rec.open.push(meta);
    rec.activeId = meta.id;
    await this.persist();
    return this.toOpen(meta);
  }
}
