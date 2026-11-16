import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupMirror } from './backups.mjs';
import { AUTO_RELOAD_WINDOW_MS, MAX_AUTO_RELOADS, onChildGone, onRendererGone, withSafeParam, withoutSafeParam } from './crash.mjs';

describe('crash policy', () => {
  it('reloads in safe mode after a renderer crash, but not after a clean exit', () => {
    expect(onRendererGone('clean-exit', [], 0).action).toBe('ignore');
    for (const r of ['crashed', 'oom', 'launch-failed', 'abnormal-exit', 'killed']) expect(onRendererGone(r, [], 0).action).toBe('reload-safe');
  });
  it('stops reloading by itself in a crash loop and asks instead', () => {
    let recent = [];
    for (let i = 0; i < MAX_AUTO_RELOADS; i++) {
      const p = onRendererGone('crashed', recent, 1000 + i);
      expect(p.action).toBe('reload-safe');
      recent = p.recentReloads;
    }
    expect(onRendererGone('crashed', recent, 1100)).toMatchObject({ action: 'ask', why: 'loop' });
    expect(onRendererGone('crashed', recent, 1000 + AUTO_RELOAD_WINDOW_MS + 5).action).toBe('reload-safe'); // old crashes expire
  });
  it('only a GPU process crash reloads the page', () => {
    expect(onChildGone('GPU', 'crashed')).toBe(true);
    expect(onChildGone('GPU', 'clean-exit')).toBe(false);
    expect(onChildGone('Utility', 'crashed')).toBe(false);
  });
  it('adds and removes safe=1 without touching the rest of the address', () => {
    expect(withSafeParam('app://rsmps/index.html')).toBe('app://rsmps/index.html?safe=1');
    expect(withSafeParam('http://localhost:5173/?x=1&safe=0#a')).toBe('http://localhost:5173/?x=1&safe=1#a');
    expect(withoutSafeParam('app://rsmps/index.html?safe=1')).toBe('app://rsmps/index.html');
  });
});

describe('backup mirror (files)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsmps-bk-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const doc = (name) => ({ schema: 'rsmps/graph', version: 2, name, nodes: [], edges: [] });

  it('writes, lists newest first, prunes to the newest N, reads back', () => {
    const m = createBackupMirror(dir, 3);
    for (let i = 1; i <= 5; i++) m.write({ project: 'proj_a', name: `Sprite ${i}`, at: 1000 * i, graph: doc(`Sprite ${i}`) });
    m.write({ project: 'proj_b', name: 'Other', at: 9000, graph: doc('Other') });
    expect(readdirSync(join(dir, 'proj_a'))).toHaveLength(3);
    const list = m.list();
    expect(list.map((x) => x.at)).toEqual([9000, 5000, 4000, 3000]);
    expect(JSON.parse(m.read(list[1].file)).name).toBe('Sprite 5');
    expect(readFileSync(join(dir, list[1].file), 'utf8')).toContain('Sprite 5');
  });

  it('refuses paths outside the folder, non-backup files and non-projects', () => {
    const m = createBackupMirror(dir);
    expect(() => m.read('../x.rsmps.json')).toThrow();
    expect(() => m.read('proj_a/../../etc/passwd')).toThrow();
    expect(() => m.read('proj_a/notes.txt')).toThrow();
    expect(() => m.write({ project: 'p', name: 'n', at: 1, graph: { hello: 1 } })).toThrow();
    m.write({ project: '../../evil', name: '../x', at: 1, graph: doc('x') });
    expect(m.list().some((x) => x.file.includes('..'))).toBe(false);
  });
});
