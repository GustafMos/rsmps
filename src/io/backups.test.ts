import { describe, expect, it } from 'vitest';
import { createGraph } from '../engine/graph';
import { BackupStore, MAX_BACKUPS, makeEntry, pushBackup, shouldSnapshot, signature, type KVLike } from './backups';

const graph = (name: string, extra = 0) => {
  const g = createGraph(name);
  return { ...g, nodes: Array.from({ length: extra }, (_, i) => ({ id: `n${i}`, type: 'x', x: 0, y: 0, params: { pad: 'x'.repeat(100) } })) } as typeof g;
};

function kv(): KVLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => structuredClone(data.get(k)) as never, put: async (k, v) => void data.set(k, structuredClone(v)), delete: async (k) => void data.delete(k) };
}

describe('backup ring (pure)', () => {
  it('keeps newest first and at most `max`', () => {
    let list = [] as ReturnType<typeof makeEntry>[];
    for (let i = 0; i < 15; i++) list = pushBackup(list, makeEntry(graph(`g${i}`), i, `b${i}`));
    expect(list).toHaveLength(MAX_BACKUPS);
    expect(list[0].id).toBe('b14');
    expect(list.at(-1)!.id).toBe('b5');
  });

  it('skips a snapshot identical to the newest', () => {
    const a = makeEntry(graph('same'), 1, 'a');
    const b = makeEntry(graph('same'), 2, 'b');
    expect(pushBackup([a], b)).toEqual([a]);
    expect(pushBackup([a], makeEntry(graph('other'), 3, 'c'))).toHaveLength(2);
  });

  it('drops the oldest entries to stay under the byte cap, but always keeps the newest', () => {
    const e = (i: number, n: number) => makeEntry(graph(`g${i}`, n), i, `b${i}`);
    let list = pushBackup([], e(1, 5));
    list = pushBackup(list, e(2, 5));
    list = pushBackup(list, e(3, 5));
    const cap = list[0].bytes * 2 + 10;
    const capped = pushBackup(list, e(4, 5), { maxBytes: cap });
    expect(capped.map((x) => x.id)).toEqual(['b4', 'b3']);
    const huge = pushBackup(capped, e(5, 200), { maxBytes: 100 });
    expect(huge.map((x) => x.id)).toEqual(['b5']);
  });

  it('rate limit and signature', () => {
    expect(shouldSnapshot(null, 5)).toBe(true);
    expect(shouldSnapshot(1000, 20_000)).toBe(false);
    expect(shouldSnapshot(1000, 31_000)).toBe(true);
    expect(signature('abc')).toBe(signature('abc'));
    expect(signature('abc')).not.toBe(signature('abd'));
  });
});

describe('BackupStore', () => {
  it('records, lists without graph bodies, restores a graph, and mirrors each stored snapshot', async () => {
    let t = 0;
    let n = 0;
    const store = new BackupStore(kv(), () => ++t, () => `id${++n}`);
    const mirrored: string[] = [];
    store.onStored = (p, e) => mirrored.push(`${p}:${e.id}`);
    expect(await store.record('p1', graph('one'))).toBe(true);
    expect(await store.record('p1', graph('one'))).toBe(false); // identical
    expect(await store.record('p1', graph('two'))).toBe(true);
    expect(mirrored).toEqual(['p1:id1', 'p1:id3']);
    const list = await store.list('p1');
    expect(list.map((b) => b.name)).toEqual(['two', 'one']);
    expect('graph' in list[0]).toBe(false);
    expect((await store.get('p1', list[1].id))!.name).toBe('one');
    expect(await store.get('p1', 'missing')).toBeNull();
    expect(await store.list('other')).toEqual([]);
    await store.drop('p1');
    expect(await store.list('p1')).toEqual([]);
  });

  it('survives a broken store', async () => {
    const bad: KVLike = {
      get: async () => {
        throw new Error('idb');
      },
      put: async () => undefined,
      delete: async () => undefined,
    };
    expect(await new BackupStore(bad).list('p')).toEqual([]);
  });
});
