import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { addNode, connect, createGraph, setParam } from '../../graph';
import { harness, type Harness } from '../../testing';
import type { GraphDoc, ImageValue } from '../../types';

/** A generator whose detail depends on the resolution it renders at (stripes with hard edges), and which records how it was asked to render. */
const seen = { renders: 0, proxies: [] as number[], canvases: [] as string[] };
const detail = defineNode({
  id: 'test-detail',
  title: 'detail',
  category: 'generate',
  description: 'test generator',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: { tweak: { type: 'number', default: 0 } },
  render(ctx) {
    seen.renders++;
    seen.proxies.push(Math.round(ctx.proxy * 1000) / 1000);
    seen.canvases.push(`${ctx.canvas.width}x${ctx.canvas.height}`);
    const image = ctx.gpu.pass({
      label: 'test-detail',
      size: ctx.canvas,
      uniforms: { tweak: ctx.params.tweak },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return vec4f(step(0.5, fract(uv.x * 7.0 + u.tweak)), uv.y, step(0.5, fract(uv.y * 5.0)), 1.0);
}`,
    });
    return { image };
  },
});

const PROJECT = { width: 64, height: 36, lengthMode: 'relative' as const, referenceSide: 36, fps: 10, duration: 2 };

function build(t: Harness, scaleParams: Record<string, unknown> | null, project: Record<string, unknown> = PROJECT) {
  let g: GraphDoc = createGraph('rs');
  g = { ...g, project: { ...g.project, ...project } };
  const a = addNode(g, t.registry, 'test-detail');
  g = a.graph;
  let last = a.node.id;
  const ids: string[] = [a.node.id];
  for (const params of scaleParams ? [scaleParams] : []) {
    const b = addNode(g, t.registry, 'render-scale', { x: 0, y: 0 }, params);
    g = connect(b.graph, t.registry, { node: last, port: 'image' }, { node: b.node.id, port: 'image' });
    last = b.node.id;
    ids.push(b.node.id);
  }
  return { g, src: a.node.id, rs: ids[1], ids };
}

const reset = () => {
  seen.renders = 0;
  seen.proxies = [];
  seen.canvases = [];
};

async function evalImage(t: Harness, g: GraphDoc, node: string, proxy?: number, seconds = 0): Promise<ImageValue> {
  const v = await t.evalGraph(g, node, { proxy, seconds });
  return v as ImageValue;
}

describe('render-scale', () => {
  it('equals "evaluate at the proxy, then enlarge with the viewer filter" (within 1/255), for a clean and an awkward factor', async () => {
    const t = await harness([detail]);
    for (const [pct, proxy] of [
      [25, 0.25],
      [33, 0.33],
    ] as const) {
      const { g, src, rs } = build(t, { scale: pct });
      const low = await evalImage(t, g, src, proxy);
      const out = await evalImage(t, g, rs);
      // The reference: the same bilinear enlarge the browser applies to the proxy canvas, written independently of the node.
      const ref = t.gpu.pass({
        label: 'rs-ref',
        size: { width: 64, height: 36, unit: 1 },
        textures: { s: low },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(s, smp, uv, 0.0); }',
      });
      expect([out.width, out.height]).toEqual([64, 36]);
      expect([low.width, low.height]).toEqual([Math.round(64 * proxy), Math.round(36 * proxy)]); // the player's rounding
      const a = await t.pixels(out);
      const b = await t.pixels(ref);
      let worst = 0;
      for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
      expect(worst).toBeLessThanOrEqual(1);

      // And a CPU bilinear (texel-centre aligned) as a check on what "the viewer filter" means.
      const lp = await t.pixels(low);
      let cpuWorst = 0;
      for (let y = 0; y < 36; y += 3) {
        for (let x = 0; x < 64; x += 3) {
          const sx = ((x + 0.5) * low.width) / 64 - 0.5;
          const sy = ((y + 0.5) * low.height) / 36 - 0.5;
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const fx = sx - x0;
          const fy = sy - y0;
          const at = (xx: number, yy: number, c: number) => lp.at(Math.min(low.width - 1, Math.max(0, xx)), Math.min(low.height - 1, Math.max(0, yy)))[c];
          for (let c = 0; c < 3; c++) {
            const v = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
            cpuWorst = Math.max(cpuWorst, Math.abs(v - a.at(x, y)[c]));
          }
        }
      }
      expect(cpuWorst).toBeLessThanOrEqual(3);
    }
  });

  it('keeps the full frame size and the unit of a full-resolution evaluation (a 4K project stays 4K)', async () => {
    const t = await harness([detail]);
    const project = { width: 3840, height: 2160, lengthMode: 'relative' as const, referenceSide: 1080, fps: 10, duration: 1 };
    const { g, src, rs } = build(t, { scale: 25 }, project);
    const full = await evalImage(t, g, src);
    const out = await evalImage(t, g, rs);
    expect([out.width, out.height]).toEqual([3840, 2160]);
    expect(out.unit).toBeCloseTo(full.unit, 9);
    // the low evaluation really was a quarter-size canvas
    expect(seen.canvases).toContain('960x540');
    // awkward: odd project, 33 %
    const odd = build(t, { scale: 33 }, { ...project, width: 1921, height: 1081 });
    const o = await evalImage(t, odd.g, odd.rs);
    expect([o.width, o.height]).toEqual([1921, 1081]);
    // absolute length mode: unit follows the proxy, so the output unit is the full one (1)
    const abs = build(t, { scale: 50 }, { ...PROJECT, lengthMode: 'absolute' });
    const ao = await evalImage(t, abs.g, abs.rs);
    expect(ao.unit).toBeCloseTo(1, 9);
  });

  it('inside a playback proxy the output has the size and unit of that proxy', async () => {
    const t = await harness([detail]);
    const { g, src, rs } = build(t, { scale: 25 });
    const plain = await evalImage(t, g, src, 0.5);
    const out = await evalImage(t, g, rs, 0.5);
    expect([out.width, out.height]).toEqual([32, 18]);
    expect(out.unit).toBeCloseTo(plain.unit, 9);
  });

  it('100 % is a pass-through: same texture, zero passes', async () => {
    const t = await harness([detail]);
    const { g, src, rs } = build(t, { scale: 100 });
    const direct = await evalImage(t, g, src);
    const before = t.gpu.stats().objects.submits;
    const out = await evalImage(t, g, rs);
    expect(out.texture).toBe(direct.texture);
    expect(t.gpu.stats().objects.submits).toBe(before);
  });

  it('renders the upstream once (twice only when mix < 1); a static upstream stays cached across frames', async () => {
    const t = await harness([detail]);
    reset();
    const a = build(t, { scale: 25 });
    for (const s of [0, 0.1, 0.5, 1]) await evalImage(t, a.g, a.rs, undefined, s);
    expect(seen.renders).toBe(1);
    expect(seen.proxies).toEqual([0.25]);
    reset();
    const b = build(t, { scale: 25, mix: 0.5 });
    await evalImage(t, b.g, b.rs);
    expect(seen.renders).toBe(2);
    expect(seen.proxies.sort()).toEqual([0.25, 1]);
    await evalImage(t, b.g, b.rs, undefined, 0.3);
    expect(seen.renders).toBe(2);
    // mix 0 = the true picture, never rendered low
    reset();
    const c = build(t, { scale: 25, mix: 0 });
    const full = await evalImage(t, c.g, c.src);
    const out = await evalImage(t, c.g, c.rs);
    expect(out.texture).toBe(full.texture);
    expect(seen.renders).toBe(1);
  });

  it('moving the sliders compiles nothing', async () => {
    const t = await harness([detail]);
    const first = build(t, { scale: 25, mix: 0.8 });
    await evalImage(t, first.g, first.rs);
    const warmed = t.gpu.stats().objects.pipelinesCreated;
    let g = first.g;
    for (const [key, v] of [
      ['scale', 40],
      ['scale', 12.5],
      ['mix', 0.3],
      ['mix', 0.9],
      ['scale', 75],
    ] as const) {
      g = setParam(g, first.rs, key, v);
      await evalImage(t, g, first.rs);
    }
    expect(t.gpu.stats().objects.pipelinesCreated).toBe(warmed);
  });

  it('match: follows a coarser playback proxy, "off" does not; nested nodes take the coarser scale', async () => {
    const t = await harness([detail]);
    reset();
    const on = build(t, { scale: 50, match: true });
    await evalImage(t, on.g, on.rs, 0.25);
    expect(seen.proxies).toEqual([0.25]); // never finer than the playback proxy
    reset();
    const off = build(t, { scale: 50, match: false });
    const o = await evalImage(t, off.g, off.rs, 0.25);
    expect(seen.proxies).toEqual([0.5]); // exactly the asked look
    expect([o.width, o.height]).toEqual([16, 9]); // still the size of the scope it runs in
    // at proxy 1 (paused, export) both agree
    reset();
    await evalImage(t, on.g, on.rs);
    await evalImage(t, off.g, off.rs);
    expect(seen.proxies).toEqual([0.5]); // the second request is served from the cache entry the first one made

    // nested: 50 then 25 -> the upstream is rendered at 25 once; 25 then 50 -> also 25 (the inner one has nothing coarser to do)
    for (const [outer, inner] of [
      [50, 25],
      [25, 50],
    ]) {
      reset();
      let { g, src, rs } = build(t, { scale: inner });
      const b = addNode(g, t.registry, 'render-scale', { x: 0, y: 0 }, { scale: outer });
      g = connect(b.graph, t.registry, { node: rs, port: 'image' }, { node: b.node.id, port: 'image' });
      const out = await evalImage(t, g, b.node.id);
      expect([out.width, out.height]).toEqual([64, 36]);
      expect(seen.proxies).toEqual([0.25]);
      void src;
    }
  });

  it('shares results made at the same proxy with a plain evaluation at that proxy', async () => {
    const t = await harness([detail]);
    const { g, src, rs } = build(t, { scale: 25 });
    await evalImage(t, g, src, 0.25);
    reset();
    await evalImage(t, g, rs); // asks the generator for proxy 0.25 again
    expect(seen.renders).toBe(0);
  });

  it('filters: sharp pixels are the proxy texels, bicubic and smooth keep the size', async () => {
    const t = await harness([detail]);
    const base = build(t, { scale: 25, filter: 'sharp' });
    const low = await t.pixels(await evalImage(t, base.g, base.src, 0.25));
    const sharp = await t.pixels(await evalImage(t, base.g, base.rs));
    for (const [x, y] of [
      [0, 0],
      [13, 7],
      [40, 30],
      [63, 35],
    ]) expect(sharp.at(x, y)).toEqual(low.at(Math.floor(x / 4), Math.floor(y / 4)));
    for (const filter of ['soft', 'smooth']) {
      const b = build(t, { scale: 25, filter });
      const o = await evalImage(t, b.g, b.rs);
      expect([o.width, o.height]).toEqual([64, 36]);
      const px = await t.pixels(o);
      expect(px.at(5, 5)[3]).toBe(255);
    }
  });

  it('survives an art-grid upstream (Pixelate): no crash, full size', async () => {
    const t = await harness([detail]);
    let { g, src } = build(t, null);
    const pix = addNode(g, t.registry, 'pixelate');
    g = connect(pix.graph, t.registry, { node: src, port: 'image' }, { node: pix.node.id, port: 'image' });
    const rs = addNode(g, t.registry, 'render-scale', { x: 0, y: 0 }, { scale: 25 });
    g = connect(rs.graph, t.registry, { node: pix.node.id, port: 'image' }, { node: rs.node.id, port: 'image' });
    const r = await t.engine.evaluate({ graph: g, node: rs.node.id });
    expect(r.errors.size).toBe(0);
    expect((r.value as ImageValue).width).toBeGreaterThan(0);
  });
});
