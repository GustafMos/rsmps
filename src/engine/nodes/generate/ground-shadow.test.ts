import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { sdfShape, sdfValue } from '../../lib/sdf-scene';
import { textBytes, toObjText, uvSphereMesh } from '../../lib/gen-model-testutil';
import type { CameraValue, Host, ImageValue } from '../../types';

/**
 * Ground shadow of the marched 3D nodes (SDF 3D, Scene Output of an SDF Scene, 3D Object primitives), on the real GPU.
 * Camera: orthographic from above and behind, (0, 10, -10) looking at the origin, 4 scene units across half the 128 px frame
 * (16 px per unit). Scene axes: x right; the screen's up axis is (0, .707, .707).
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 180_000 };
const proj = { width: 128, height: 128 };
const cam: CameraValue = { kind: 'camera', projection: 'orthographic', fov: 40, orthoSize: 8, position: [0, 10, -10], target: [0, 0, 0], roll: 0, shift: [0, 0] };
const S = Math.SQRT1_2;
/** Pixel of a scene point under that camera. */
const pix = (x: number, y: number, z: number): [number, number] => [Math.round(64 + 16 * x), Math.round(64 - 16 * (S * y + S * z))];
const px4 = (img: Img, x: number, y: number) => [0, 1, 2, 3].map((c) => img.data[(y * img.width + x) * 4 + c]);
const a = (img: Img, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
/** Pixels with alpha above `t` in the image. */
const count = (img: Img, t: number) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > t) n++;
  return n;
};
const light = (az: number, el = 45) => ({ lightAzimuth: az, lightElevation: el });

interface Case {
  name: string;
  /** Radius of the sphere and where its floor is by default (scene y). */
  r: number;
  floor: number;
  draw: (extra: Record<string, unknown>) => Promise<{ image: Img; depth: Img | null }>;
}

