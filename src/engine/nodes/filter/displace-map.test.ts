import { expect, it } from 'vitest';
import { LOOP_SEAM_OK } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { baseScene, centredLogo, H, lit, over, px8 } from '../../lib/material2d-testutil';
import type { ImageValue } from '../../types';

const T = { timeout: 180_000 };

const run = async (image: ImageValue, map: ImageValue, params: Record<string, unknown> = {}, seconds = 0) => {
  const t = await H();
  const out = await t.run('displace-map', params, { image, map }, { seconds });
  return { image: out.image as ImageValue, px: await t.pixels(out.image as ImageValue) };
};

/** Every pixel has its own value: R = 4 x, G = 4 y. */
const index = async (w = 64, h = 64, unit = 1) => (await H()).fromFn(w, h, (x, y) => [Math.min(255, x * 4), Math.min(255, y * 4), 90, 255], unit);

it('a constant map shifts the picture by exactly N texels (red = sideways, green = vertical, content moves toward +)', T, async () => {
  const t = await H();
  const img = await index();
  const right = (await run(img, t.solid(64, 64, [255, 255, 255, 255]), { amountX: 6, amountY: 0 })).px;
  for (const [x, y] of [[20, 10], [40, 33], [63, 5]]) {
    expect(px8(right, x, y, 0), `${x},${y}`).toBe((x - 6) * 4);
    expect(px8(right, x, y, 1)).toBe(y * 4);
  }
  const left = (await run(img, t.solid(64, 64, [0, 0, 0, 255]), { amountX: 6, amountY: 0 })).px;
  expect(px8(left, 20, 10, 0)).toBe((20 + 6) * 4);
  const down = (await run(img, t.solid(64, 64, [128, 255, 128, 255]), { amountX: 0, amountY: 5 })).px;
  expect(px8(down, 30, 20, 1)).toBe(15 * 4);
  // lengths are unit pixels: the same picture at 2x resolution (unit 2) moves 12 texels
  const big = await index(128, 128, 2);
  const bigOut = (await run(big, t.solid(128, 128, [255, 255, 255, 255], 2), { amountX: 6, amountY: 0 })).px;
  expect(px8(bigOut, 60, 20, 0)).toBe((60 - 12) * 4 > 255 ? 255 : (60 - 12) * 4);
});

it('mid gray and amount 0 leave the picture alone', T, async () => {
  const t = await H();
  const img = t.scene(64, 64);
  const gray = (await run(img, t.solid(64, 64, [128, 128, 128, 255]), { amountX: 30, amountY: 30 })).px;
  const same = await t.pixels(img);
  let sum = 0;
  for (let i = 0; i < gray.data.length; i++) sum += Math.abs(gray.data[i] - same.data[i]);
  expect(sum / gray.data.length).toBeLessThan(1.5);
  const zero = (await run(img, t.checker(64, 64, 8), { amountX: 0, amountY: 0 })).px;
  expect(zero.data).toEqual(same.data);
});

it('edge modes: stretch, mirror, wrap and transparent', T, async () => {
  const t = await H();
  const img = await index();
  const white = t.solid(64, 64, [255, 255, 255, 255]);
  const at0 = async (edge: string) => (await run(img, white, { amountX: 6, amountY: 0, edge })).px;
  expect(px8(await at0('clamp'), 0, 10, 0)).toBe(0);
  expect(px8(await at0('wrap'), 0, 10, 0)).toBe(58 * 4);
  expect(px8(await at0('mirror'), 0, 10, 0)).toBe(5 * 4);
  const tr = await at0('transparent');
  expect(px8(tr, 0, 10, 3)).toBe(0);
  expect(px8(tr, 10, 10, 3)).toBe(255);
});

