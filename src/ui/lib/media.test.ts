import { describe, expect, it } from 'vitest';
import type { AssetInfo, MediaOrg, NodeInstance } from '../../engine/types';
import { EMPTY_ORG, binOf, createBin, deleteBin, moveToBin, normalizeOrg, pruneOrg, recolorBin, renameBin, uniqueBinName } from './mediaOrg';
import { NO_QUERY, buildSections, countByGroup, describeItem, filterItems, groupOf, isFiltering, sortItems, toItem, type MediaItem } from './mediaFilter';
import { NO_SEL, clickSelect, moveSelect, pruneSel, targetsOf } from './mediaSelect';
import { METRICS, columnsFor, layoutRows, moveCursor, orderedIds, visibleRange } from './mediaLayout';
import { assetUsage, usageEqual } from './mediaUsage';
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, clampWidth, loadMediaUi } from './mediaPrefs';

const item = (id: string, p: Partial<MediaItem> = {}): MediaItem => ({ id, name: id, kind: 'image', group: 'image', width: 10, height: 10, duration: 0, bytes: 1, order: 0, ...p });
const asset = (kind: AssetInfo['kind'], p: Partial<AssetInfo> = {}): AssetInfo => ({ id: 'a', name: 'a', kind, width: 4, height: 3, duration: 2, fps: 24, hasAudio: false, ...p });

describe('bins', () => {
  it('creates bins with unique names and cycling colours', () => {
    let org: MediaOrg = EMPTY_ORG;
    const a = createBin(org, 'b1', 'Shots');
    org = a.org;
    const b = createBin(org, 'b2', 'shots');
    expect(b.bin.name).toBe('shots 2');
    expect(b.bin.color).toBe(1);
    expect(uniqueBinName(b.org, 'Shots')).toBe('Shots 3');
  });

  it('moves assets between bins and back to Unsorted', () => {
    const { org } = createBin(EMPTY_ORG, 'b1', 'A');
    const moved = moveToBin(org, ['x', 'y'], 'b1');
    expect(binOf(moved, 'x')).toBe('b1');
    expect(moveToBin(moved, ['x'], 'b1')).toBe(moved); // no change -> same object
    const back = moveToBin(moved, ['x'], null);
    expect(binOf(back, 'x')).toBeNull();
    expect(binOf(back, 'y')).toBe('b1');
    expect(moveToBin(org, ['x'], 'nope').assign).toEqual({}); // a bin that does not exist = Unsorted
  });

  it('deleting a bin sends its assets to Unsorted and keeps the other bins', () => {
    let org = createBin(EMPTY_ORG, 'b1', 'A').org;
    org = createBin(org, 'b2', 'B').org;
    org = moveToBin(moveToBin(org, ['x'], 'b1'), ['y'], 'b2');
    const after = deleteBin(org, 'b1');
    expect(after.bins.map((b) => b.id)).toEqual(['b2']);
    expect(binOf(after, 'x')).toBeNull();
    expect(binOf(after, 'y')).toBe('b2');
    expect(deleteBin(after, 'zzz')).toBe(after);
  });

  it('renames and recolours, ignoring empty names and no-ops', () => {
    const { org } = createBin(EMPTY_ORG, 'b1', 'A');
    expect(renameBin(org, 'b1', '  ')).toBe(org);
    expect(renameBin(org, 'b1', 'A')).toBe(org);
    expect(renameBin(org, 'b1', 'Plates').bins[0].name).toBe('Plates');
    expect(recolorBin(org, 'b1', 3).bins[0].color).toBe(3);
    expect(recolorBin(org, 'b1', 0)).toBe(org);
  });

  it('forgets assets that left the library and tolerates damaged data', () => {
    const org = moveToBin(createBin(EMPTY_ORG, 'b1', 'A').org, ['x', 'gone'], 'b1');
    const pruned = pruneOrg(org, new Set(['x']));
    expect(pruned.assign).toEqual({ x: 'b1' });
    expect(pruneOrg(pruned, new Set(['x']))).toBe(pruned);
    expect(normalizeOrg(undefined)).toBe(EMPTY_ORG);
    expect(normalizeOrg({ bins: 'x', assign: 5 })).toBe(EMPTY_ORG);
    expect(normalizeOrg({ bins: [{ id: 'b', name: 'N' }, { nope: 1 }], assign: { a: 'b', c: 3 } })).toEqual({ bins: [{ id: 'b', name: 'N', color: 0 }], assign: { a: 'b' } });
  });
});

