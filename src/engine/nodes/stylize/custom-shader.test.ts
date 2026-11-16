import { expect, it } from 'vitest';
import { SHADER_EXAMPLES } from '../../lib/shader-examples';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';
import { savePreview } from '../../lib/util-preview';

const project = { width: 64, height: 48, fps: 10, duration: 2, loop: true };

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

it('the default code compiles and renders a canvas-sized opaque picture without an input', async () => {
  const t = await harness();
  const out = (await t.run('custom-shader', {}, {}, { project })).image as ImageValue;
  expect([out.width, out.height]).toEqual([64, 48]);
  const px = await t.pixels(out);
  expect(px.at(32, 24)[3]).toBe(255);
  const distinct = new Set<number>();
  for (let i = 0; i < px.data.length; i += 4) distinct.add(px.data[i + 1]);
  expect(distinct.size).toBeGreaterThan(20);
  await savePreview('custom-shader-default', px);
});

it('with an input the picture is processed and keeps its size and alpha', async () => {
  const t = await harness();
  const src = t.fromFn(40, 30, (x, y) => (x < 20 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
  const out = (await t.run('custom-shader', { b: 1 }, { image: src }, { project })).image as ImageValue;
  expect([out.width, out.height]).toEqual([40, 30]);
  const px = await t.pixels(out);
  expect(px.at(30, 10)[3]).toBe(0);
  expect(px.at(5, 10)[3]).toBe(255);
});

it('every example compiles with and without an input, and with Image 2 wired', async () => {
  const t = await harness();
  const scene = t.scene(96, 72);
  for (const ex of SHADER_EXAMPLES) {
    const a = await t.run('custom-shader', { code: ex.code }, {}, { project });
    expect((a.image as ImageValue).width, ex.label).toBe(64);
    const b = await t.run('custom-shader', { code: ex.code }, { image: scene, image2: scene }, { project });
    expect((b.image as ImageValue).width, ex.label).toBe(96);
  }
  // a gallery of the examples applied to the test scene, for a human to look at
  const rows = [];
  for (const ex of SHADER_EXAMPLES) rows.push(await t.pixels((await t.run('custom-shader', { code: ex.code }, { image: scene }, { project })).image as ImageValue));
  await savePreview('custom-shader-examples', rows, 4, 2);
});

it('a mistake reports the line number of the USER code (body form and full-function form)', async () => {
  const t = await harness();
  const body = 'let x = 1.0;\nlet y = x + 2.0;\nlet z = nonsense(y);\nreturn vec4f(z);';
  const msg = await rejects(() => t.run('custom-shader', { code: body }, {}, { project }));
  expect(msg).toMatch(/line 3\b/);
  expect(msg).toMatch(/nonsense/);
  // same error again (e.g. a slider moved on the broken shader) still shows it
  const again = await rejects(() => t.run('custom-shader', { code: body, a: 0.9 }, {}, { project }));
  expect(again).toMatch(/line 3\b/);
  const full = 'fn helper(x: f32) -> f32 {\n  return x * 2.0;\n}\n\nfn fx(uv: vec2f, px: vec2f) -> vec4f {\n  let q = helper(uv.x) + ;\n  return vec4f(q);\n}';
  const msg2 = await rejects(() => t.run('custom-shader', { code: full }, {}, { project }));
  expect(msg2).toMatch(/line 6\b/);
  // with an input wired (extra texture declaration) the mapping is the same
  const msg3 = await rejects(() => t.run('custom-shader', { code: body }, { image: t.solid(8, 8, [1, 2, 3, 255]) }, { project }));
  expect(msg3).toMatch(/line 3\b/);
  // a missing return is explained, not a crash
  const msg4 = await rejects(() => t.run('custom-shader', { code: 'let x = 1.0;' }, {}, { project }));
  expect(msg4).toMatch(/Shader error/);
});

it('slider a changes the pixels', async () => {
  const t = await harness();
  const lo = await t.pixels((await t.run('custom-shader', { a: 0 }, {}, { project })).image as ImageValue);
  const hi = await t.pixels((await t.run('custom-shader', { a: 1 }, {}, { project })).image as ImageValue);
  expect(Buffer.from(lo.data).equals(Buffer.from(hi.data))).toBe(false);
  // wired number socket works the same as the slider
  const wired = await t.pixels((await t.run('custom-shader', {}, { a: 1 }, { project })).image as ImageValue);
  expect(Buffer.from(wired.data).equals(Buffer.from(hi.data))).toBe(true);
});

it('u.color reaches the shader', async () => {
  const t = await harness();
  const out = await t.pixels((await t.run('custom-shader', { code: 'return vec4f(u.color.rgb, 1.0);', color: [1, 0, 0, 1] }, {}, { project })).image as ImageValue);
  expect(out.at(10, 10)).toEqual([255, 0, 0, 255]);
});

it('the default animation loops: phase 0 equals phase 1, and it moves in between', async () => {
  const t = await harness();
  const r = await t.loopCheck('custom-shader', {});
  expect(r.seam).toBe(0);
  expect(r.motion).toBeGreaterThan(0.3);
  // a shader that does not use the clock is static (and not re-rendered per frame)
  const still = await t.loopCheck('custom-shader', { code: 'return vec4f(uv, 0.0, 1.0);' });
  expect(still.motion).toBe(0);
});

it('u.time exposes seconds', async () => {
  const t = await harness();
  const code = 'return vec4f(vec3f(u.time * 0.25), 1.0);';
  const at0 = await t.pixels((await t.run('custom-shader', { code }, {}, { project, seconds: 0 })).image as ImageValue);
  const at2 = await t.pixels((await t.run('custom-shader', { code }, {}, { project, seconds: 2 })).image as ImageValue);
  expect(at0.at(5, 5)[0]).toBe(0);
  expect(at2.at(5, 5)[0]).toBeGreaterThan(110);
});

it('empty code passes the input through; mask and mix apply', async () => {
  const t = await harness();
  const src = t.solid(16, 16, [10, 20, 30, 255]);
  const same = await t.pixels((await t.run('custom-shader', { code: '  ' }, { image: src }, { project })).image as ImageValue);
  expect(same.at(3, 3)).toEqual([10, 20, 30, 255]);
  const half = await t.pixels((await t.run('custom-shader', { code: 'return vec4f(1.0);', mix: 0.5 }, { image: src }, { project })).image as ImageValue);
  expect(half.at(3, 3)[0]).toBeGreaterThan(110);
  expect(half.at(3, 3)[0]).toBeLessThan(150);
});

it('own helper functions and Image 2 work', async () => {
  const t = await harness();
  const code = 'fn fx(uv: vec2f, px: vec2f) -> vec4f {\n  return src2(uv);\n}';
  const out = await t.pixels((await t.run('custom-shader', { code }, { image: t.solid(8, 8, [255, 0, 0, 255]), image2: t.solid(8, 8, [0, 0, 255, 255]) }, { project })).image as ImageValue);
  expect(out.at(4, 4)).toEqual([0, 0, 255, 255]);
});
