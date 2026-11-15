import { describe, expect, it } from 'vitest';
import { regionsSource, TestGraph } from '../../lib/track-testutil';
import { harness, type Harness } from '../../testing';
import type { ImageValue, Region } from '../../types';

const R = (id: number, box: [number, number, number, number]): Region => ({ id, label: 'thing', score: 0.9, box });
const square = (cx: number, cy: number, h = 0.03): [number, number, number, number] => [cx - h, cy - h, cx + h, cy + h];

function frameSource(t: Harness, id: string, base: ImageValue) {
  t.registry.register({
    id,
    title: id,
    category: 'input',
    description: 'x',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render: () => ({ image: base }),
  });
}

describe('region-trails', () => {
  const setup = async (project: Record<string, unknown> = {}) => {
    const t = await harness([regionsSource('test-mover', (f) => [R(7, square(0.2 + 0.05 * (f % 10), 0.5))])]);
    frameSource(t, 'test-black', t.solid(64, 64, [0, 0, 0, 255]));
    const g = new TestGraph(t, { fps: 10, duration: 1, ...project });
    const src = g.add('test-mover');
    const img = g.add('test-black');
    return { t, g, src, img };
  };

  it('draws a fading line behind the moving region, brighter near the head', async () => {
    const { t, g, src, img } = await setup();
    const n = g.add('region-trails', { style: 'path', perId: false, color: [1, 1, 1, 1], lineWidth: 3, overlayOnly: true, length: 12, decay: 0.8 });
    g.wire(src, 'regions', n, 'regions');
    g.wire(img, 'image', n, 'image');
    const px = await t.pixels((await g.eval(n, 6)) as ImageValue);
    // Head at x = 0.5 (32 px); older positions at 0.45 (29), 0.3 (19).
    const near = px.at(29, 32)[3];
    const far = px.at(19, 32)[3];
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(20);
    expect(px.at(19, 10)[3]).toBe(0); // off the path
    expect(px.at(50, 32)[3]).toBe(0); // the future has no trail
    // Frame 0 has no past: nothing to draw.
    const first = await t.pixels((await g.eval(n, 0)) as ImageValue);
    expect(first.data.every((v) => v === 0)).toBe(true);
  });

  it('wraps around the loop and supports dots and ghost boxes', async () => {
    const { t, g, src, img } = await setup({ loop: true });
    const n = g.add('region-trails', { style: 'path', perId: false, color: [1, 1, 1, 1], lineWidth: 3, overlayOnly: true, length: 3 });
    g.wire(src, 'regions', n, 'regions');
    g.wire(img, 'image', n, 'image');
    // At frame 1 the 2nd sample is frame 9 (wrapped): the mover jumped from x=0.65 to 0.2, so the segment crosses the frame.
    const px = await t.pixels((await g.eval(n, 1)) as ImageValue);
    expect(px.at(40, 32)[3]).toBeGreaterThan(0);

    const dots = g.add('region-trails', { style: 'dots', perId: false, color: [1, 1, 1, 1], lineWidth: 5, overlayOnly: true, length: 2, step: 3, decay: 1 });
    g.wire(src, 'regions', dots, 'regions');
    g.wire(img, 'image', dots, 'image');
    const d = await t.pixels((await g.eval(dots, 6)) as ImageValue);
    expect(d.at(22, 32)[3]).toBeGreaterThan(200);
    expect(d.at(27, 32)[3]).toBe(0); // between dots

    const boxes = g.add('region-trails', { style: 'boxes', perId: false, color: [1, 1, 1, 1], lineWidth: 1, overlayOnly: true, length: 2, decay: 1 });
    g.wire(src, 'regions', boxes, 'regions');
    g.wire(img, 'image', boxes, 'image');
    const b = await t.pixels((await g.eval(boxes, 6)) as ImageValue);
    expect(b.at(32, 32)[3]).toBe(0); // inside a ghost box stays empty
    expect(b.at(32 - 2, 32)[3]).toBeGreaterThan(0); // its left edge (x = 0.47 * 64 ≈ 30)
  });

  it('uses a different colour per id', async () => {
    const t = await harness([regionsSource('test-two', () => [R(0, square(0.25, 0.25)), R(1, square(0.75, 0.75))])]);
    frameSource(t, 'test-black', t.solid(64, 64, [0, 0, 0, 255]));
    const g = new TestGraph(t, { fps: 10 });
    const n = g.add('region-trails', { style: 'boxes', perId: true, lineWidth: 3, overlayOnly: true, length: 1 });
    g.wire(g.add('test-two'), 'regions', n, 'regions');
    g.wire(g.add('test-black'), 'image', n, 'image');
    const px = await t.pixels((await g.eval(n, 3)) as ImageValue);
    const a = px.at(16 - 2, 16);
    const b = px.at(48 - 2, 48);
    expect(a[3]).toBeGreaterThan(0);
    expect(b[3]).toBeGreaterThan(0);
    expect(a.slice(0, 3)).not.toEqual(b.slice(0, 3));
  });
});

