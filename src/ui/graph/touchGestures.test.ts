import { describe, expect, it } from 'vitest';
import { PinchTracker, pinchView } from './touchGestures';

const v = { x: 100, y: 50, zoom: 1 };

describe('pinchView', () => {
  it('spreading the fingers zooms in around the midpoint (the point under it stays put)', () => {
    const prev = [{ x: 200, y: 200 }, { x: 300, y: 200 }] as const;
    const next = [{ x: 150, y: 200 }, { x: 350, y: 200 }] as const;
    const out = pinchView(v, prev, next);
    expect(out.zoom).toBeCloseTo(2);
    const wx = (250 - v.x) / v.zoom;
    expect(250 - 0).toBeCloseTo(out.x + wx * out.zoom); // world point under the midpoint is still under it
  });
  it('moving both fingers together pans without zooming', () => {
    const out = pinchView(v, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 130, y: 90 }, { x: 230, y: 90 }]);
    expect(out.zoom).toBeCloseTo(1);
    expect(out.x).toBeCloseTo(130);
    expect(out.y).toBeCloseTo(40);
  });
  it('respects the panel origin and clamps the zoom without moving the anchor', () => {
    const origin = { x: 40, y: 10 };
    const start = { x: 0, y: 0, zoom: 2 };
    const out = pinchView(start, [{ x: 140, y: 110 }, { x: 160, y: 110 }], [{ x: 40, y: 110 }, { x: 260, y: 110 }], origin);
    expect(out.zoom).toBe(2.5);
    const m0 = { x: 150 - origin.x, y: 110 - origin.y };
    const w = { x: (m0.x - start.x) / start.zoom, y: (m0.y - start.y) / start.zoom };
    expect(out.x + w.x * out.zoom).toBeCloseTo(150 - origin.x);
    expect(out.y + w.y * out.zoom).toBeCloseTo(110 - origin.y);
    expect(pinchView(start, [{ x: 100, y: 0 }, { x: 300, y: 0 }], [{ x: 200, y: 0 }, { x: 201, y: 0 }]).zoom).toBe(0.15);
  });
  it('fingers on top of each other: pan only, no blow-up', () => {
    const out = pinchView(v, [{ x: 5, y: 5 }, { x: 5, y: 5 }], [{ x: 25, y: 5 }, { x: 45, y: 5 }]);
    expect(out.zoom).toBe(1);
    expect(Number.isFinite(out.x)).toBe(true);
  });
});

describe('PinchTracker', () => {
  it('one finger is not a pinch; the second makes it active until every finger is up', () => {
    const t = new PinchTracker();
    t.down(1, { x: 0, y: 0 });
    expect(t.active).toBe(false);
    expect(t.move(1, { x: 5, y: 5 })).toBeNull();
    t.down(2, { x: 100, y: 0 });
    expect(t.active).toBe(true);
    const m = t.move(2, { x: 120, y: 0 })!;
    expect(m.prev).toEqual([{ x: 5, y: 5 }, { x: 100, y: 0 }]);
    expect(m.next).toEqual([{ x: 5, y: 5 }, { x: 120, y: 0 }]);
    t.up(2);
    expect(t.active).toBe(true); // the leftover finger must not start a drag
    expect(t.move(1, { x: 9, y: 9 })).toBeNull();
    t.up(1);
    expect(t.active).toBe(false);
  });
  it('a third finger does not disturb the pinch', () => {
    const t = new PinchTracker();
    t.down(1, { x: 0, y: 0 });
    t.down(2, { x: 10, y: 0 });
    t.down(3, { x: 50, y: 50 });
    expect(t.move(3, { x: 60, y: 60 })).toBeNull();
    expect(t.move(1, { x: 1, y: 0 })).not.toBeNull();
  });
  it('ignores moves of unknown pointers', () => {
    expect(new PinchTracker().move(9, { x: 0, y: 0 })).toBeNull();
  });
});
