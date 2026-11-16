import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 128, height: 128 };
// orthographic, front view: 32 px per scene unit, origin at pixel (64, 64), y up
const base = { rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.5, ambient: 1, specular: 0, ao: 0, x1: -0.5, x2: 0.55 };
const draw = async (params: Record<string, unknown>, inputs: Record<string, never> = {}, project = proj) => {
  const t = await H();
  return t.pixels((await t.run('sdf-3d', { ...base, ...params }, inputs, { project })).image as never);
};
const alpha = (px: Img, x: number, y: number) => px.data[(y * px.width + x) * 4 + 3];
const T = { timeout: 120_000 };

it('smooth union differs from hard union: the neck between two spheres fills in', T, async () => {
  // sphere 1 at x -0.5 (r .55), sphere 2 at x .55 (r .5): the valley sits at x ~ 0.03, above the touching point
  const hard = await draw({ smooth2: 0.0, gooey: 1 });
  const soft = await draw({ smooth2: 0.8 });
  const gx = 64 + 1; // valley column
  let hardTop = 0;
  let softTop = 0;
  for (let y = 0; y < 128; y++) {
    if (!hardTop && alpha(hard, gx, y) > 128) hardTop = y;
    if (!softTop && alpha(soft, gx, y) > 128) softTop = y;
  }
  expect(hardTop).toBeGreaterThan(0);
  expect(softTop).toBeLessThan(hardTop - 3); // the blend rises into the valley
  // gooeyness scales the blend: gooey 0 = hard again
  const nogoo = await draw({ smooth2: 0.8, gooey: 0 });
  let nTop = 0;
  for (let y = 0; y < 128 && !nTop; y++) if (alpha(nogoo, gx, y) > 128) nTop = y;
  expect(Math.abs(nTop - hardTop)).toBeLessThanOrEqual(1);
});

it('subtract cuts a hole; intersect keeps only the overlap', T, async () => {
  const cut = await draw({ x1: 0, x2: 0, size1: 0.9, size2: 0.4, op2: 'subtract', smooth2: 0 });
  // the cutter is a sphere in the middle: seen from the front its far side stays, so cut a cylinder through
  const cyl = await draw({ x1: 0, size1: 0.9, shape2: 'cylinder', x2: 0, rx2: 90, size2: 0.3, sizeB2: 2, op2: 'subtract', smooth2: 0 });
  expect(alpha(cyl, 64, 64)).toBe(0); // a tunnel along the view axis
  expect(alpha(cyl, 64 + 20, 64)).toBe(255);
  expect(alpha(cut, 64 + 20, 64)).toBe(255);
  const inter = await draw({ x1: -0.3, x2: 0.3, size1: 0.6, size2: 0.6, op2: 'intersect', smooth2: 0 });
  expect(alpha(inter, 64 - 15, 64)).toBe(0); // only the lens in the middle
  expect(alpha(inter, 64, 64)).toBe(255);
});

it('changing a number never compiles a new shader', T, async () => {
  const t = await H();
  await draw({});
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const v of [0.2, 0.9, 1.4]) {
    await draw({ x1: -v, size2: v / 2 + 0.1, smooth2: v / 2, color1: [v / 2, 0.2, 0.3, 1], gooey: v, rotY: v * 40, lightAzimuth: v * 30 });
  }
  expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  // deform amounts: the first non-zero value switches the feature on (one shader), moving between non-zero values does not compile
  await draw({ dNoise: 0.05 });
  const mid = t.gpu.stats().objects.pipelinesCreated;
  for (const v of [0.1, 0.17, 0.3]) await draw({ dNoise: v, dNoiseScale: v * 5, dTwist: 0 });
  await draw({ dTwist: 20 });
  const mid2 = t.gpu.stats().objects.pipelinesCreated;
  for (const v of [30, 90, 200]) await draw({ dTwist: v });
  expect(t.gpu.stats().objects.pipelinesCreated - mid2).toBe(0);
  expect(mid2 - mid).toBeGreaterThan(0);
});

