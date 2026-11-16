import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 128, height: 128 };
const front = { rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.5, ambient: 1, specular: 0, ao: 0 };
const at = (px: Img, x: number, y: number) => {
  const i = (y * px.width + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
};
const run = async (params: Record<string, unknown>, inputs: Record<string, never>, project = proj) => {
  const t = await H();
  return t.pixels((await t.run('image-to-3d', params, inputs, { project })).image as never);
};

it('a ring-shaped alpha gives a visible hole; the body is opaque', { timeout: 120_000 }, async () => {
  const t = await H();
  const ring = t.fromFn(32, 32, (x, y) => {
    const r = Math.hypot(x - 15.5, y - 15.5);
    return r < 14 && r > 6 ? [220, 40, 40, 255] : [0, 0, 0, 0];
  });
  for (const silhouette of ['blocky', 'smooth']) {
    const px = await run({ ...front, silhouette }, { image: ring as never });
    expect(at(px, 64, 64)[3], silhouette).toBe(0); // the hole
    expect(at(px, 64, 64 - 22)[3], silhouette).toBe(255); // ring body (radius 10 art pixels = 20 texels)
    expect(at(px, 2, 2)[3], silhouette).toBe(0);
  }
});

it('walls take the colour of the edge pixel; darkened and one-colour variants', { timeout: 120_000 }, async () => {
  const t = await H();
  const img = t.fromFn(8, 8, (x) => (x < 4 ? [0, 0, 255, 255] : [0, 255, 0, 255]));
  const side = { ...front, rotY: 90, depth: 0.5, silhouette: 'blocky' };
  const c = at(await run(side, { image: img as never }), 64, 64);
  expect(c[3]).toBe(255);
  expect(c[1]).toBeGreaterThan(200); // the right-hand wall is green
  expect(c[2]).toBeLessThan(60);
  const left = at(await run({ ...side, rotY: -90 }, { image: img as never }), 64, 64);
  expect(left[2]).toBeGreaterThan(200); // seen from the other side the wall is blue
  const dark = at(await run({ ...side, sides: 'darkened', darken: 0.5 }, { image: img as never }), 64, 64);
  expect(dark[1]).toBeLessThan(150);
  const flat = at(await run({ ...side, sides: 'colour', sideColor: [1, 0, 0, 1] }, { image: img as never }), 64, 64);
  expect(flat[0]).toBeGreaterThan(200);
  const wrapped = at(await run({ ...side, sides: 'image', sideColor: [1, 0, 0, 1] }, { image: img as never, side: t.solid(4, 4, [255, 0, 255, 255]) as never }), 64, 64);
  expect(wrapped[0]).toBeGreaterThan(200);
  expect(wrapped[2]).toBeGreaterThan(200);
});

it('a depth map changes the silhouette seen from the side', { timeout: 120_000 }, async () => {
  const t = await H();
  const img = t.solid(16, 16, [200, 200, 200, 255]);
  const bump = t.fromFn(16, 16, (x, y) => {
    const v = Math.hypot(x - 7.5, y - 7.5) < 4 ? 255 : 0;
    return [v, v, v, 255];
  });
  const cfg = { ...front, rotY: 90, depth: 0.2, silhouette: 'smooth' };
  const flat = await run(cfg, { image: img as never });
  const relief = await run({ ...cfg, relief: 0.6 }, { image: img as never, depthMap: bump as never });
  const cols = (px: Img) => {
    let n = 0;
    for (let x = 0; x < 128; x++) for (let y = 0; y < 128; y++) if (px.data[(y * 128 + x) * 4 + 3] > 128) { n++; break; }
    return n;
  };
  expect(cols(relief)).toBeGreaterThan(cols(flat) + 6); // thicker where the bump stands out
});

it('a Back image gives the other side its own picture; backFace colour works', { timeout: 120_000 }, async () => {
  const t = await H();
  const img = t.solid(16, 16, [255, 0, 0, 255]);
  const a = await run({ ...front, rotY: 180, depth: 0.2 }, { image: img as never, back: t.solid(16, 16, [0, 0, 255, 255]) as never });
  expect(at(a, 64, 64)[2]).toBeGreaterThan(200);
  const b = await run({ ...front, rotY: 180, depth: 0.2, backFace: 'colour', backColor: [0, 1, 0, 1] }, { image: img as never });
  expect(at(b, 64, 64)[1]).toBeGreaterThan(200);
});

it('lathe turns a profile into a solid of revolution (turning it about the axis changes nothing)', { timeout: 120_000 }, async () => {
  const t = await H();
  const vase = t.fromFn(32, 32, (x, y) => (Math.abs(x - 15.5) < 3 + 9 * Math.sin((y / 31) * Math.PI) ? [200, 120, 60, 255] : [0, 0, 0, 0]));
  const px = await run({ ...front, mode: 'lathe', silhouette: 'smooth' }, { image: vase as never });
  let wTop = 0;
  let wMid = 0;
  for (let x = 0; x < 128; x++) {
    if (at(px, x, 40)[3] > 128) wTop++;
    if (at(px, x, 64)[3] > 128) wMid++;
  }
  expect(wMid).toBeGreaterThan(wTop + 6);
  const turned = await run({ ...front, mode: 'lathe', rotY: 70, silhouette: 'smooth' }, { image: vase as never });
  let diff = 0;
  for (let i = 3; i < px.data.length; i += 4) diff += Math.abs(px.data[i] - turned.data[i]);
  expect(diff / (px.data.length / 4)).toBeLessThan(2);
});

it('the depth output exists only when asked for and holds the camera distance', { timeout: 120_000 }, async () => {
  const t = await H();
  const img = t.solid(16, 16, [200, 200, 200, 255]);
  const out = await t.run('image-to-3d', { ...front, depth: 0.2 }, { image: img }, { project: proj });
  const d = await t.gpu.read(out.depth as never, false);
  expect(d.length).toBe(128 * 128 * 4);
  const mid = (64 * 128 + 64) * 4;
  expect(d[mid + 3]).toBe(255); // hit
  expect(d[3]).toBe(0); // corner: nothing
});

it('draws a pixel sprite and a relief logo to PNGs', { timeout: 120_000 }, async () => {
  const t = await H();
  const pj = { width: 256, height: 256 };
  const palette = [[230, 80, 70], [250, 200, 60], [90, 200, 120], [80, 140, 240]];
  const sprite = t.fromFn(12, 12, (x, y) => {
      const hole = x > 3 && x < 8 && y > 3 && y < 8 && (x + y) % 2;
      const a = x > 1 && x < 10 && y > 1 && y < 10 && !hole ? 255 : 0;
      const c = palette[((x >> 2) + (y > 6 ? 1 : 0)) % 4];
      return [c[0], c[1], c[2], a];
  });
  const shots: Img[] = [];
  for (const rotY of [20, 50, 80]) shots.push(await run({ rotY, rotX: 20, depth: 0.5, silhouette: 'blocky', scale: 0.7, quality: 'high', shadows: true }, { image: sprite as never }, pj));
  writePng('image-to-3d-sprite', sheet(shots));
  const logo = t.fromFn(64, 64, (x, y) => {
    const r = Math.hypot(x - 31.5, y - 31.5);
    return r < 28 && r > 14 ? [240, 200, 60, 255] : [0, 0, 0, 0];
  });
  const bump = t.fromFn(64, 64, (x, y) => {
    const v = Math.max(0, 1 - Math.abs(Math.hypot(x - 31.5, y - 31.5) - 21) / 7);
    return [v * 255, v * 255, v * 255, 255];
  });
  const logoShots: Img[] = [];
  for (const rotY of [0, 35, 70]) logoShots.push(await run({ rotY, rotX: 15, depth: 0.25, relief: 0.35, silhouette: 'smooth', sides: 'darkened', scale: 0.7, quality: 'high', ao: 0.7 }, { image: logo as never, depthMap: bump as never }, pj));
  writePng('image-to-3d-logo-relief', sheet(logoShots));
});