const sdf3d: Case = {
  name: 'sdf-3d',
  r: 0.55,
  floor: -0.55 * 1.02,
  draw: async (extra) => {
    const t = await H();
    const out = await t.run('sdf-3d', { shape1: 'sphere', x1: 0, size1: 0.55, shape2: 'off', ambient: 1, specular: 0, ao: 0, ...extra }, { camera: cam as never }, { project: proj });
    return { image: await t.pixels(out.image as ImageValue), depth: out.depth ? await t.pixels(out.depth as ImageValue) : null };
  },
};
const obj3d: Case = {
  name: 'object-3d',
  r: 0.95,
  floor: -0.95,
  draw: async (extra) => {
    const t = await H();
    const out = await t.run('object-3d', { shape: 'sphere', ambient: 1, specular: 0, ...extra }, { camera: cam as never }, { project: proj });
    return { image: await t.pixels(out.image as ImageValue), depth: out.depth ? await t.pixels(out.depth as ImageValue) : null };
  },
};
const sdfScene: Case = {
  name: 'sdf scene',
  r: 0.5,
  floor: -0.5 * 1.02,
  draw: async (extra) => {
    const t = await H();
    const out = await t.run('sdf-render', { ambient: 1, specular: 0, ao: 0, ...extra }, { scene: sdfValue(sdfShape('s', 'sphere', { size: [0.5, 0.5, 0.5], color: [0.5, 0.6, 0.9] })) as never, camera: cam as never }, { project: proj });
    return { image: await t.pixels(out.image as ImageValue), depth: out.depth ? await t.pixels(out.depth as ImageValue) : null };
  },
};
const files = new Map<string, ArrayBuffer>([['ball.obj', textBytes(toObjText(uvSphereMesh(32, 16, 1)))]]);
const modelHost: Host = {
  assetInfo: (id) => (files.has(id) ? { id, name: id, kind: 'model', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
  assetFrame: async () => null,
  assetBytes: async (id) => files.get(id) ?? null,
};
let modelShared: ReturnType<typeof harness> | null = null;
const model: Case = {
  name: 'object-3d custom model (projected shadow)',
  r: 0.95,
  floor: -0.95,
  draw: async (extra) => {
    const t = await (modelShared ??= harness([], modelHost));
    const out = await t.run('object-3d', { shape: 'custom', model: ['ball.obj'], ambient: 1, specular: 0, ...extra }, { camera: cam as never }, { project: proj });
    return { image: await t.pixels(out.image as ImageValue), depth: null };
  },
};

for (const c of [sdf3d, obj3d, sdfScene, model]) {
  describe(`ground shadow: ${c.name}`, () => {
    // light from the left (azimuth -90) at 45 degrees: the shadow of a sphere of radius r whose centre is h above the floor falls
    // to +x by h (L = (-.707, .707, 0): the centre of its shadow is at (h, floor, 0))
    const spot = (h: number): [number, number] => pix(h, c.floor - 0.8, 0);

    it('a sphere above the floor has a transparent-black shadow on the lower right, and none with the toggle off', T, async () => {
      const lowered = -0.8; // floor 0.8 under the sphere's bottom
      const h = -(c.floor + lowered); // centre height above the floor
      const on = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 0.1, groundHeight: lowered });
      const off = await c.draw({ ...light(-90), groundShadow: false, groundHeight: lowered });
      const [sx, sy] = spot(h);
      const p = px4(on.image, sx, sy);
      expect(p[3]).toBeGreaterThan(200); // dark and covering
      expect(p[0] + p[1] + p[2]).toBeLessThan(6); // black
      expect(a(off.image, sx, sy)).toBe(0);
      // the object is where it was, opaque in the middle
      expect(a(on.image, 64, 64)).toBe(255);
      // nothing on the far side and far away
      const [lx, ly] = pix(-h, c.floor + lowered, 0);
      expect(a(on.image, lx, ly)).toBe(0);
      expect(a(on.image, 5, 5)).toBe(0);
      expect(a(on.image, 122, 122)).toBe(0);
      // the toggle off leaves no pixel of shadow anywhere
      expect(count(off.image, 0)).toBeLessThan(count(on.image, 0));
    });

    it('strength scales the alpha, softness widens the penumbra', T, async () => {
      const lowered = -0.8;
      const h = -(c.floor + lowered);
      const [sx, sy] = spot(h);
      const full = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 0.1, groundHeight: lowered });
      const half = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 0.5, groundSoftness: 0.1, groundHeight: lowered });
      expect(a(half.image, sx, sy)).toBeGreaterThan(a(full.image, sx, sy) * 0.4);
      expect(a(half.image, sx, sy)).toBeLessThan(a(full.image, sx, sy) * 0.6);
      const sharp = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 0, groundHeight: lowered });
      const soft = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 1, groundHeight: lowered });
      // the soft shadow reaches further out than the sharp one (counting the faint rim), and is lighter in the middle
      expect(count(soft.image, 6)).toBeGreaterThan(count(sharp.image, 6) * 1.05);
      expect(a(soft.image, sx, sy)).toBeLessThanOrEqual(a(sharp.image, sx, sy));
    });

    it('moving the light moves the shadow; lifting the object separates it', T, async () => {
      const lowered = -0.8;
      const h = -(c.floor + lowered);
      const right = await c.draw({ ...light(90), groundShadow: true, groundStrength: 1, groundSoftness: 0.1, groundHeight: lowered });
      const [lx, ly] = pix(-h, c.floor + lowered, 0);
      expect(a(right.image, lx, ly)).toBeGreaterThan(200);
      const [sx, sy] = spot(h);
      expect(a(right.image, sx, sy)).toBe(0);
      // on the floor under the object (no lift) the shadow hugs the object; lifted it is a gap away
      const touching = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 0.1 });
      const lifted = await c.draw({ ...light(-90), groundShadow: true, groundStrength: 1, groundSoftness: 0.1, groundHeight: lowered });
      const centre = (img: Img) => {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          const v = a(img, x, y);
          if (v > 0 && v < 255) {
            sum += x * v;
            n += v;
          }
        }
        return sum / Math.max(1, n);
      };
      expect(centre(lifted.image)).toBeGreaterThan(centre(touching.image) + 4);
    });

    it('the depth output is the same with the shadow on and off', T, async () => {
      const on = await c.draw({ groundShadow: true, ...light(-90), groundHeight: -0.8 });
      const off = await c.draw({ groundShadow: false, ...light(-90), groundHeight: -0.8 });
      if (!on.depth || !off.depth) return; // the node has no depth output in this harness
      expect(Buffer.from(on.depth.data).equals(Buffer.from(off.depth.data))).toBe(true);
    });
  });
}