it('morph A to B moves between the two shapes', T, async () => {
  const a = await draw({ morph: true, morphAmount: 0, shape1: 'sphere', size1: 0.8, x1: 0, shape2: 'box', size2: 0.6, sizeB2: 0.6, sizeC2: 0.6, x2: 0 });
  const b = await draw({ morph: true, morphAmount: 1, shape1: 'sphere', size1: 0.8, x1: 0, shape2: 'box', size2: 0.6, sizeB2: 0.6, sizeC2: 0.6, x2: 0 });
  const half = await draw({ morph: true, morphAmount: 0.5, shape1: 'sphere', size1: 0.8, x1: 0, shape2: 'box', size2: 0.6, sizeB2: 0.6, sizeC2: 0.6, x2: 0 });
  // sphere radius .8 = 25.6 px; box half .6 = 19.2 px: at the corner direction the sphere reaches further (diagonal 18 px each axis)
  const corner = (px: Img) => alpha(px, 64 + 22, 64 + 10);
  expect(corner(a)).toBeGreaterThan(corner(b));
  expect(corner(half)).toBeGreaterThanOrEqual(corner(b));
  expect(corner(half)).toBeLessThanOrEqual(corner(a));
  expect(alpha(a, 64 + 24, 64)).toBe(255);
  expect(alpha(b, 64 + 24, 64)).toBe(0);
});

it('repeat makes endless copies; mirror and kaleidoscope duplicate', T, async () => {
  const one = await draw({ x1: 0, shape2: 'off', size1: 0.3 });
  expect(alpha(one, 64 + 48, 64)).toBe(0);
  const rep = await draw({ x1: 0, shape2: 'off', size1: 0.3, repeatX: true, repeatSpacing: 1.5 });
  expect(alpha(rep, 64 + 48, 64), 'repeat').toBe(255); // a copy 1.5 units = 48 px away
  const mir = await draw({ x1: 0.8, shape2: 'off', size1: 0.3, mirrorX: true });
  expect(alpha(mir, 64 - 26, 64), 'mirror').toBe(255);
  const kal = await draw({ x1: 0.8, shape2: 'off', size1: 0.2, fold: 4, rotX: 90 });
  expect(alpha(kal, 64, 64 - 26) + alpha(kal, 64, 64 + 26)).toBeGreaterThan(200);
});

