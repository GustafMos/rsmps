import { describe, expect, it } from 'vitest';
import { regionsSource, TestGraph } from '../../lib/track-testutil';
import { harness, type Harness } from '../../testing';
import type { Host, ImageValue, MaskValue, Region } from '../../types';

const R = (id: number, box: [number, number, number, number], label = 'thing', score = 0.9): Region => ({ id, label, score, box });
const ONE: Region[] = [R(0, [0.25, 0.25, 0.75, 0.75])];

/** A fake text rasteriser: every label is a solid white 20x10 block. */
const host: Host = {
  assetInfo: () => null,
  assetFrame: async () => null,
  rasterizeText: () => ({ data: new Uint8ClampedArray(20 * 10 * 4).fill(255), width: 20, height: 10 }),
};

async function run(t: Harness, type: string, params: Record<string, unknown>, _list: Region[], size: number, _unit = 1, port = 'image') {
  const g = new TestGraph(t, { width: size, height: size, lengthMode: 'absolute' });
  const src = g.add('test-draw-list');
  const img = g.add('test-draw-img');
  const n = g.add(type, params);
  g.wire(src, 'regions', n, 'regions');
  g.wire(img, 'image', n, 'image');
  return { out: (await g.eval(n, 0, port)) as ImageValue | MaskValue, g };
}

async function setup(list: Region[], size = 64, unit = 1, withHost = false) {
  const t = await harness([regionsSource('test-draw-list', () => list)], withHost ? host : undefined);
  const base = t.solid(size, size, [0, 0, 0, 255], unit);
  t.registry.register({
    id: 'test-draw-img',
    title: 'x',
    category: 'input',
    description: 'x',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render: () => ({ image: base }),
  });
  return t;
}

describe('regions-to-mask', () => {
  it('rasterises rectangles, ellipses and rounded rectangles', async () => {
    const t = await setup(ONE);
    const rect = await run(t, 'regions-to-mask', { shape: 'rect' }, ONE, 64, 1, 'mask');
    const px = await t.pixels(rect.out);
    expect(px.at(32, 32)[0]).toBe(255);
    expect(px.at(18, 18)[0]).toBe(255);
    expect(px.at(10, 32)[0]).toBe(0);
    expect(px.at(32, 60)[0]).toBe(0);
    const ell = await t.pixels((await run(t, 'regions-to-mask', { shape: 'ellipse' }, ONE, 64, 1, 'mask')).out);
    expect(ell.at(32, 32)[0]).toBe(255);
    expect(ell.at(17, 17)[0]).toBe(0); // corner of the box is outside the ellipse
    expect(ell.at(17, 32)[0]).toBeGreaterThan(200);
    const rr = await t.pixels((await run(t, 'regions-to-mask', { shape: 'rounded', corner: 8 }, ONE, 64, 1, 'mask')).out);
    expect(rr.at(16, 16)[0]).toBeLessThan(80);
    expect(rr.at(32, 17)[0]).toBe(255);
  });

  it('feathers, limits to the first N and inverts', async () => {
    const two = [R(0, [0.1, 0.1, 0.4, 0.4]), R(1, [0.6, 0.6, 0.9, 0.9])];
    const t = await setup(two);
    const both = await t.pixels((await run(t, 'regions-to-mask', {}, two, 64, 1, 'mask')).out);
    expect(both.at(12, 12)[0]).toBe(255);
    expect(both.at(50, 50)[0]).toBe(255);
    const one = await t.pixels((await run(t, 'regions-to-mask', { limit: 1 }, two, 64, 1, 'mask')).out);
    expect(one.at(12, 12)[0]).toBe(255);
    expect(one.at(50, 50)[0]).toBe(0);
    const inv = await t.pixels((await run(t, 'regions-to-mask', { limit: 1, invert: true }, two, 64, 1, 'mask')).out);
    expect(inv.at(12, 12)[0]).toBe(0);
    expect(inv.at(50, 50)[0]).toBe(255);
    const t1 = await setup(ONE);
    const soft = await t1.pixels((await run(t1, 'regions-to-mask', { feather: 8 }, ONE, 64, 1, 'mask')).out);
    expect(soft.at(16, 32)[0]).toBeGreaterThan(90);
    expect(soft.at(16, 32)[0]).toBeLessThan(170);
    expect(soft.at(32, 32)[0]).toBe(255);
  });

  it('drives the mask socket of an effect so it only hits the region', async () => {
    const t = await setup(ONE);
    const g = new TestGraph(t, { width: 64, height: 64 });
    const src = g.add('test-draw-list');
    const img = g.add('test-draw-img');
    const m = g.add('regions-to-mask');
    const inv = g.add('invert');
    g.wire(img, 'image', m, 'image');
    g.wire(src, 'regions', m, 'regions');
    g.wire(img, 'image', inv, 'image');
    g.wire(m, 'mask', inv, 'mask');
    const px = await t.pixels((await g.eval(inv)) as ImageValue);
    expect(px.at(32, 32)[0]).toBe(255); // inverted inside the region
    expect(px.at(4, 4)[0]).toBe(0); // untouched outside
  });

  it('is resolution independent (2x image, unit 2)', async () => {
    const a = await setup(ONE, 64, 1);
    const b = await setup(ONE, 128, 2);
    const ma = await a.pixels((await run(a, 'regions-to-mask', { shape: 'rounded', corner: 8, feather: 4 }, ONE, 64, 1, 'mask')).out);
    const mb = await b.pixels((await run(b, 'regions-to-mask', { shape: 'rounded', corner: 8, feather: 4 }, ONE, 128, 2, 'mask')).out);
    let sum = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) sum += Math.abs(ma.at(x, y)[0] - mb.at(x * 2 + 1, y * 2 + 1)[0]);
    expect(sum / 4096).toBeLessThan(6);
  });
});

