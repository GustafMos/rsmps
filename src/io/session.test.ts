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