it('a 2D picture input becomes an extruded SDF shape: a ring has a hole', T, async () => {
  const t = await H();
  const ring = t.fromFn(48, 48, (x, y) => {
    const r = Math.hypot(x - 23.5, y - 23.5);
    return r < 21 && r > 10 ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
  const px = await draw({ shape1: 'image2d', x1: 0, size1: 1, sizeB1: 0.3, shape2: 'off' }, { shape2d: ring as never });
  expect(alpha(px, 64, 64)).toBe(0); // hole
  expect(alpha(px, 64 + 22, 64)).toBe(255); // ring body: radius ~0.67 units = 21 px
  expect(alpha(px, 64 + 40, 64)).toBe(0);
  // and it blends smoothly with a primitive
  const withBall = await draw({ shape1: 'image2d', x1: 0, size1: 1, sizeB1: 0.3, shape2: 'sphere', x2: 0, size2: 0.35, smooth2: 0.3 }, { shape2d: ring as never });
  expect(alpha(withBall, 64, 64)).toBe(255);
});

it('a Texture input shows on the surface (triplanar)', T, async () => {
  const t = await H();
  const red = t.solid(8, 8, [255, 0, 0, 255]);
  const plain = await draw({ shape2: 'off', x1: 0, color1: [1, 1, 1, 1] });
  const textured = await draw({ shape2: 'off', x1: 0, color1: [1, 1, 1, 1] }, { texture: red as never });
  const i = (64 * 128 + 64) * 4;
  expect(plain.data[i + 1]).toBeGreaterThan(200);
  expect(textured.data[i + 1]).toBeLessThan(40);
  expect(textured.data[i]).toBeGreaterThan(200);
});

it('noise displacement moves the surface, loops in whole cycles and deform off is the same picture', T, async () => {
  const t = await H();
  const still = await draw({ shape2: 'off', x1: 0, size1: 0.8 });
  const noisy = await draw({ shape2: 'off', x1: 0, size1: 0.8, dNoise: 0.25, dNoiseScale: 2 });
  let diff = 0;
  for (let i = 3; i < still.data.length; i += 4) diff += Math.abs(still.data[i] - noisy.data[i]);
  expect(diff / (still.data.length / 4)).toBeGreaterThan(2);
  const r = await t.loopCheck('sdf-3d', { ...base, shape2: 'off', x1: 0, size1: 0.8, dNoise: 0.25, dNoiseCycles: 1 });
  expect(r.seam).toBeLessThan(0.05);
  expect(r.motion).toBeGreaterThan(0.2);
  const explicitOff = await draw({ shape2: 'off', x1: 0, size1: 0.8, dNoise: 0, dTwist: 0, dBend: 0, dMorph: 0 });
  expect(Buffer.from(explicitOff.data).equals(Buffer.from(still.data))).toBe(true);
});

it('depth output: wanted only when asked; encodes distance; draft and high quality render', T, async () => {
  const t = await H();
  const out = await t.run('sdf-3d', { ...base, shape2: 'off', x1: 0, size1: 0.8 }, {}, { project: proj });
  const d = await t.gpu.read(out.depth as never, false);
  const mid = (64 * 128 + 64) * 4;
  expect(d[mid + 3]).toBe(255);
  expect(d[3]).toBe(0);
  for (const quality of ['draft', 'high']) {
    const px = await draw({ shape2: 'off', x1: 0, size1: 0.8, quality });
    expect(alpha(px, 64, 64)).toBe(255);
    expect(alpha(px, 2, 2)).toBe(0);
  }
});

it('draws a blob morph at two phases and a displaced sphere to PNGs', T, async () => {
  const pj = { width: 256, height: 256 };
  const cfg = { rotX: 10, rotY: 20, cameraType: 'perspective', scale: 0.7, cel: false, ao: 0.6, shadows: true, quality: 'high', ambient: 0.3, specular: 0.5, x1: -0.7, x2: 0.7, size1: 0.6, size2: 0.55 };
  const shots: Img[] = [];
  for (const ph of [0, 0.5, 1]) shots.push(await draw({ ...cfg, shape3: 'sphere', x3: 0, y3: 0.9 * Math.sin(ph * 3), size3: 0.4, smooth3: 0.8, color3: [0.4, 1, 0.6, 1], smooth2: 0.7 }, {}, pj));
  writePng('sdf-blob-morph', sheet(shots));
  const shots2: Img[] = [];
  for (const d of [{}, { dNoise: 0.18, dNoiseScale: 2.5 }, { dTwist: 90, dTaper: 0.5, dMelt: 0.4 }, { dExplode: 0.5 }]) {
    shots2.push(await draw({ ...cfg, shape1: 'sphere', x1: 0, size1: 0.9, shape2: 'off', quality: 'high', ...d }, {}, pj));
  }
  writePng('sdf-displaced-sphere', sheet(shots2));
  const mat = await draw({ ...cfg, shape1: 'rbox', x1: 0, size1: 0.35, sizeB1: 0.35, sizeC1: 0.35, shape2: 'off', repeatX: true, repeatY: true, repeatSpacing: 1.3, rotX: 0, rotY: 0, shadows: false, cameraType: 'perspective', quality: 'normal' }, {}, pj);
  writePng('sdf-repeat', mat);
});