describe('region-overlay', () => {
  it('draws a box outline over the image', async () => {
    const t = await setup(ONE);
    const { out } = await run(t, 'region-overlay', { style: 'box', lineWidth: 2, color: [1, 0, 0, 1], showLabel: false }, ONE, 64);
    const px = await t.pixels(out as ImageValue);
    expect(px.at(16, 32)).toEqual([255, 0, 0, 255]); // left edge
    expect(px.at(32, 16)[0]).toBe(255); // top edge
    expect(px.at(32, 32)).toEqual([0, 0, 0, 255]); // inside stays untouched
    expect(px.at(4, 4)).toEqual([0, 0, 0, 255]);
  });

  it('brackets only mark the corners, crosshair the middle, ellipse the round', async () => {
    const t = await setup(ONE);
    const common = { lineWidth: 2, color: [1, 0, 0, 1], showLabel: false };
    const br = await t.pixels((await run(t, 'region-overlay', { ...common, style: 'brackets', cornerLength: 0.25 }, ONE, 64)).out as ImageValue);
    expect(br.at(16, 16)[0]).toBe(255);
    expect(br.at(20, 16)[0]).toBe(255); // along the top edge, inside the arm
    expect(br.at(32, 16)[0]).toBe(0); // middle of the top edge: no line
    expect(br.at(16, 32)[0]).toBe(0);
    const ch = await t.pixels((await run(t, 'region-overlay', { ...common, style: 'crosshair' }, ONE, 64)).out as ImageValue);
    expect(ch.at(32, 20)[0]).toBe(255);
    expect(ch.at(20, 32)[0]).toBe(255);
    expect(ch.at(32, 32)[0]).toBe(0); // gap in the middle
    expect(ch.at(20, 20)[0]).toBe(0);
    const el = await t.pixels((await run(t, 'region-overlay', { ...common, style: 'ellipse' }, ONE, 64)).out as ImageValue);
    expect(el.at(16, 32)[0]).toBe(255);
    expect(el.at(17, 17)[0]).toBe(0);
    const rd = await t.pixels((await run(t, 'region-overlay', { ...common, style: 'rounded', cornerRadius: 12 }, ONE, 64)).out as ImageValue);
    expect(rd.at(16, 16)[0]).toBe(0);
    expect(rd.at(16, 32)[0]).toBe(255);
  });

  it('fill, centre dot and per-id colours', async () => {
    const two = [R(0, [0.1, 0.1, 0.4, 0.4]), R(1, [0.6, 0.6, 0.9, 0.9])];
    const t = await setup(two);
    const f = await t.pixels((await run(t, 'region-overlay', { style: 'box', fillOpacity: 0.5, color: [1, 1, 1, 1], showLabel: false, centerDot: true, dotSize: 2 }, two, 64)).out as ImageValue);
    expect(f.at(10, 10)[0]).toBeGreaterThan(110);
    expect(f.at(10, 10)[0]).toBeLessThan(145);
    expect(f.at(16, 16)[0]).toBe(255); // centre dot
    const c = await t.pixels((await run(t, 'region-overlay', { style: 'box', perId: true, lineWidth: 3, showLabel: false }, two, 64)).out as ImageValue);
    const a = c.at(6, 16);
    const b = c.at(38, 50);
    expect(a.slice(0, 3)).not.toEqual(b.slice(0, 3));
  });

  it('glow spreads light outside the line', async () => {
    const t = await setup(ONE);
    const base = { style: 'box', lineWidth: 2, color: [1, 1, 1, 1], showLabel: false };
    const off = await t.pixels((await run(t, 'region-overlay', base, ONE, 64)).out as ImageValue);
    const on = await t.pixels((await run(t, 'region-overlay', { ...base, glowStrength: 1.5, glowRadius: 6 }, ONE, 64)).out as ImageValue);
    expect(off.at(12, 32)[0]).toBe(0);
    expect(on.at(12, 32)[0]).toBeGreaterThan(20);
    expect(on.at(16, 32)[0]).toBe(255);
  });

  it('overlay only: transparent where nothing is drawn, keeps the image out', async () => {
    const t = await setup(ONE);
    const { out } = await run(t, 'region-overlay', { style: 'box', lineWidth: 2, color: [0, 1, 0, 1], showLabel: false, overlayOnly: true }, ONE, 64);
    const px = await t.pixels(out as ImageValue);
    expect(px.at(4, 4)[3]).toBe(0);
    expect(px.at(32, 32)[3]).toBe(0);
    expect(px.at(16, 32)).toEqual([0, 255, 0, 255]);
  });

  it('draws labels above the box when text rendering is available, and skips them headless', async () => {
    const withText = await setup(ONE, 64, 1, true);
    const lab = await run(withText, 'region-overlay', { style: 'box', lineWidth: 1, color: [1, 0, 0, 1], showLabel: true, labelSize: 8, overlayOnly: true }, ONE, 64);
    const px = await withText.pixels(lab.out as ImageValue);
    // Label block (20x10 + padding) sits above the box top-left corner (16, 16): around x 16..40, y 2..14.
    expect(px.at(24, 8)[3]).toBeGreaterThan(200);
    expect(px.at(60, 8)[3]).toBe(0);
    const headless = await setup(ONE, 64, 1, false);
    const none = await run(headless, 'region-overlay', { style: 'box', lineWidth: 1, color: [1, 0, 0, 1], showLabel: true, overlayOnly: true }, ONE, 64);
    expect((await headless.pixels(none.out as ImageValue)).at(24, 8)[3]).toBe(0);
  });

  it('looks the same at 2x resolution', async () => {
    const a = await setup(ONE, 64, 1);
    const b = await setup(ONE, 128, 2);
    const p = { style: 'brackets', lineWidth: 2, color: [1, 0.5, 0, 1], showLabel: false, glowStrength: 1, glowRadius: 4 };
    // The 2x image carries unit 2, so px lengths double automatically.
    const pa = await a.pixels((await run(a, 'region-overlay', p, ONE, 64)).out as ImageValue);
    const pb = await b.pixels((await run(b, 'region-overlay', p, ONE, 128)).out as ImageValue);
    let sum = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) sum += Math.abs(pa.at(x, y)[0] - pb.at(x * 2 + 1, y * 2 + 1)[0]);
    expect(sum / 4096).toBeLessThan(8);
  });
});
