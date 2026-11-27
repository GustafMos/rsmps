import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { writePng, type Img } from '../../lib/gen-3d-testutil';
import { harness } from '../../testing';

/** The Anti-aliasing setting of SDF 3D (Off / Edges only / 2x / 4x / best when paused or exporting): error, alpha, shader count and cost. */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 900_000 };
const OUT = !!process.env.SDFAA_OUT;
const DIR = process.env.RSMPS_PREVIEW_DIR ?? '/tmp';
const W = 90;
const HT = 160;
const SS = 4;
const scene = { shape1: 'sphere', shape2: 'box', size1: 0.9, size2: 0.7, x1: -0.35, x2: 0.4, op2: 'union', smooth2: 0, gooey: 0, rotX: 20, rotZ: 0, cameraType: 'perspective', fov: 30, scale: 0.8, ao: 0.3, specular: 0.6 };
const HOLO = { model: 'hologram', scanLines: 60, rimStrength: 0.6 };
const MODES = ['off', 'edges', 'x2', 'x4'] as const;

/** Rendered pixels as premultiplied RGBA (averaging and compositing are only right on premultiplied pixels). */
async function render(params: Record<string, unknown>, mat: Record<string, unknown> | null, w = W, h = HT, quality?: 'preview' | 'final'): Promise<Img> {
  const t = await H();
  let g = createGraph('aa');
  g.project = { ...g.project, width: w, height: h, fps: 10, duration: 2, loop: true };
  const o = addNode(g, t.registry, 'sdf-3d', { x: 200, y: 0 }, { ...scene, ...params });
  g = o.graph;
  if (mat) {
    const m = addNode(g, t.registry, 'material', { x: 0, y: 0 }, mat);
    g = connect(m.graph, t.registry, { node: m.node.id, port: 'material' }, { node: o.node.id, port: 'material' });
  }
  const r = await t.engine.evaluate({ graph: g, node: o.node.id, port: 'image', seconds: 0, ...(quality ? { quality } : {}) });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  const px = await t.pixels(r.value as never);
  const d = new Uint8ClampedArray(px.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = px.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = px.data[i + c] * a;
    d[i + 3] = px.data[i + 3];
  }
  return { data: d, width: px.width, height: px.height };
}
async function reference(params: Record<string, unknown>, mat: Record<string, unknown> | null): Promise<Img> {
  const big = await render({ ...params, antiAlias: 'off' }, mat, W * SS, HT * SS);
  const out = new Uint8ClampedArray(W * HT * 4);
  for (let y = 0; y < HT; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big.data[((y * SS + j) * big.width + x * SS + i) * 4 + c];
        out[(y * W + x) * 4 + c] = s / (SS * SS);
      }
  return { data: out, width: W, height: HT };
}
const diff = (a: Img, b: Img) => {
  let sum = 0;
  let max = 0;
  let edgeMax = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d += Math.abs(a.data[i + c] - b.data[i + c]);
    d /= 4;
    sum += d;
    max = Math.max(max, d);
    const al = b.data[i + 3];
    if (al > 8 && al < 247) edgeMax = Math.max(edgeMax, d);
  }
  return { mean: sum / (a.data.length / 4), max, edgeMax };
};
const over = (p: Img): Img => {
  const o = new Uint8ClampedArray(p.data.length);
  for (let i = 0; i < o.length; i += 4) {
    for (let c = 0; c < 3; c++) o[i + c] = p.data[i + c] + (1 - p.data[i + 3] / 255) * 128;
    o[i + 3] = 255;
  }
  return { data: o, width: p.width, height: p.height };
};
const log = (line: string) => {
  if (!OUT) return;
  mkdirSync(DIR, { recursive: true });
  appendFileSync(`${DIR}/numbers-modes.txt`, `${line}\n`);
};
const save = (name: string, px: Img) => {
  if (!OUT) return;
  mkdirSync(DIR, { recursive: true });
  const d = new Uint8ClampedArray(px.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = px.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = a > 0 ? px.data[i + c] / a : 0;
    d[i + 3] = px.data[i + 3];
  }
  writePng(name, { data: d, width: px.width, height: px.height }, true);
};

it('more rays never raise the error against a 4x4 reference; premultiplied alpha composites right', T, async () => {
  for (const [name, mat] of [['none', null], ['hologram', HOLO]] as const) {
    const ref = await reference({ rotY: 33 }, mat);
    const err: number[] = [];
    const edge: number[] = [];
    let x4: Img | null = null;
    for (const m of MODES) {
      const px = await render({ rotY: 33, antiAlias: m }, mat);
      const d = diff(px, ref);
      err.push(d.mean);
      edge.push(d.edgeMax);
      if (m === 'x4') x4 = px;
      save(`sdfaa-${name}-${m}`, px);
    }
    log(`${name}: mean ${err.map((e) => e.toFixed(2)).join(' / ')} | edge max ${edge.map((e) => e.toFixed(0)).join(' / ')} (off / edges / 2x / 4x)`);
    if (!OUT) {
      expect(err[1]).toBeLessThan(err[0] + 1e-6);
      expect(err[2]).toBeLessThan(err[1] + 1e-6);
      expect(err[3]).toBeLessThan(err[2] + 1e-6);
      expect(err[3]).toBeLessThan(err[0] * 0.95);
      expect(diff(over(x4 as Img), over(ref)).mean).toBeLessThan(2.5);
    }
  }
});

it('best: 4 rays when paused or exporting, the cheap method while playing; switching the setting compiles nothing new', T, async () => {
  const t = await H();
  const edges = await render({ antiAlias: 'edges' }, HOLO, W, HT, 'preview');
  const bestPlay = await render({ antiAlias: 'best' }, HOLO, W, HT, 'preview');
  const x4 = await render({ antiAlias: 'x4' }, HOLO, W, HT, 'preview');
  const bestFinal = await render({ antiAlias: 'best' }, HOLO, W, HT, 'final');
  expect(diff(bestPlay, edges).max).toBe(0);
  expect(diff(bestFinal, x4).max).toBe(0);
  expect(diff(bestFinal, edges).max).toBeGreaterThan(0);
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const m of MODES) await render({ antiAlias: m, rotY: 12 }, HOLO);
  expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
});

it('cost of each setting at 540x960 (software GPU: relative only)', T, async () => {
  const rows: string[] = [];
  for (const m of MODES) {
    await render({ antiAlias: m }, HOLO, 540, 960);
    const t0 = performance.now();
    for (let i = 0; i < 2; i++) await render({ antiAlias: m, rotY: 20 + i }, HOLO, 540, 960);
    rows.push(`${m} ${((performance.now() - t0) / 2).toFixed(0)} ms`);
  }
  log(`cost 540x960 hologram: ${rows.join(', ')}`);
});
