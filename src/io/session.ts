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

export interface OpenProject {
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

export class ProjectSession {
  private rec: SessionRecord | null = null;
  private loading: Promise<SessionRecord> | null = null;
  private urls = new Map<string, { blob: Blob; url: string }>();

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
    return { id: m.id, name: m.name, updatedAt: m.updatedAt, thumbnail: await this.thumbUrl(m.id), dirty: m.dirty || undefined };
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
    meta.name = graph.name || meta.name;
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

  async renameProject(id: string, name: string): Promise<void> {
    const rec = await this.load();
    const meta = rec.open.find((m) => m.id === id);
    const clean = name.trim();
    if (!meta || !clean) return;
    meta.name = clean;
    meta.updatedAt = this.now();
    const body = await this.kv.get<GraphDoc>(GRAPH(id));
    if (body) await this.kv.put(GRAPH(id), { ...body, name: clean });
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
      await this.kv.delete(GRAPH(old.id));
      await this.kv.delete(THUMB(old.id));
      this.dropThumbUrl(old.id);
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
