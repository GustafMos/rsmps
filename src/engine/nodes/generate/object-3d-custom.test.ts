import { expect, it } from 'vitest';
import { cubeMesh, textBytes, toObjText, uvSphereMesh } from '../../lib/gen-model-testutil';
import { savePreview } from '../../lib/util-preview';
import { harness } from '../../testing';
import type { Host, ImageValue } from '../../types';

const files = new Map<string, ArrayBuffer>();
const host: Host = {
  assetInfo: (id) => (files.has(id) ? { id, name: id, kind: 'model', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
  assetFrame: async () => null,
  assetBytes: async (id) => files.get(id) ?? null,
};
const project = { width: 64, height: 64, fps: 10, duration: 2, loop: true };
const opaque = (px: { data: Uint8ClampedArray }) => {
  let n = 0;
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 128) n++;
  return n;
};

it('the Shape list ends with "Custom model…"; primitives stay the default and the model file param only shows for it', async () => {
  const t = await harness([], host);
  const def = t.registry.get('object-3d')!;
  const shape = def.params.shape as { default: string; options: { value: string; label: string }[] };
  expect(shape.default).toBe('cube');
  expect(shape.options[shape.options.length - 1]).toEqual({ value: 'custom', label: 'Custom model…' });
  expect(def.params.model.visibleIf!({ shape: 'cube' })).toBe(false);
  expect(def.params.model.visibleIf!({ shape: 'custom' })).toBe(true);
  expect((def.params.model as { accept: string }).accept).toBe('model');
  expect(def.params.bevel.default).toBe(0); // sharp cubes by default
});

it('search words glb / gltf / obj / model find 3D Object; the legacy 3D Model node is hidden but still registered', async () => {
  const t = await harness([], host);
  const o = t.registry.get('object-3d')!;
  for (const word of ['glb', 'gltf', 'obj', 'model']) expect((o.keywords ?? []).join(' ')).toContain(word);
  expect(t.registry.get('model-3d')?.hidden).toBe(true);
  expect(o.hidden).toBeFalsy();
});

it('custom with no file: a clear frame and a helpful summary', async () => {
  const t = await harness([], host);
  const out = await t.run('object-3d', { shape: 'custom' }, {}, { project });
  const px = await t.pixels(out.image as ImageValue);
  expect(px.data.every((v) => v === 0)).toBe(true);
  expect(t.registry.get('object-3d')!.summary!({ ...Object.fromEntries(Object.entries(t.registry.get('object-3d')!.params).map(([k, v]) => [k, (v as { default: unknown }).default])), shape: 'custom' } as never)).toMatch(/no model chosen/);
});

it('custom with a small generated OBJ renders non-empty pixels, centred; a missing file is a readable error', async () => {
  const t = await harness([], host);
  files.set('cube.obj', textBytes(toObjText(cubeMesh(0.5))));
  const out = await t.run('object-3d', { shape: 'custom', model: ['cube.obj'], shading: 'smooth', colorMode: 'override', baseColor: [0.9, 0.3, 0.2, 1] }, {}, { project });
  const px = await t.pixels(out.image as ImageValue);
  expect(opaque(px)).toBeGreaterThan(300);
  expect(px.at(0, 0)[3]).toBe(0);
  expect(px.at(32, 32)[3]).toBe(255);
  expect(px.at(32, 32)[0]).toBeGreaterThan(px.at(32, 32)[2]);
  // the same node, back on a primitive, still gives the primitive
  const prim = await t.pixels((await t.run('object-3d', { shape: 'sphere' }, {}, { project })).image as ImageValue);
  expect(opaque(prim)).toBeGreaterThan(300);
  let msg = '';
  try {
    await t.run('object-3d', { shape: 'custom', model: ['nope'] }, {}, { project });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/file is missing/);
  files.set('sphere.obj', textBytes(toObjText(uvSphereMesh(16, 8, 1))));
  const sphere = await t.pixels((await t.run('object-3d', { shape: 'custom', model: ['sphere.obj'], cel: true, celSteps: 3 }, {}, { project })).image as ImageValue);
  await savePreview('object-3d-custom', [prim, px, sphere], 4, 3);
});

it('the legacy model-3d node still renders (shared renderer) and spin loops on the custom model', async () => {
  const t = await harness([], host);
  files.set('c', textBytes(toObjText(cubeMesh(0.5))));
  const legacy = await t.pixels((await t.run('model-3d', { model: ['c'] }, {}, { project })).image as ImageValue);
  expect(opaque(legacy)).toBeGreaterThan(200);
  const r = await t.loopCheck('object-3d', { shape: 'custom', model: ['c'], spinY: 1 });
  expect(r.seam).toBeLessThan(0.05);
  expect(r.motion).toBeGreaterThan(0.5);
});
