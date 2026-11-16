import { expect, it } from 'vitest';
import { harness } from '../../testing';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 64, height: 64 };
const base = { rotX: 0, rotY: 0, rotZ: 0, spinX: 0, spinY: 0, spinZ: 0, cameraType: 'orthographic', scale: 0.5, baseColor: [1, 1, 1, 1] };

async function draw(params: Record<string, unknown>) {
  const t = await H();
  return t.pixels((await t.run('object-3d', { ...base, ...params }, {}, { project: proj })).image as never);
}
const alphaAt = (px: { data: Uint8ClampedArray; width: number }, x: number, y: number) => px.data[(y * px.width + x) * 4 + 3];

it('every shape is drawn in the middle, with a transparent background', async () => {
  for (const shape of ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'pyramid', 'capsule', 'octahedron']) {
    const px = await draw({ shape, rotX: 20, rotY: 30 });
    let opaque = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 250) opaque++;
    expect(opaque, shape).toBeGreaterThan(80);
    expect(alphaAt(px, 0, 0), shape).toBe(0);
    expect(alphaAt(px, 63, 63), shape).toBe(0);
    if (shape !== 'torus') expect(alphaAt(px, 32, 32), shape).toBe(255);
  }
});

it('sphere has the expected radius and an antialiased edge (orthographic and perspective)', async () => {
  for (const cameraType of ['orthographic', 'perspective']) {
    const px = await draw({ shape: 'sphere', scale: 0.5, cameraType });
    // radius = 0.95 * 16 = 15.2 texels
    expect(alphaAt(px, 32 + 14, 32), cameraType).toBe(255);
    expect(alphaAt(px, 32 + 17, 32), cameraType).toBe(0);
    const edge = alphaAt(px, 32 + 15, 32);
    expect(edge, cameraType).toBeGreaterThan(40);
    expect(edge, cameraType).toBeLessThan(250);
  }
});

it('cube: a flat front face with square outline when not rotated', async () => {
  const px = await draw({ shape: 'cube', scale: 0.5 });
  // half width 0.55 * 16 = 8.8
  expect(alphaAt(px, 32 + 7, 32 + 7)).toBe(255);
  expect(alphaAt(px, 32 + 11, 32)).toBe(0);
  expect(alphaAt(px, 32, 32 - 11)).toBe(0);
  const rolled = await draw({ shape: 'cube', scale: 0.5, rotZ: 45 });
  expect(alphaAt(rolled, 32 + 10, 32)).toBe(255); // corner now points right
});

it('position and size move and scale the object', async () => {
  const t = await H();
  const px = await t.pixels((await t.run('object-3d', { ...base, shape: 'sphere', x: 0.25, y: 0.75, scale: 0.3 }, {}, { project: proj })).image as never);
  expect(alphaAt(px, 16, 48)).toBe(255);
  expect(alphaAt(px, 48, 16)).toBe(0);
  expect(alphaAt(px, 16 + 9, 48)).toBe(0);
});

it('lighting: the lit side is brighter than the shadow side; ambient lifts shadows; cel shading is banded', async () => {
  const lit = await draw({ shape: 'sphere', lightAzimuth: -60, lightElevation: 0, ambient: 0.1, specular: 0 });
  const left = lit.data[(32 * 64 + 24) * 4];
  const right = lit.data[(32 * 64 + 40) * 4];
  expect(left).toBeGreaterThan(right + 80);
  const amb = await draw({ shape: 'sphere', lightAzimuth: -60, lightElevation: 0, ambient: 0.6, specular: 0 });
  expect(amb.data[(32 * 64 + 40) * 4]).toBeGreaterThan(right + 60);
  const cel = await draw({ shape: 'sphere', cel: true, celSteps: 3, specular: 0 });
  const levels = new Set<number>();
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) if (cel.data[(y * 64 + x) * 4 + 3] === 255) levels.add(cel.data[(y * 64 + x) * 4]);
  expect(levels.size).toBeLessThanOrEqual(3);
  expect(levels.size).toBeGreaterThanOrEqual(2);
});

it('base colour tints the object and its alpha is kept', async () => {
  const px = await draw({ shape: 'sphere', baseColor: [1, 0, 0, 0.5], ambient: 1, specular: 0 });
  const i = (32 * 64 + 32) * 4;
  expect(px.data[i + 1]).toBeLessThan(10);
  expect(Math.abs(px.data[i + 3] - 128)).toBeLessThan(3);
});

it('spinning loops exactly (whole turns) and moves', async () => {
  const t = await H();
  const size = { size: t.solid(64, 64, [0, 0, 0, 255], 1) };
  for (const shape of ['cube', 'torus', 'pyramid']) {
    const r = await t.loopCheck('object-3d', { shape, spinY: 1, spinX: 2, cameraType: 'perspective' }, size);
    expect(r.seam, shape).toBeLessThan(0.05);
    expect(r.motion, shape).toBeGreaterThan(1);
  }
  const still = await t.loopCheck('object-3d', { spinY: 0 }, size);
  expect(still.motion).toBe(0);
});

it('bevel: default is a perfectly sharp cube corner; a bevel rounds it', async () => {
  // orthographic front view: the square spans 32 +- 8.8; the pixel at (40, 40) holds the corner
  const sharp = await draw({ shape: 'cube', scale: 0.5 });
  const soft = await draw({ shape: 'cube', scale: 0.5, bevel: 0.4 });
  expect(alphaAt(sharp, 40, 40)).toBeGreaterThan(130); // ~0.8 x 0.8 of the pixel is inside
  expect(alphaAt(soft, 40, 40)).toBeLessThan(50);
  expect(alphaAt(sharp, 40, 32)).toBe(255); // straight edge pixels are full
  expect(alphaAt(sharp, 32, 41)).toBe(0);
  // the face stays flat up to the edge: no shading ramp near the silhouette
  const i = (32 * 64 + 39) * 4;
  expect(Math.abs(sharp.data[i] - sharp.data[(32 * 64 + 32) * 4])).toBeLessThan(3);
});

it('every bevelled shape still renders, and bevel 0 differs from bevel 0.3', async () => {
  for (const shape of ['cube', 'cylinder', 'cone', 'pyramid', 'octahedron']) {
    const a = await draw({ shape, rotX: 20, rotY: 30 });
    const b = await draw({ shape, rotX: 20, rotY: 30, bevel: 0.3 });
    expect(alphaAt(b, 32, 32), shape).toBeGreaterThan(200);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data)), shape).toBe(false);
  }
});