it('brightness gradient pushes pixels along the slope of the map; flat areas of the map do nothing', T, async () => {
  const t = await H();
  const img = await index();
  const stepMap = t.fromFn(64, 64, (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const { px } = await run(img, stepMap, { mode: 'gradient', amountX: 8, amountY: 8, smoothing: 3 });
  expect(px8(px, 5, 20, 0)).toBe(5 * 4);
  expect(px8(px, 58, 20, 0)).toBe(58 * 4);
  expect(px8(px, 31, 20, 0)).toBeLessThan(31 * 4 - 8); // content pushed toward the bright side (right)
  expect(px8(px, 20, 5, 1)).toBe(5 * 4);
});

it('normal map mode uses the tilt of the map; flip Y reverses the vertical push', T, async () => {
  const t = await H();
  const img = await index();
  const tiltRight = t.solid(64, 64, [255, 128, 255, 255]);
  const { px } = await run(img, tiltRight, { mode: 'normal', amountX: 8, amountY: 0 });
  expect(px8(px, 30, 20, 0)).toBe((30 - 8) * 4);
  const tiltUp = t.solid(64, 64, [128, 255, 255, 255]);
  const a = (await run(img, tiltUp, { mode: 'normal', amountX: 0, amountY: 6 })).px;
  const b = (await run(img, tiltUp, { mode: 'normal', amountX: 0, amountY: 6, flipY: true })).px;
  expect(px8(a, 30, 30, 1)).toBe((30 + 6) * 4); // up-facing normal: green is up, content moves up in the picture
  expect(px8(b, 30, 30, 1)).toBe((30 - 6) * 4);
});

/** A float picture (rgba16float) from per-pixel rg flow values, written the way Optical Flow writes it. */
function flowPicture(t: Awaited<ReturnType<typeof H>>, w: number, h: number, fx: number, fy: number): ImageValue {
  const half = (x: number) => {
    const f = new Float32Array([x]);
    const i = new Uint32Array(f.buffer)[0];
    const s = (i >>> 16) & 0x8000;
    const e = ((i >>> 23) & 0xff) - 127 + 15;
    const m = (i >>> 13) & 0x3ff;
    if (x === 0) return 0;
    return s | (e << 10) | m;
  };
  const img = t.gpu.alloc(w, h, 1, 'rgba16float');
  t.gpu.retain(img.texture);
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([half(fx), half(fy), half(0.5), half(1)], i * 4);
  t.gpu.device.queue.writeTexture({ texture: img.texture }, data, { bytesPerRow: w * 8 }, [w, h]);
  return img;
}

it('flow mode moves pixels along the flow (fraction of the picture size per frame), negative frames go back', T, async () => {
  const t = await H();
  const img = await index();
  const flow = flowPicture(t, 64, 64, 0.125, 0); // 8 texels to the right per frame
  const one = (await run(img, flow, { mode: 'flow', flowFrames: 1 })).px;
  expect(px8(one, 30, 20, 0)).toBe((30 - 8) * 4);
  expect(px8(one, 30, 20, 1)).toBe(20 * 4);
  const half = (await run(img, flow, { mode: 'flow', flowFrames: 0.5 })).px;
  expect(px8(half, 30, 20, 0)).toBe((30 - 4) * 4);
  const back = (await run(img, flow, { mode: 'flow', flowFrames: -1 })).px;
  expect(px8(back, 30, 20, 0)).toBe((30 + 8) * 4);
  const down = (await run(img, flowPicture(t, 64, 64, 0, 0.0625), { mode: 'flow' })).px;
  expect(px8(down, 30, 30, 1)).toBe((30 - 4) * 4);
});

it('prism split gives the channels different offsets; art grids move by whole art pixels', T, async () => {
  const t = await H();
  const block = t.fromFn(64, 64, (x, y) => (x >= 20 && x < 44 && y >= 20 && y < 44 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const shiftMap = t.solid(64, 64, [255, 255, 255, 255]);
  const plain = (await run(block, shiftMap, { amountX: 8, amountY: 0 })).px;
  expect([px8(plain, 50, 30, 0), px8(plain, 50, 30, 1), px8(plain, 50, 30, 2)]).toEqual([255, 255, 255]); // moved edge: x = 28 .. 52
  const prism = (await run(block, shiftMap, { amountX: 8, amountY: 0, chroma: 0.5 })).px;
  // red moves 12, green 8, blue 4: the right edge ends at 56, 52 and 48
  expect(px8(prism, 54, 30, 0)).toBe(255);
  expect(px8(prism, 54, 30, 1)).toBe(0);
  expect(px8(prism, 50, 30, 1)).toBe(255);
  expect(px8(prism, 50, 30, 2)).toBe(0);
  expect(px8(prism, 22, 30, 2)).toBe(0);

  const sprite = t.fromFn(128, 128, (x, y) => {
    const cx = x >> 3;
    const cy = y >> 3;
    return (cx + cy) % 3 === 0 ? [240, 60, 60, 255] : [30, 30, 90 + cx * 10, 255];
  });
  const art = { ...sprite, cell: 8 } as ImageValue;
  const snapped = await run(art, t.solid(128, 128, [255, 255, 255, 255]), { amountX: 12, amountY: 0, snap: true });
  expect(snapped.image.cell).toBe(8);
  for (let by = 0; by < 16; by += 5)
    for (let bx = 2; bx < 16; bx++) {
      const ref = snapped.px.at(bx * 8, by * 8);
      for (const [i, j] of [[0, 0], [7, 7], [3, 4], [7, 0]]) expect(snapped.px.at(bx * 8 + i, by * 8 + j)).toEqual(ref);
      expect(ref).toEqual(sprite_at(sprite_px(), bx - 2, by)); // 12 texels = round(1.5) = 2 art pixels
    }
  const free = await run(art, t.solid(128, 128, [255, 255, 255, 255]), { amountX: 12, amountY: 0, snap: false });
  expect(free.image.cell).toBeUndefined();
  // un-snapped: shifted by 12 texels, which is not a whole number of art pixels
  expect(free.px.at(20, 3)).toEqual(sprite_at(sprite_px(), 0, 0, 20 - 12));
  function sprite_px() {
    return (x: number, y: number) => ((x >> 3) + (y >> 3)) % 3 === 0 ? [240, 60, 60, 255] : [30, 30, 90 + (x >> 3) * 10, 255];
  }
  function sprite_at(f: (x: number, y: number) => number[], bx: number, by: number, x?: number) {
    return f(x ?? bx * 8, by * 8);
  }
});

it('scrolling the map loops by whole cycles, nothing moves by default, sliders compile nothing', T, async () => {
  const t = await H();
  const img = t.scene(64, 64);
  const map = t.fromFn(64, 64, (x, y) => [Math.round(128 + 100 * Math.sin((x / 64) * Math.PI * 4)), Math.round(128 + 100 * Math.cos((y / 64) * Math.PI * 2)), 128, 255]);
  const r = await t.loopCheck('displace-map', { scrollX: 1, amountX: 10, amountY: 10 }, { image: img, map });
  expect(r.seam, r.text).toBeLessThanOrEqual(LOOP_SEAM_OK);
  expect(r.motion).toBeGreaterThan(0.2);
  const still = await t.loopCheck('displace-map', { amountX: 10, amountY: 10 }, { image: img, map });
  expect(still.motion).toBe(0);
  await run(img, map, { amountX: 3 });
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const params of [{ amountX: 9 }, { amountY: -4, mapScale: 2 }, { mapOffsetX: 0.3, chroma: 0.2 }]) await run(img, map, params);
  expect(t.gpu.stats().objects.pipelinesCreated - before).toBeLessThanOrEqual(1); // the first non-zero prism split switches nothing on: one structure
});

it('Noise Displace points to this node', T, async () => {
  const t = await H();
  expect(t.registry.get('displace')!.description).toMatch(/Displace by Map/);
  expect(t.registry.get('displace-map')!.description).toMatch(/Noise Displace/);
});

it('looks: a glass-like gradient displacement over the scene, a heat haze and a prism edge (contact sheet)', T, async () => {
  const t = await H();
  const bg = await baseScene();
  const plain = await t.pixels(bg);
  // a bump map: the height output of Material 2D on a logo (a soft pillow)
  const logo = await centredLogo(bg.width, bg.height, 300);
  const bump = (await lit(logo, null, { bevelWidth: 60, profile: 'pillow' }, {}, { port: 'height' })).image as ImageValue;
  const tiles: Img[] = [plain];
  tiles.push((await run(bg, bump, { mode: 'gradient', amountX: 90, amountY: 90, smoothing: 8 })).px);
  const haze = t.fromFn(bg.width, bg.height, (x, y) => [Math.round(128 + 127 * Math.sin(y / 9) * Math.cos(x / 70)), 128, 128, 255]);
  tiles.push((await run(bg, haze, { amountX: 10, amountY: 0 })).px);
  tiles.push((await run(bg, bump, { mode: 'gradient', amountX: 90, amountY: 90, smoothing: 8, chroma: 0.5 })).px);
  writePng('material-2d/displace-by-map', sheet(tiles.map((x) => over(x, plain)), 2), false);
  expect(tiles.length).toBe(4);
});