describe('region-crop', () => {
  const scene = (t: Harness) =>
    t.fromFn(64, 64, (x, y) => (x >= 40 && x < 56 && y >= 8 && y < 24 ? [255, 0, 0, 255] : x < 8 && y >= 40 ? [0, 0, 255, 255] : [20, 20, 20, 255]));

  const setup = async (list: Region[]) => {
    const t = await harness([regionsSource('test-crop-list', () => list)]);
    frameSource(t, 'test-scene', scene(t));
    const g = new TestGraph(t, { width: 64, height: 64 });
    return { t, g, src: g.add('test-crop-list'), img: g.add('test-scene') };
  };

  it('outputs the region at the requested size', async () => {
    const { t, g, src, img } = await setup([R(0, [40 / 64, 8 / 64, 56 / 64, 24 / 64])]);
    const n = g.add('region-crop', { width: 16, height: 16, padding: 0 });
    g.wire(src, 'regions', n, 'regions');
    g.wire(img, 'image', n, 'image');
    const out = (await g.eval(n)) as ImageValue;
    expect([out.width, out.height]).toEqual([16, 16]);
    const px = await t.pixels(out);
    expect(px.at(8, 8)).toEqual([255, 0, 0, 255]);
    expect(px.at(1, 1)).toEqual([255, 0, 0, 255]);
    const padded = g.add('region-crop', { width: 16, height: 16, padding: 0.5 });
    g.wire(src, 'regions', padded, 'regions');
    g.wire(img, 'image', padded, 'image');
    const pp = await t.pixels((await g.eval(padded)) as ImageValue);
    expect(pp.at(8, 8)).toEqual([255, 0, 0, 255]);
    expect(pp.at(1, 1)[0]).toBe(20); // the surroundings appear
  });

  it('uses a wide window for a wide output and slides back inside the frame', async () => {
    const { t, g, src, img } = await setup([R(0, [48 / 64, 8 / 64, 64 / 64, 24 / 64])]);
    const n = g.add('region-crop', { width: 32, height: 16, padding: 0, keepInside: true });
    g.wire(src, 'regions', n, 'regions');
    g.wire(img, 'image', n, 'image');
    const px = await t.pixels((await g.eval(n)) as ImageValue);
    expect(px.at(31, 8)[3]).toBe(255); // right edge still inside the picture: window was slid left
    expect(px.at(31, 8)[0]).toBe(20);
    expect(px.at(20, 8)[0]).toBe(255);
    const out = g.add('region-crop', { width: 32, height: 16, padding: 0, keepInside: false });
    g.wire(src, 'regions', out, 'regions');
    g.wire(img, 'image', out, 'image');
    expect((await t.pixels((await g.eval(out)) as ImageValue)).at(31, 8)[3]).toBe(0); // outside the frame is transparent
  });

  it('selects by id and handles a missing region', async () => {
    const { t, g, src, img } = await setup([R(4, [0, 40 / 64, 8 / 64, 48 / 64]), R(9, [40 / 64, 8 / 64, 56 / 64, 24 / 64])]);
    const byId = g.add('region-crop', { width: 8, height: 8, padding: 0, id: 4 });
    g.wire(src, 'regions', byId, 'regions');
    g.wire(img, 'image', byId, 'image');
    expect((await t.pixels((await g.eval(byId)) as ImageValue)).at(4, 4)).toEqual([0, 0, 255, 255]);
    const missing = g.add('region-crop', { width: 8, height: 8, id: 77, missing: 'empty' });
    g.wire(src, 'regions', missing, 'regions');
    g.wire(img, 'image', missing, 'image');
    expect((await t.pixels((await g.eval(missing)) as ImageValue)).at(4, 4)[3]).toBe(0);
    const full = g.add('region-crop', { width: 8, height: 8, id: 77, missing: 'full' });
    g.wire(src, 'regions', full, 'regions');
    g.wire(img, 'image', full, 'image');
    expect((await t.pixels((await g.eval(full)) as ImageValue)).at(4, 4)[3]).toBe(255);
  });
});

