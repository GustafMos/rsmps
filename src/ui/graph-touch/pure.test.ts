import { describe, expect, it } from 'vitest';
import { DoubleTap, edgePanVelocity, evaluationOrder, isTap, legibleView } from './pure';

const R = { left: 0, top: 100, right: 400, bottom: 500 };

describe('edgePanVelocity', () => {
  it('is still in the middle', () => {
    expect(edgePanVelocity(200, 300, R)).toEqual({ dx: 0, dy: 0 });
  });
  it('pans the content toward the finger near an edge, faster the closer it is', () => {
    expect(edgePanVelocity(0, 300, R).dx).toBe(14); // at the left edge the content moves right
    expect(edgePanVelocity(22, 300, R).dx).toBe(7);
    expect(edgePanVelocity(400, 300, R).dx).toBe(-14);
    expect(edgePanVelocity(200, 100, R).dy).toBe(14);
    expect(edgePanVelocity(200, 500, R).dy).toBe(-14);
  });
  it('does not run away when the finger is far outside the panel', () => {
    expect(edgePanVelocity(-300, 300, R)).toEqual({ dx: 0, dy: 0 });
  });
  it('handles a corner on both axes', () => {
    expect(edgePanVelocity(0, 500, R)).toEqual({ dx: 14, dy: -14 });
  });
});

describe('DoubleTap', () => {
  it('needs two quick taps on the same thing', () => {
    const d = new DoubleTap();
    expect(d.tap(0, 10, 10, 'n1')).toBe(false);
    expect(d.tap(200, 14, 12, 'n1')).toBe(true);
    expect(d.tap(300, 14, 12, 'n1')).toBe(false); // memory cleared after a double
  });
  it('is not a double tap when slow, far apart or on another node', () => {
    const d = new DoubleTap();
    d.tap(0, 0, 0, 'a');
    expect(d.tap(600, 0, 0, 'a')).toBe(false);
    d.tap(1000, 0, 0, 'a');
    expect(d.tap(1100, 80, 0, 'a')).toBe(false);
    d.tap(2000, 0, 0, 'a');
    expect(d.tap(2100, 0, 0, 'b')).toBe(false);
  });
});

describe('isTap', () => {
  it('is short and still', () => {
    expect(isTap(120, 2)).toBe(true);
    expect(isTap(900, 2)).toBe(false);
    expect(isTap(100, 30)).toBe(false);
  });
});

describe('legibleView', () => {
  it('raises a tiny framed view and keeps the middle of the panel on the same graph point', () => {
    const v = { x: 50, y: 40, zoom: 0.2 };
    const panel = { width: 400, height: 300 };
    const out = legibleView(v, panel, 0.5);
    expect(out.zoom).toBe(0.5);
    const before = { x: (200 - v.x) / v.zoom, y: (150 - v.y) / v.zoom };
    const after = { x: (200 - out.x) / out.zoom, y: (150 - out.y) / out.zoom };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('centres a given focus point instead', () => {
    const out = legibleView({ x: 0, y: 0, zoom: 0.2 }, { width: 400, height: 300 }, 0.5, { x: 100, y: 100 });
    expect(out).toEqual({ zoom: 0.5, x: 150, y: 100 });
  });
  it('leaves a legible view alone', () => {
    const v = { x: 1, y: 2, zoom: 0.8 };
    expect(legibleView(v, { width: 400, height: 300 }, 0.5)).toBe(v);
  });
});

describe('evaluationOrder', () => {
  const n = (id: string, x: number, y = 0) => ({ id, x, y });
  it('puts every node after the ones that feed it', () => {
    const nodes = [n('out', 600), n('fx', 300), n('src', 0), n('side', 100, 200)];
    const edges = [{ from: { node: 'src' }, to: { node: 'fx' } }, { from: { node: 'fx' }, to: { node: 'out' } }];
    expect(evaluationOrder(nodes, edges).map((x) => x.id)).toEqual(['src', 'side', 'fx', 'out']);
  });
  it('lists nodes in a cycle rather than dropping them', () => {
    const nodes = [n('a', 0), n('b', 100)];
    const edges = [{ from: { node: 'a' }, to: { node: 'b' } }, { from: { node: 'b' }, to: { node: 'a' } }];
    expect(evaluationOrder(nodes, edges).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
});
