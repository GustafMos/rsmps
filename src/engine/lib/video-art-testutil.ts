import { defineNode } from '../define';
import type { AnyNodeDef } from '../types';

/**
 * Test-only sources for the video-art nodes (feedback, slit scan, optical flow, motion smear).
 * Each counts how often it really renders in `spy.n` (a pull-count probe).
 */

/** Transparent 32x32 picture with a bright square `size` wide whose left edge is at x = frame * speed (wraps at 32). */
export function movingSquareSource(id = 'va-square', spy: { n: number } = { n: 0 }, o: { size?: number; speed?: number; dim?: number } = {}): AnyNodeDef {
  const size = o.size ?? 8;
  const speed = o.speed ?? 2;
  const dim = o.dim ?? 32;
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test moving square',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      const x0 = (ctx.time.frame * speed) % dim;
      return {
        image: ctx.gpu.pass({
          size: { width: dim, height: dim, unit: 1 },
          uniforms: { x0, sq: size },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let q = px - vec2f(u.x0, f32(${Math.floor(dim / 2 - size / 2)}));
  let inside = q.x >= 0.0 && q.x < u.sq && q.y >= 0.0 && q.y < u.sq;
  return select(vec4f(0.0), vec4f(1.0), inside);
}`,
        }),
      };
    },
  });
}

/** Opaque 4x4 colour of value c(frame) with premultiplied alpha = c as well: (c, c, c, c). */
export function fadingSource(id: string, c: (frame: number) => number, spy: { n: number } = { n: 0 }): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test source (c,c,c,c)',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      return {
        image: ctx.gpu.pass({
          size: { width: 4, height: 4, unit: 1 },
          uniforms: { v: c(ctx.time.frame) },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v); }',
        }),
      };
    },
  });
}

/** A source that never reads the clock (static picture). */
export function stillSource(id: string, spy: { n: number } = { n: 0 }): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test still',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      return {
        image: ctx.gpu.pass({
          size: { width: 32, height: 32, unit: 1 },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let on = abs(px.x - 16.0) < 3.0 && abs(px.y - 16.0) < 3.0; return select(vec4f(0.0), vec4f(1.0, 0.4, 0.1, 1.0), on); }',
        }),
      };
    },
  });
}

/**
 * Opaque smooth texture that scrolls by (vx, vy) texels per frame (wrapping): a pure translation with known motion, for flow tests.
 * The texture is a sum of low-frequency sines so every window has gradients in both directions.
 */
export function scrollingTextureSource(id = 'va-scroll', v: [number, number] = [2, 0], spy: { n: number } = { n: 0 }, dim = 64): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test scrolling texture',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      return {
        image: ctx.gpu.pass({
          size: { width: dim, height: dim, unit: 1 },
          uniforms: { off: [ctx.time.frame * v[0], ctx.time.frame * v[1]] },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = (px - u.off) / u.size * TAU;
  let g = 0.5 + 0.22 * sin(p.x * 2.0 + 0.7) + 0.2 * sin(p.y * 3.0 + 1.3) + 0.12 * sin((p.x + p.y) * 4.0);
  return vec4f(g, g, g, 1.0);
}`,
        }),
      };
    },
  });
}
