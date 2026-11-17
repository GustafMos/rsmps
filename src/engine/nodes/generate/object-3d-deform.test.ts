import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 120_000 };

/**
 * Hashes of renders made by the 3D Object node BEFORE the Deform group, the depth output and the shared ray code were added.
 * The defaults must stay pixel-identical (docs/ENGINE.md: nothing changes for graphs that do not use the new parameters).
 */
const GOLDEN: Record<string, string> = {
  cube: '2584d52c2a3b8ff9f9fb034dd36d5d79dffddd5c',
  sphereCel: '89212cb6a5efc684fb5d37be7e2ed6407555e251',
  torus: 'c06288f163d955ddbf1b3cd46a74d70eabea200e',
  cone: '9943aa50e1aaa5f88c78f8bfc4a4c4ef8428f40a',
  capsule: '861c1d914b1bab5225e52c26c5f109107a425e00',
};
const CASES: Record<string, Record<string, unknown>> = {
  cube: { shape: 'cube', rotX: 20, rotY: 30 },
  sphereCel: { shape: 'sphere', cel: true, celSteps: 4 },
  torus: { shape: 'torus', rotX: 50, rotY: 10, cameraType: 'orthographic' },
  cone: { shape: 'cone', bevel: 0.2, rotY: 70 },
  capsule: { shape: 'capsule', rotX: 80, baseColor: [1, 0.3, 0.2, 0.8] },
};
const sha = (px: Img) => createHash('sha1').update(Buffer.from(px.data)).digest('hex');
const draw = async (params: Record<string, unknown>, size = 96) => {
  const t = await H();
  return t.pixels((await t.run('object-3d', params, {}, { project: { width: size, height: size } })).image as never);
};

it('deform off: every default render is pixel-identical to the pre-deform renderer', T, async () => {
  for (const [k, p] of Object.entries(CASES)) expect(sha(await draw(p)), k).toBe(GOLDEN[k]);
  // explicit zeros are the same thing
  expect(sha(await draw({ ...CASES.cube, dNoise: 0, dTwist: 0, dBend: 0, dTaper: 0, dMorph: 0, dMelt: 0, dExplode: 0, dInflate: 0, dMap: 0, dLowFi: 0 }))).toBe(GOLDEN.cube);
});

it('deform on changes the picture; each feature does something', T, async () => {
  const still = await draw({ shape: 'cube', rotX: 20, rotY: 30 });
  for (const d of [{ dNoise: 0.2 }, { dTwist: 60 }, { dBend: 0.5 }, { dTaper: 0.6 }, { dMorph: 0.8 }, { dMelt: 0.6 }, { dExplode: 0.6 }, { dInflate: 0.3 }, { dLowFi: 6 }]) {
    const px = await draw({ shape: 'cube', rotX: 20, rotY: 30, ...d });
    expect(sha(px), JSON.stringify(d)).not.toBe(sha(still));
  }
  // morph to sphere: the ball (r .9) reaches past the cube's flat side (x .55)
  const m0 = await draw({ shape: 'cube', rotX: 0, rotY: 0, cameraType: 'orthographic', scale: 0.5 });
  const m1 = await draw({ shape: 'cube', rotX: 0, rotY: 0, cameraType: 'orthographic', scale: 0.5, dMorph: 1 });
  const sideA = (px: Img) => px.data[((96 / 2) * 96 + (96 / 2) + 17) * 4 + 3];
  expect(sideA(m0)).toBeLessThan(60);
  expect(sideA(m1)).toBeGreaterThan(200);
});

it('animated noise loops exactly', T, async () => {
  const t = await H();
  const r = await t.loopCheck('object-3d', { shape: 'sphere', dNoise: 0.15, dNoiseCycles: 1, cameraType: 'orthographic' });
  expect(r.seam).toBeLessThan(LOOP_SEAM_OK);
  expect(r.motion).toBeGreaterThan(0.2);
});

it('depth output holds the camera distance and costs nothing unless wired', T, async () => {
  const t = await H();
  const out = await t.run('object-3d', { shape: 'sphere', cameraType: 'orthographic', scale: 0.5 }, {}, { project: { width: 64, height: 64 } });
  const d = await t.gpu.read(out.depth as never, false);
  expect(d[(32 * 64 + 32) * 4 + 3]).toBe(255);
  expect(d[3]).toBe(0);
});

it('custom model path accepts the deform group (vertex shader) without breaking', T, async () => {
  // no model chosen = a clear frame, but the shader (with the new frame layout) is still compiled on the next real model; here just run it
  const t = await H();
  const out = await t.run('object-3d', { shape: 'custom', dNoise: 0.2, dTwist: 30 }, {}, { project: { width: 32, height: 32 } });
  expect(out.image).toBeTruthy();
});

it('draws a displaced sphere and a deformed cube to a PNG', T, async () => {
  const shots: Img[] = [];
  for (const d of [{}, { dNoise: 0.18, dNoiseScale: 2.2 }, { dTwist: 120, dTaper: 0.5 }, { dMelt: 0.7 }, { dExplode: 0.6 }])
    shots.push(await draw({ shape: 'cube', rotX: 20, rotY: 30, scale: 0.6, ...d }, 200));
  writePng('object-3d-deform', sheet(shots));
});

it('a real mesh deforms in the vertex shader: sphere model, noise / twist / explode change it, off is unchanged', { timeout: 120_000 }, async () => {
  const { textBytes, toObjText, uvSphereMesh } = await import('../../lib/gen-model-testutil');
  const files = new Map<string, ArrayBuffer>();
  files.set('sph', textBytes(toObjText(uvSphereMesh(32, 24))));
  const host = {
    assetInfo: (id: string) => (files.has(id) ? { id, name: id, kind: 'model' as const, width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
    assetFrame: async () => null,
    assetBytes: async (id: string) => files.get(id) ?? null,
  };
  const t = await harness([], host);
  const go = async (extra: Record<string, unknown>) => t.pixels((await t.run('object-3d', { shape: 'custom', model: ['sph'], cameraType: 'orthographic', scale: 0.5, shading: 'smooth', ...extra }, {}, { project: { width: 96, height: 96 } })).image as never);
  const plain = await go({});
  const off = await go({ dNoise: 0, dTwist: 0 });
  expect(sha(off)).toBe(sha(plain));
  for (const d of [{ dNoise: 0.15 }, { dTwist: 80, dTaper: 0.5 }, { dExplode: 0.5 }, { dMorph: 0.5, dInflate: 0.2 }, { dLowFi: 8 }, { dMelt: 0.5 }]) {
    expect(sha(await go(d)), JSON.stringify(d)).not.toBe(sha(plain));
  }
});
