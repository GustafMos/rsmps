import { describe, expect, it } from 'vitest';
import { createGraph } from '../engine/graph';
import { MAX_CLOSED, ProjectSession, type KV } from './session';

class FakeKV implements KV {
  data = new Map<string, unknown>();
  reads: string[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    this.reads.push(key);
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

function make(kv = new FakeKV()) {
  let n = 0;
  let t = 1000;
  const s = new ProjectSession(kv, () => ++t, () => `p${++n}`, () => 'blob:x', () => undefined);
  return { kv, s };
}
const g = (name: string) => createGraph(name);

describe('ProjectSession', () => {
  it('starts empty', async () => {
    const { s } = make();
    expect(await s.listOpen()).toEqual([]);
    expect(await s.activeId()).toBeNull();
  });

  it('migrates the old single autosave into the first project once', async () => {
    const kv = new FakeKV();
    kv.data.set('autosave', g('Old work'));
    const { s } = make(kv);
    const open = await s.listOpen();
    expect(open.map((p) => p.name)).toEqual(['Old work']);
    expect(await s.activeId()).toBe(open[0].id);
    expect((await s.loadProject(open[0].id))?.name).toBe('Old work');
    expect(kv.data.has('autosave')).toBe(false);
    // A second app start must not migrate again.
    const again = new ProjectSession(kv);
    expect((await again.listOpen()).length).toBe(1);
  });

  it('listing reads metadata only, never graph bodies', async () => {
    const { s, kv } = make();
    await s.createProject(g('A'));
    await s.createProject(g('B'));
    kv.reads.length = 0;
    await s.listOpen();
    expect(kv.reads.some((k) => k.startsWith('graph:'))).toBe(false);
    kv.reads.length = 0;
    await s.loadProject((await s.listOpen())[0].id);
    expect(kv.reads.filter((k) => k.startsWith('graph:'))).toHaveLength(1);
  });

  it('createProject activates the new tab; setActive ignores unknown ids', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    const b = await s.createProject(g('B'), 'Renamed');
    expect(b.name).toBe('Renamed');
    expect(await s.activeId()).toBe(b.id);
    await s.setActive(a.id);
    expect(await s.activeId()).toBe(a.id);
    await s.setActive('nope');
    expect(await s.activeId()).toBe(a.id);
  });

  it('saveProject rewrites only that project and updates name/time/dirty', async () => {
    const { s, kv } = make();
    const a = await s.createProject(g('A'));
    const b = await s.createProject(g('B'));
    const before = structuredClone(kv.data.get('graph:' + b.id));
    await s.saveProject(a.id, { ...g('A2'), nodes: [] });
    expect(kv.data.get('graph:' + b.id)).toEqual(before);
    const open = await s.listOpen();
    expect(open.find((p) => p.id === a.id)).toMatchObject({ name: 'A2', dirty: true });
    expect(open.find((p) => p.id === a.id)!.updatedAt).toBeGreaterThan(open.find((p) => p.id === b.id)!.updatedAt);
    await s.markSaved(a.id);
    expect((await s.listOpen()).find((p) => p.id === a.id)!.dirty).toBeUndefined();
  });

  it('close keeps the graph recoverable; reopen restores it as the last tab', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    const b = await s.createProject(g('B'));
    const c = await s.createProject(g('C'));
    expect(await s.closeProject(c.id)).toBe(b.id); // neighbour becomes active
    expect((await s.listOpen()).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(await s.loadProject(c.id)).toBeNull();
    expect((await s.listClosed()).map((p) => p.id)).toEqual([c.id]);
    const back = await s.reopen(c.id);
    expect(back?.id).toBe(c.id);
    expect((await s.listOpen()).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect((await s.loadProject(c.id))?.name).toBe('C');
    expect(await s.activeId()).toBe(c.id);
    expect(await s.closeProject(a.id)).toBe(c.id); // closing a background tab keeps the active one
  });

  it('closing the last tab leaves no active project', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    expect(await s.closeProject(a.id)).toBeNull();
    expect(await s.activeId()).toBeNull();
  });

  it('keeps only the last 10 closed projects and deletes older bodies', async () => {
    const { s, kv } = make();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CLOSED + 3; i++) ids.push((await s.createProject(g('P' + i))).id);
    for (const id of ids) await s.closeProject(id);
    const closed = await s.listClosed();
    expect(closed).toHaveLength(MAX_CLOSED);
    expect(closed[0].id).toBe(ids[ids.length - 1]); // most recent first
    expect(kv.data.has('graph:' + ids[0])).toBe(false);
    expect(kv.data.has('graph:' + ids[ids.length - 1])).toBe(true);
  });

  it('reorders, keeping forgotten ids at the end', async () => {
    const { s } = make();
    const [a, b, c] = [await s.createProject(g('A')), await s.createProject(g('B')), await s.createProject(g('C'))];
    await s.reorderOpen([c.id, a.id]);
    expect((await s.listOpen()).map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  it('duplicates right after the original with an independent body', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    await s.createProject(g('B'));
    const copy = await s.duplicateProject(a.id);
    expect(copy?.name).toBe('A copy');
    expect((await s.listOpen()).map((p) => p.name)).toEqual(['A', 'A copy', 'B']);
    await s.saveProject(copy!.id, { ...g('changed') });
    expect((await s.loadProject(a.id))?.name).toBe('A');
    expect(await s.duplicateProject('nope')).toBeNull();
  });

  it('rename updates the metadata and the stored graph name', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    await s.renameProject(a.id, '  New  ');
    expect((await s.listOpen())[0].name).toBe('New');
    expect((await s.loadProject(a.id))?.name).toBe('New');
    await s.renameProject(a.id, '   ');
    expect((await s.listOpen())[0].name).toBe('New');
  });

  it('thumbnails are exposed as URLs without touching graph bodies', async () => {
    const { s, kv } = make();
    const a = await s.createProject(g('A'));
    await s.saveProject(a.id, g('A'), new Blob(['x']));
    kv.reads.length = 0;
    expect((await s.listOpen())[0].thumbnail).toBe('blob:x');
    expect(kv.reads.some((k) => k.startsWith('graph:'))).toBe(false);
  });
});

describe('scan projects', () => {
  const fakeBlob = (tag: string) => ({ tag }) as unknown as Blob;
  const sessionOf = (n: number) => ({
    photos: Array.from({ length: n }, (_, i) => ({ name: `p${i}.jpg`, blob: fakeBlob('b' + i) })),
    manual: { 1: { fps: 12 } },
    options: { commit: { name: 'x' } },
    committedAssetId: 'a1',
    graph: g('scan graph'),
  });

  it('migrates old metadata: no kind means graph', async () => {
    const kv = new FakeKV();
    kv.data.set('session', { version: 1, open: [{ id: 'old', name: 'Old', updatedAt: 1 }], activeId: 'old', closed: [] });
    const { s } = make(kv);
    expect((await s.listOpen())[0].kind).toBe('graph');
  });

  it('creates a scan project, saves and loads a session round trip with its graph', async () => {
    const { s, kv } = make();
    const p = await s.createScanProject();
    expect(p).toMatchObject({ kind: 'scan', name: 'Scan' });
    expect(await s.loadScanSession(p.id)).toEqual({ photos: [], manual: {}, options: {}, graph: undefined });
    const a = sessionOf(2);
    await s.saveScanSession(p.id, a, new Blob(['t']));
    const back = await s.loadScanSession(p.id);
    expect(back!.photos.map((x) => x.name)).toEqual(['p0.jpg', 'p1.jpg']);
    expect(back!.photos[1].blob).toEqual(a.photos[1].blob);
    expect(back!.manual).toEqual({ 1: { fps: 12 } });
    expect(back!.committedAssetId).toBe('a1');
    expect(back!.graph?.name).toBe('scan graph');
    // The scan project's graph is also what loadProject returns; a graph project has no scan session.
    expect((await s.loadProject(p.id))?.name).toBe('scan graph');
    const gp = await s.createProject(g('G'));
    expect(await s.loadScanSession(gp.id)).toBeNull();
    expect(kv.data.has('scanphoto:' + p.id + ':1')).toBe(true);
  });

  it('only rewrites photos that changed and drops removed ones', async () => {
    const { s, kv } = make();
    const p = await s.createScanProject('S');
    const a = sessionOf(3);
    await s.saveScanSession(p.id, a);
    const puts: string[] = [];
    const orig = kv.put.bind(kv);
    kv.put = async (k, v) => (puts.push(k), orig(k, v));
    await s.saveScanSession(p.id, { ...a, manual: { 0: { fps: 9 } } });
    expect(puts.filter((k) => k.startsWith('scanphoto:'))).toEqual([]);
    await s.saveScanSession(p.id, { ...a, photos: a.photos.slice(0, 1) });
    expect(kv.data.has('scanphoto:' + p.id + ':2')).toBe(false);
    expect(kv.data.has('scanphoto:' + p.id + ':0')).toBe(true);
  });

  it('saveProject / rename / duplicate / reorder work for scan projects', async () => {
    const { s } = make();
    const a = await s.createProject(g('A'));
    const sc = await s.createScanProject('Sc');
    await s.saveProject(sc.id, g('edited'));
    expect((await s.loadProject(sc.id))?.name).toBe('edited');
    await s.saveScanSession(sc.id, sessionOf(1));
    const copy = await s.duplicateProject(sc.id);
    expect(copy).toMatchObject({ kind: 'scan', name: 'Sc copy' });
    expect((await s.loadScanSession(copy!.id))!.photos).toHaveLength(1);
    await s.renameProject(sc.id, 'Renamed');
    expect((await s.listOpen()).find((p) => p.id === sc.id)!.name).toBe('Renamed');
    await s.reorderOpen([sc.id, a.id]);
    expect((await s.listOpen()).map((p) => p.id).slice(0, 2)).toEqual([sc.id, a.id]);
  });

  it('close/reopen keeps the session; falling off the closed list purges photos and calls onPurge', async () => {
    const { s, kv } = make();
    const purged: string[] = [];
    s.onPurge = (id, kind) => purged.push(`${kind}:${id}`);
    const sc = await s.createScanProject();
    await s.saveScanSession(sc.id, sessionOf(2));
    await s.closeProject(sc.id);
    expect((await s.listClosed())[0]).toMatchObject({ id: sc.id, kind: 'scan' });
    expect(await s.reopen(sc.id)).toMatchObject({ kind: 'scan' });
    expect((await s.loadScanSession(sc.id))!.photos).toHaveLength(2);
    await s.closeProject(sc.id);
    for (let i = 0; i < MAX_CLOSED; i++) await s.closeProject((await s.createProject(g('x' + i))).id);
    expect(purged).toEqual([`scan:${sc.id}`]);
    expect(kv.data.has('scanphoto:' + sc.id + ':0')).toBe(false);
    expect(kv.data.has('scan:' + sc.id)).toBe(false);
  });
});
