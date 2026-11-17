import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { registerBuiltins } from '../../engine/nodes';
import { DEFAULT_PROJECT, type GraphDoc } from '../../engine/types';
import { SNAPSHOT_CAP, firstImageInputSource, overlayStyle, snapCaption, stripAdd, stripRemove, stripRename, wipeLine, wipePolygon, wipePosFromPointer, type Snap } from './compare';

const snap = (i: number, t = i): Snap => ({ id: `s${i}`, frame: i, nodeId: 'n', nodeName: 'Blur', t, label: '', width: 10, height: 10, previewPct: 100, kind: 'view' });

describe('snapshot strip', () => {
  it('caps at 12 and evicts the least recently used, never the new one', () => {
    let strip: Snap[] = [];
    const used = new Map<string, number>();
    for (let i = 0; i < SNAPSHOT_CAP; i++) strip = stripAdd(strip, snap(i), used).strip;
    expect(strip).toHaveLength(SNAPSHOT_CAP);
    used.set('s0', 1000); // s0 was just looked at: s1 is now the oldest
    const r = stripAdd(strip, snap(99, 2000), used);
    expect(r.strip).toHaveLength(SNAPSHOT_CAP);
    expect(r.evicted.map((s) => s.id)).toEqual(['s1']);
    expect(r.strip.some((s) => s.id === 's99')).toBe(true);
    expect(r.strip.some((s) => s.id === 's0')).toBe(true);
  });
  it('remove and rename', () => {
    const strip = [snap(1), snap(2)];
    expect(stripRemove(strip, 's1').map((s) => s.id)).toEqual(['s2']);
    expect(stripRename(strip, 's2', '  before  ')[1].label).toBe('before');
    expect(stripRename(strip, 's2', 'x'.repeat(100))[1].label).toHaveLength(40);
  });
  it('caption', () => {
    expect(snapCaption({ ...snap(3), label: 'v1' })).toMatch(/^v1 · frame 3 · Blur · \d\d:\d\d$/);
  });
});

describe('wipe geometry', () => {
  it('vertical wipe at 50% keeps the left half', () => {
    const pts = wipePolygon(0.5, 0, 1).match(/-?\d+(\.\d+)?%/g)!.map((s) => parseFloat(s));
    const xs = pts.filter((_, i) => i % 2 === 0);
    // the line is at x = 50 and the kept side is x <= 50
    expect(xs.filter((x) => Math.abs(x - 50) < 0.01)).toHaveLength(2);
    expect(Math.max(...xs.filter((x) => Math.abs(x - 50) > 0.01))).toBeLessThan(0);
  });
  it('angle 90 is a horizontal line keeping the top', () => {
    const pts = wipePolygon(0.5, 90, 1).match(/-?\d+(\.\d+)?%/g)!.map((s) => parseFloat(s));
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(ys.filter((y) => Math.abs(y - 50) < 0.01)).toHaveLength(2);
    expect(Math.max(...ys.filter((y) => Math.abs(y - 50) > 0.01))).toBeLessThan(0);
  });
  it('line end points pass through the pivot and respect the aspect ratio', () => {
    const l = wipeLine(0.25, 0, 2);
    expect(l.x1).toBeCloseTo(25);
    expect(l.x2).toBeCloseTo(25);
    expect((l.y1 + l.y2) / 2).toBeCloseTo(50);
    const d = wipeLine(0.5, 45, 1);
    expect((d.x1 + d.x2) / 2).toBeCloseTo(50);
    expect((d.y1 + d.y2) / 2).toBeCloseTo(50);
    // 45 degrees on a square: dx and dy of the line are equal in size
    expect(Math.abs(d.x2 - d.x1)).toBeCloseTo(Math.abs(d.y2 - d.y1));
  });
  it('pointer to position round-trips for several angles', () => {
    for (const angle of [0, 20, -30, 180]) {
      for (const pos of [0.2, 0.5, 0.8]) {
        const l = wipeLine(pos, angle, 1.5);
        // a point on the line: its midpoint at the pivot row
        const u = (l.x1 + l.x2) / 200;
        const v = (l.y1 + l.y2) / 200;
        expect(wipePosFromPointer(u, v, angle, 1.5)).toBeCloseTo(pos, 1);
      }
    }
    expect(wipePosFromPointer(5, 0.5, 0, 1)).toBe(1);
  });
});

describe('overlay style per mode', () => {
  const base = { wipePos: 0.5, wipeAngle: 0, onion: 0.4, gain: 4, flipped: false, aspect: 1 };
  it('off shows nothing', () => expect(overlayStyle({ ...base, mode: 'off' }).overlay.visible).toBe(false));
  it('wipe clips', () => expect(overlayStyle({ ...base, mode: 'wipe' }).overlay.clipPath).toContain('polygon'));
  it('toggle follows the held key', () => {
    expect(overlayStyle({ ...base, mode: 'toggle' }).overlay.visible).toBe(false);
    expect(overlayStyle({ ...base, mode: 'toggle', flipped: true }).overlay.visible).toBe(true);
  });
  it('onion uses the opacity, clamped', () => {
    expect(overlayStyle({ ...base, mode: 'onion' }).overlay.opacity).toBe(0.4);
    expect(overlayStyle({ ...base, mode: 'onion', onion: 3 }).overlay.opacity).toBe(1);
  });
  it('difference blends and applies the gain to the stage', () => {
    const s = overlayStyle({ ...base, mode: 'diff' });
    expect(s.overlay.mixBlendMode).toBe('difference');
    expect(s.stageFilter).toBe('brightness(4)');
    expect(overlayStyle({ ...base, mode: 'diff', gain: 0 }).stageFilter).toBe('brightness(1)');
  });
  it('side by side hides the live stage', () => expect(overlayStyle({ ...base, mode: 'side' }).hideStage).toBe(true));
});

describe('bypass compare source', () => {
  const reg = new Registry();
  registerBuiltins(reg);
  const g: GraphDoc = {
    schema: 'rsmps/graph', version: 2, name: 't', project: { ...DEFAULT_PROJECT },
    nodes: [
      { id: 'a', type: 'noise', x: 0, y: 0, params: {} },
      { id: 'b', type: 'vignette', x: 1, y: 0, params: {} },
    ],
    edges: [{ id: 'e', from: { node: 'a', port: 'image' }, to: { node: 'b', port: 'image' } }],
  };
  it('finds the node feeding the first image input', () => {
    expect(firstImageInputSource(g, reg, 'b')).toBe('a');
    expect(firstImageInputSource(g, reg, 'a')).toBeNull();
    expect(firstImageInputSource(g, reg, 'missing')).toBeNull();
  });
});