it('the toggle selects a shader variant; changing the numbers (strength, softness, height, light) compiles nothing', T, async () => {
  const t = await H();
  for (const c of [sdf3d, obj3d, sdfScene]) {
    await c.draw({ groundShadow: true });
    const before = t.gpu.stats().objects.pipelinesCreated;
    for (const v of [0.2, 0.5, 0.9]) await c.draw({ groundShadow: true, groundStrength: v, groundSoftness: v, groundHeight: v - 0.7, lightAzimuth: v * 90, lightElevation: 20 + v * 40 });
    expect(t.gpu.stats().objects.pipelinesCreated - before, c.name).toBe(0);
    // off and on are different shaders: switching the toggle is allowed to compile once, and off is the shader old projects use
    const off0 = t.gpu.stats().objects.pipelinesCreated;
    await c.draw({ groundShadow: false });
    await c.draw({ groundShadow: false, lightAzimuth: 12 });
    expect(t.gpu.stats().objects.pipelinesCreated - off0).toBeLessThanOrEqual(1);
  }
});

it('writes a sample sheet of the shadow over a backdrop (for looking at)', T, async () => {
  const t = await H();
  const tm = await (modelShared ??= harness([], modelHost));
  const persp: CameraValue = { kind: 'camera', projection: 'perspective', fov: 35, orthoSize: 8, position: [0, 2.6, -6.5], target: [0, -0.4, 0], roll: 0, shift: [0, 0] };
  const proj2 = { width: 256, height: 256 };
  const backdrop = (image: Img): Img => {
    const out = new Uint8ClampedArray(image.data.length);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      // a photo-like floor: a warm gradient with some texture
      const v = 120 + 90 * (y / image.height) + 12 * Math.sin(x * 0.11) * Math.sin(y * 0.07) + ((x * 7 + y * 13) % 5);
      const al = image.data[i + 3] / 255;
      const bg = [v * 1.0, v * 0.92, v * 0.8];
      // the node's picture is straight RGBA here: composite over the backdrop
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(image.data[i + k] * al + bg[k] * (1 - al));
      out[i + 3] = 255;
    }
    return { data: out, width: image.width, height: image.height };
  };
  const tiles: Img[] = [];
  const common = { groundShadow: true, groundStrength: 0.75, groundSoftness: 0.4, ambient: 0.4, specular: 0.2 };
  for (const [az, el] of [[-55, 40], [60, 28]]) {
    const light = { lightAzimuth: az, lightElevation: el };
    const sdf = await t.run('sdf-3d', { ...common, ...light, shape1: 'torus', x1: 0, size1: 0.6, sizeB1: 0.25, color1: [0.9, 0.45, 0.2, 1], shape2: 'sphere', x2: 0, size2: 0.4, color2: [0.3, 0.6, 1, 1], smooth2: 0.1, rotX: 0, rotY: 0, ao: 0.5, shadows: true }, { camera: persp as never }, { project: proj2 });
    tiles.push(backdrop(await t.pixels(sdf.image as ImageValue)));
    const obj = await t.run('object-3d', { ...common, ...light, shape: 'torus', baseColor: [0.9, 0.5, 0.2, 1], rotX: 30, rotY: 20 }, { camera: persp as never }, { project: proj2 });
    tiles.push(backdrop(await t.pixels(obj.image as ImageValue)));
    const mdl = await tm.run('object-3d', { ...common, ...light, shape: 'custom', model: ['ball.obj'], baseColor: [0.3, 0.6, 1, 1], colorMode: 'override' }, { camera: persp as never }, { project: proj2 });
    tiles.push(backdrop(await tm.pixels(mdl.image as ImageValue)));
  }
  expect(tiles.length).toBe(6);
  writePng('arshadow-samples.png', sheet(tiles, 3), false);
});