describe('type groups and filtering', () => {
  it('groups kinds, with sequences and the texture shelf apart', () => {
    expect(groupOf('video', { sequence: false })).toBe('video');
    expect(groupOf('video', { sequence: true })).toBe('sequence');
    expect(groupOf('image', { sequence: false, shelf: 'textures' })).toBe('textures');
    expect(groupOf('midi', { sequence: false })).toBe('audio');
    expect(groupOf('splat', { sequence: false })).toBe('model3d');
    expect(groupOf('subtitles', { sequence: false })).toBe('subtitles');
    expect(groupOf('hologram', { sequence: false })).toBe('other');
  });

  const items = [
    item('sunset.png', { order: 0 }),
    item('Clip 10.mp4', { group: 'video', kind: 'video', duration: 9, order: 1, bytes: 500 }),
    item('Clip 2.mp4', { group: 'video', kind: 'video', duration: 3, order: 2, bytes: 900 }),
    item('theme.wav', { group: 'audio', kind: 'audio', duration: 30, order: 3, bytes: 100 }),
  ];

  it('counts per group and filters by type, text (name or type word), unused', () => {
    expect(countByGroup(items)).toMatchObject({ video: 2, image: 1, audio: 1, lut: 0 });
    const used = new Set(['Clip 2.mp4']);
    expect(filterItems(items, { ...NO_QUERY, type: 'video' }, used).map((a) => a.id)).toEqual(['Clip 10.mp4', 'Clip 2.mp4']);
    expect(filterItems(items, { ...NO_QUERY, text: 'CLIP mp4' }, used)).toHaveLength(2);
    expect(filterItems(items, { ...NO_QUERY, text: 'audio' }, used).map((a) => a.id)).toEqual(['theme.wav']);
    expect(filterItems(items, { ...NO_QUERY, unusedOnly: true, type: 'video' }, used).map((a) => a.id)).toEqual(['Clip 10.mp4']);
    expect(isFiltering(NO_QUERY)).toBe(false);
    expect(isFiltering({ ...NO_QUERY, text: ' x ' })).toBe(true);
  });

  it('sorts by name (natural), date added, type, duration, size, either way', () => {
    const ids = (k: Parameters<typeof sortItems>[1], d: 'asc' | 'desc' = 'asc') => sortItems(items, k, d).map((a) => a.id);
    expect(ids('name')).toEqual(['Clip 2.mp4', 'Clip 10.mp4', 'sunset.png', 'theme.wav']);
    expect(ids('added', 'desc')[0]).toBe('theme.wav');
    expect(ids('type')).toEqual(['Clip 2.mp4', 'Clip 10.mp4', 'sunset.png', 'theme.wav']);
    expect(ids('duration')[0]).toBe('sunset.png');
    expect(ids('size', 'desc')[0]).toBe('Clip 2.mp4');
    expect(items[0].id).toBe('sunset.png'); // the input is not reordered
  });

  it('describes items for the second line', () => {
    expect(describeItem(toItem(asset('video'), { sequence: false, bytes: 1 }, 0))).toBe('4×3 · 2.0s');
    expect(describeItem(toItem(asset('audio', { width: 0, height: 0 }), { sequence: false, bytes: 1 }, 0))).toBe('audio · 2.0s');
    expect(describeItem(toItem(asset('lut', { width: 0, height: 0, duration: 0 }), { sequence: false, bytes: 1 }, 0))).toBe('LUT');
  });
});