describe('region-stamp', () => {
  const setup = async (list: Region[], size = 64, unit = 1) => {
    const t = await harness([regionsSource('test-stamp-list', () => list)]);
    frameSource(t, 'test-base', t.solid(size, size, [0, 0, 0, 255], unit));
    const g = new TestGraph(t, { width: size, height: size });
    return { t, g, src: g.add('test-stamp-list'), base: g.add('test-base') };
  };
  const sprite = (t: Harness, g: TestGraph, rgba: [number, number, number, number], w = 8, h = 8) => g.add(t.source(t.solid(w, h, rgba)));

  it('fits a sprite to the box, and respects opacity', async () => {
    const { t, g, src, base } = await setup([R(0, [0.25, 0.25, 0.75, 0.75])]);
    const n = g.add('region-stamp', { sizeMode: 'fit', opacity: 1 });
    g.wire(src, 'regions', n, 'regions');
    g.wire(base, 'image', n, 'image');
    g.wire(sprite(t, g, [0, 255, 0, 255]), 'out', n, 'sprites');
    const px = await t.pixels((await g.eval(n)) as ImageValue);
    expect(px.at(32, 32)).toEqual([0, 255, 0, 255]);
    expect(px.at(17, 17)).toEqual([0, 255, 0, 255]);
    expect(px.at(10, 10)).toEqual([0, 0, 0, 255]);
    const half = g.add('region-stamp', { opacity: 0.5 });
    g.wire(src, 'regions', half, 'regions');
    g.wire(base, 'image', half, 'image');
    g.wire(sprite(t, g, [0, 255, 0, 255]), 'out', half, 'sprites');
    const hp = await t.pixels((await g.eval(half)) as ImageValue);
    expect(Math.abs(hp.at(32, 32)[1] - 128)).toBeLessThanOrEqual(2);
  });

  it('uses a fixed size, keeps sprite aspect, anchors on top and rotates', async () => {
    const { t, g, src, base } = await setup([R(0, [0.4, 0.5, 0.6, 0.9])]);
    const fixed = g.add('region-stamp', { sizeMode: 'fixed', fixedSize: 10 });
    g.wire(src, 'regions', fixed, 'regions');
    g.wire(base, 'image', fixed, 'image');
    g.wire(sprite(t, g, [255, 0, 0, 255], 20, 10), 'out', fixed, 'sprites');
    const px = await t.pixels((await g.eval(fixed)) as ImageValue);
    // 2:1 sprite, 10 px high → 20 px wide, centred at (32, 44.8).
    expect(px.at(32, 45)[0]).toBe(255);
    expect(px.at(23, 45)[0]).toBe(255);
    expect(px.at(20, 45)[0]).toBe(0);
    expect(px.at(32, 38)[0]).toBe(0);
    const top = g.add('region-stamp', { sizeMode: 'fixed', fixedSize: 10, anchor: 'top' });
    g.wire(src, 'regions', top, 'regions');
    g.wire(base, 'image', top, 'image');
    g.wire(sprite(t, g, [255, 0, 0, 255], 20, 10), 'out', top, 'sprites');
    const tp = await t.pixels((await g.eval(top)) as ImageValue);
    expect(tp.at(32, 28)[0]).toBe(255); // sits above the box top (y = 32)
    const rot = g.add('region-stamp', { sizeMode: 'fixed', fixedSize: 10, rotation: 90 });
    g.wire(src, 'regions', rot, 'regions');
    g.wire(base, 'image', rot, 'image');
    g.wire(sprite(t, g, [255, 0, 0, 255], 20, 10), 'out', rot, 'sprites');
    const rp = await t.pixels((await g.eval(rot)) as ImageValue);
    expect(rp.at(32, 37)[0]).toBe(255); // now 20 px tall
    expect(rp.at(25, 45)[0]).toBe(0);
  });

  it('picks different sprites per id', async () => {
    const { t, g, src, base } = await setup([R(0, [0.1, 0.1, 0.4, 0.4]), R(1, [0.6, 0.6, 0.9, 0.9])]);
    const n = g.add('region-stamp', { variation: 'id' });
    g.wire(src, 'regions', n, 'regions');
    g.wire(base, 'image', n, 'image');
    g.wire(sprite(t, g, [255, 0, 0, 255]), 'out', n, 'sprites');
    g.wire(sprite(t, g, [0, 0, 255, 255]), 'out', n, 'sprites');
    const px = await t.pixels((await g.eval(n)) as ImageValue);
    expect(px.at(16, 16)).toEqual([255, 0, 0, 255]);
    expect(px.at(48, 48)).toEqual([0, 0, 255, 255]);
    const none = g.add('region-stamp', { variation: 'none' });
    g.wire(src, 'regions', none, 'regions');
    g.wire(base, 'image', none, 'image');
    g.wire(sprite(t, g, [255, 0, 0, 255]), 'out', none, 'sprites');
    g.wire(sprite(t, g, [0, 0, 255, 255]), 'out', none, 'sprites');
    expect((await t.pixels((await g.eval(none)) as ImageValue)).at(48, 48)).toEqual([255, 0, 0, 255]);
  });

  it('passes the image through without sprites, and scales fixed sizes at 2x', async () => {
    const { t, g, src, base } = await setup([R(0, [0.4, 0.4, 0.6, 0.6])]);
    const n = g.add('region-stamp');
    g.wire(src, 'regions', n, 'regions');
    g.wire(base, 'image', n, 'image');
    expect((await t.pixels((await g.eval(n)) as ImageValue)).at(32, 32)).toEqual([0, 0, 0, 255]);

    const mk = async (size: number, unit: number) => {
      const s = await setup([R(0, [0.4, 0.4, 0.6, 0.6])], size, unit);
      const st = s.g.add('region-stamp', { sizeMode: 'fixed', fixedSize: 10 });
      s.g.wire(s.src, 'regions', st, 'regions');
      s.g.wire(s.base, 'image', st, 'image');
      s.g.wire(sprite(s.t, s.g, [255, 255, 255, 255]), 'out', st, 'sprites');
      return s.t.pixels((await s.g.eval(st)) as ImageValue);
    };
    const a = await mk(64, 1);
    const b = await mk(128, 2);
    let sum = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) sum += Math.abs(a.at(x, y)[0] - b.at(x * 2 + 1, y * 2 + 1)[0]);
    expect(sum / 4096).toBeLessThan(6);
  });
});
