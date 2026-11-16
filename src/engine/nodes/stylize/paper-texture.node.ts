import { defineNode } from '../../define';
import { wholeCyclePoses } from '../../lib/boil';
import { loopFrame } from '../../lib/fx-util';

export default defineNode({
  id: 'paper-texture',
  title: 'Paper / Texture Overlay',
  category: 'stylize',
  description:
    'Lays a scanned texture (paper, tape, scribbles, pencil shading) over the picture: multiply, screen or overlay, with scale and an optional hand-made "boil" that shifts the texture a little on every frame and repeats in whole cycles so the loop stays seamless. Pick a texture from your scanned-texture shelf or wire an image.',
  keywords: ['texture', 'paper', 'grain', 'scan', 'boil', 'hand made', 'overlay', 'multiply', 'tape', 'scribble', 'flicker', 'shelf'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    texture: { type: 'image', label: 'Texture' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    assets: { type: 'assets', default: [], accept: 'image-video', label: 'Library texture', hint: 'Choose a scanned texture (Scan tab, "Scan a texture" saves to your Textures shelf). A wired Texture input wins.' },
    blend: {
      type: 'enum',
      default: 'multiply',
      options: [
        { value: 'multiply', label: 'Multiply' },
        { value: 'screen', label: 'Screen' },
        { value: 'overlay', label: 'Overlay' },
      ],
      label: 'Blend',
    },
    amount: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Amount' },
    scale: { type: 'number', default: 1, min: 0.1, max: 8, softMax: 4, step: 0.01, label: 'Scale', hint: '1 = the texture covers the frame once. Above 1 it repeats (smaller); below 1 it is enlarged.' },
    offset: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.001, label: 'Offset' },
    boil: { type: 'number', default: 0, min: 0, max: 0.2, step: 0.001, label: 'Boil', group: 'Boil', hint: 'How far (as a fraction of the texture) it shifts between poses. 0 = still.' },
    boilPoses: { type: 'number', default: 3, min: 2, max: 12, step: 1, integer: true, label: 'Poses', group: 'Boil', hint: 'Different positions before it repeats. The count is reduced to a divisor of the project length, so the loop is whole cycles.', visibleIf: (p) => (p.boil as number) > 0 },
    boilHold: { type: 'number', default: 1, min: 1, max: 12, step: 1, integer: true, label: 'Change every N', group: 'Boil', visibleIf: (p) => (p.boil as number) > 0 },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Boil', visibleIf: (p) => (p.boil as number) > 0 },
  },
  summary: (p) => `${p.blend} · ${Math.round(p.amount * 100)}%${p.boil > 0 ? ` · boil ${p.boilPoses}` : ''}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (p.amount <= 0) return { image: src };
    let tex = ctx.in.texture as { texture: GPUTexture; width: number; height: number } | null;
    if (!tex && p.assets.length > 0) {
      const info = ctx.host.assetInfo(p.assets[0]);
      if (!info) throw new Error('The texture is missing from the library. Choose it again.');
      const frame = await ctx.host.assetFrame(p.assets[0], 0, 2048);
      if (!frame) throw new Error(`Could not decode "${info.name}".`);
      tex = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) } as never;
    }
    if (!tex) return { image: src };
    // pose of the boil: depends only on (frame mod poses), so the pattern repeats exactly; read the clock only when boiling
    let pose = 0;
    if (p.boil > 0) {
      const total = Math.max(1, Math.round(ctx.time.duration * ctx.time.fps));
      const poses = wholeCyclePoses(total, p.boilPoses);
      pose = Math.floor(loopFrame(ctx.time, p.boilHold) / p.boilHold) % poses;
    }
    const ca = src.width / src.height;
    const ta = tex.width / tex.height;
    const image = ctx.gpu.pass({
      label: 'paper-texture',
      size: src,
      textures: { src, tex: tex as never },
      uniforms: {
        amount: p.amount,
        mode: p.blend === 'multiply' ? 0 : p.blend === 'screen' ? 1 : 2,
        vis: [ca >= ta ? 1 : ca / ta, ca >= ta ? ta / ca : 1],
        scale: p.scale,
        off: [p.offset[0], p.offset[1]],
        boil: p.boil,
        pose,
        seed: p.seed * 7.13,
      },
      wgsl: /* wgsl */ `
fn jit(pose: f32) -> vec2f {
  return vec2f(hash31(vec3f(pose, u.seed, 1.7)), hash31(vec3f(pose + 3.1, u.seed, 9.2))) * 2.0 - 1.0;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  var o = u.off;
  if (u.boil > 0.0) { o += jit(u.pose) * u.boil; }
  let tuv = fract((uv - 0.5) * u.vis * u.scale + 0.5 + o);
  let t = textureSampleLevel(tex, smp, tuv, 0.0).rgb;
  let c = s.rgb;
  var r = c * mix(vec3f(1.0), t, u.amount);
  if (u.mode > 0.5 && u.mode < 1.5) {
    r = vec3f(1.0) - (vec3f(1.0) - c) * (vec3f(1.0) - t * u.amount);
  } else if (u.mode > 1.5) {
    let lo = 2.0 * c * t;
    let hi = vec3f(1.0) - 2.0 * (vec3f(1.0) - c) * (vec3f(1.0) - t);
    r = mix(c, select(hi, lo, c < vec3f(0.5)), u.amount);
  }
  return premul(vec4f(clamp(r, vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