describe('sections', () => {
  const org = moveToBin(createBin(createBin(EMPTY_ORG, 'b1', 'Plates').org, 'b2', 'Empty').org, ['a', 'c'], 'b1');
  const all = [item('a', { order: 0 }), item('b', { order: 1 }), item('c', { order: 2 }), item('d', { group: 'audio', order: 3 })];

  it('bins view: every bin (even empty), then Unsorted', () => {
    const s = buildSections(all, all, org, 'bins', 'added', 'asc', false);
    expect(s.map((x) => [x.id, x.items.map((i) => i.id)])).toEqual([['b1', ['a', 'c']], ['b2', []], ['unsorted', ['b', 'd']]]);
  });

  it('bins view while filtering: only sections with matches, totals stay', () => {
    const shown = all.filter((a) => a.id === 'c');
    const s = buildSections(all, shown, org, 'bins', 'name', 'asc', true);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'b1', total: 2 });
  });

  it('with no bins at all, Unsorted still shows so the list is not empty-looking', () => {
    expect(buildSections(all, all, EMPTY_ORG, 'bins', 'name', 'asc', false)[0].id).toBe('unsorted');
  });

  it('by-type and flat views', () => {
    const t = buildSections(all, all, org, 'type', 'name', 'asc', false);
    expect(t.map((x) => x.id)).toEqual(['type:image', 'type:audio']);
    const f = buildSections(all, all, org, 'flat', 'name', 'desc', false);
    expect(f).toHaveLength(1);
    expect(f[0].items.map((i) => i.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('click selects one; ctrl toggles; shift takes the range from the anchor', () => {
    let s = clickSelect(NO_SEL, order, 'b', {});
    expect([...s.ids]).toEqual(['b']);
    s = clickSelect(s, order, 'd', { ctrl: true });
    expect([...s.ids].sort()).toEqual(['b', 'd']);
    s = clickSelect(s, order, 'b', { ctrl: true });
    expect([...s.ids]).toEqual(['d']);
    s = clickSelect(clickSelect(NO_SEL, order, 'b', {}), order, 'e', { shift: true });
    expect([...s.ids]).toEqual(['b', 'c', 'd', 'e']);
    expect(s.anchor).toBe('b'); // the anchor stays, so a second shift-click re-ranges
    s = clickSelect(s, order, 'a', { shift: true });
    expect([...s.ids]).toEqual(['a', 'b']);
    s = clickSelect(s, order, 'd', { shift: true, ctrl: true });
    expect([...s.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('moving the cursor replaces, or extends with shift', () => {
    const s = clickSelect(NO_SEL, order, 'b', {});
    expect([...moveSelect(s, order, 'c', false).ids]).toEqual(['c']);
    expect([...moveSelect(s, order, 'd', true).ids]).toEqual(['b', 'c', 'd']);
    expect(moveSelect(s, order, null, false)).toBe(s);
  });
  it('prunes what is no longer visible and picks the targets of a menu', () => {
    const s = clickSelect(clickSelect(NO_SEL, order, 'a', {}), order, 'c', { ctrl: true });
    const p = pruneSel(s, new Set(['a', 'b']));
    expect([...p.ids]).toEqual(['a']);
    expect(p.cursor).toBeNull();
    expect(pruneSel(p, new Set(['a']))).toBe(p);
    expect(targetsOf(s, 'a').sort()).toEqual(['a', 'c']);
    expect(targetsOf(s, 'e')).toEqual(['e']);
  });
});

describe('layout and virtualisation', () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => item(`i${i}`, { order: i }));
  it('computes columns from the width', () => {
    expect(columnsFor(100)).toBe(1);
    expect(columnsFor(264)).toBe(3);
    expect(columnsFor(520)).toBeGreaterThan(5);
  });
  it('lays out headers, grid rows, empty hints and skips folded sections', () => {
    const org = createBin(createBin(EMPTY_ORG, 'b1', 'A').org, 'b2', 'B').org;
    const sections = buildSections(make(7), make(7), moveToBin(org, ['i0', 'i1', 'i2', 'i3'], 'b1'), 'bins', 'added', 'asc', false);
    const { rows } = layoutRows(sections, new Set(), 3, 'grid');
    expect(rows.map((r) => r.kind)).toEqual(['head', 'items', 'items', 'head', 'empty', 'head', 'items']);
    expect(orderedIds(rows)).toHaveLength(7);
    const folded = layoutRows(sections, new Set(['b1']), 3, 'grid').rows;
    expect(folded.map((r) => r.kind)).toEqual(['head', 'head', 'empty', 'head', 'items']);
    expect(orderedIds(folded)).toEqual(['i4', 'i5', 'i6']);
  });
  it('renders only the rows in the window of a 2000-asset library', () => {
    const items = make(2000);
    const { rows, height } = layoutRows(buildSections(items, items, EMPTY_ORG, 'flat', 'name', 'asc', false), new Set(), 3, 'list');
    expect(rows).toHaveLength(2000);
    const [from, to] = visibleRange(rows, 10_000, 400, 2);
    expect(to - from).toBeLessThan(20);
    expect(rows[from].y).toBeLessThanOrEqual(10_000);
    expect(rows[to - 1].y).toBeGreaterThanOrEqual(10_400 - METRICS.listRow);
    expect(visibleRange(rows, 0, 400)[0]).toBe(0);
    expect(visibleRange(rows, height + 50, 400)[1]).toBe(rows.length);
  });
  it('moves the keyboard cursor over the grid, clamping at the edges', () => {
    const items = make(7);
    const { rows } = layoutRows(buildSections(items, items, EMPTY_ORG, 'flat', 'added', 'asc', false), new Set(), 3, 'grid');
    expect(moveCursor(rows, null, 'right')).toBe('i0');
    expect(moveCursor(rows, 'i1', 'down')).toBe('i4');
    expect(moveCursor(rows, 'i5', 'down')).toBe('i6'); // last row is shorter
    expect(moveCursor(rows, 'i6', 'down')).toBe('i6');
    expect(moveCursor(rows, 'i4', 'up')).toBe('i1');
    expect(moveCursor(rows, 'i1', 'up')).toBe('i1');
    expect(moveCursor(rows, 'i3', 'left')).toBe('i2');
    expect(moveCursor(rows, 'i2', 'end')).toBe('i6');
    expect(moveCursor(rows, 'i2', 'home')).toBe('i0');
    expect(moveCursor([], 'x', 'down')).toBeNull();
  });
});

describe('usage', () => {
  const node = (id: string, params: Record<string, unknown>): NodeInstance => ({ id, type: 't', x: 0, y: 0, params });
  it('finds asset ids in lists, single ids and nested json', () => {
    const nodes = [node('n1', { assets: ['a1', 'a2'] }), node('n2', { lut: 'a2', gain: 3 }), node('n3', { edit: { tracks: [{ clips: [{ src: 'a3' }] }] } }), node('n4', { text: 'a1 is not alone' })];
    const u = assetUsage(nodes, new Set(['a1', 'a2', 'a3', 'a4']));
    expect(u.get('a1')).toEqual(['n1']);
    expect(u.get('a2')).toEqual(['n1', 'n2']);
    expect(u.get('a3')).toEqual(['n3']);
    expect(u.has('a4')).toBe(false);
    expect(assetUsage(nodes, new Set()).size).toBe(0);
  });
  it('compares usage maps by content', () => {
    expect(usageEqual(new Map([['a', ['n']]]), new Map([['a', ['n']]]))).toBe(true);
    expect(usageEqual(new Map([['a', ['n']]]), new Map([['a', ['m']]]))).toBe(false);
    expect(usageEqual(new Map(), new Map([['a', ['n']]]))).toBe(false);
  });
});

describe('panel preferences', () => {
  const store = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  it('defaults, clamps, and ignores damaged values', () => {
    expect(loadMediaUi(store({}))).toMatchObject({ collapsed: false, width: DEFAULT_WIDTH, view: 'bins', density: 'grid' });
    expect(loadMediaUi(store({ 'rsmps.ui.media': JSON.stringify({ width: 9999, view: 'nope', density: 'list', collapsed: true, closed: ['b1', 3] }) }))).toMatchObject({ width: MAX_WIDTH, view: 'bins', density: 'list', collapsed: true, closed: ['b1'] });
    expect(loadMediaUi(store({ 'rsmps.ui.media': '{broken' })).width).toBe(DEFAULT_WIDTH);
    expect(clampWidth(10)).toBe(MIN_WIDTH);
    expect(clampWidth(NaN)).toBe(DEFAULT_WIDTH);
  });
  it('an old "hide media panel" choice starts collapsed', () => {
    expect(loadMediaUi(store({ 'rsmps.ui.prefs': JSON.stringify({ leftOpen: false }) })).collapsed).toBe(true);
    expect(loadMediaUi(store({ 'rsmps.ui.prefs': JSON.stringify({ leftOpen: true }) })).collapsed).toBe(false);
  });
});
