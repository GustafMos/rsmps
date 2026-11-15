import { defineNode } from '../../define';

export default defineNode({
  id: 'mask-invert',
  title: 'Invert Mask',
  category: 'mask',
  description: 'Swaps selected and unselected areas of a mask.',
  keywords: ['negate', 'flip', 'opposite'],
  inputs: { mask: { type: 'mask', required: true, label: 'Mask' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {},
  render(ctx) {
    const mask = ctx.gpu.passMask({
      label: 'mask-invert',
      size: ctx.in.mask,
      textures: { src: ctx.in.mask },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(vec3f(1.0 - textureSampleLevel(src, smpNearest, uv, 0.0).r), 1.0); }',
    });
    return { mask };
  },
});
