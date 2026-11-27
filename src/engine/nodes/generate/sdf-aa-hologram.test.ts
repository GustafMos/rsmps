import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { writePng, type Img } from '../../lib/gen-3d-testutil';
import { harness } from '../../testing';
import type { GraphDoc, ImageValue } from '../../types';
import fixture from './fixtures/sdf-hologram-scene.json';

/**
 * The owner's project: an SDF Scene (two smooth-unioned spheres, one moving) with a hologram Material, 24 fps loop. Rendered with the built-in
 * camera. Checks the picture against a supersampled reference, that it does not change character with the render size, and that the animated
 * scan lines loop exactly. SDFAA_OUT=1 writes pictures and numbers into RSMPS_PREVIEW_DIR.
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 900_000 };
const OUT = !!process.env.SDFAA_OUT;
const DIR = process.env.RSMPS_PREVIEW_DIR ?? '/tmp';

const graph = (w: number, h: number, mat: Record<string, unknown> = {}, scene: Record<string, unknown> = {}): GraphDoc => {
  const f = JSON.parse(JSON.stringify(fixture));
  for (const n of f.nodes) {
    if (n.type === 'material') Object.assign(n.params, mat);
    if (n.type === 'group') {
      const { antiAlias, ...rest } = scene;
      Object.assign(n.params, rest);
      if (antiAlias) for (const m of n.params.nodes) if (m.id === 'render') m.params.antiAlias = antiAlias;
    }
  }
  return { schema: 1, version: 1, name: 'holo', frames: [], ...f, project: { ...f.project, width: w, height: h } } as unknown as GraphDoc;
};

/** Straight RGBA -> premultiplied (averaging and compositing are only right on premultiplied pixels). */
const premul = (px: Img): Img => {
  const d = new Uint8ClampedArray(px.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = px.data[i + 3] / 255;
    d[i] = px.data[i] * a;
    d[i + 1] = px.data[i + 1] * a;
    d[i + 2] = px.data[i + 2] * a;
    d[i + 3] = px.data[i + 3];
  }
  return { data: d, width: px.width, height: px.height };
};
const unpremul = (px: Img): Img => {
  const d = new Uint8ClampedArray(px.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = px.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = a > 0 ? px.data[i + c] / a : 0;
    d[i + 3] = px.data[i + 3];
  }
  return { data: d, width: px.width, height: px.height };
};
const draw = async (w: number, h: number, seconds: number, mat: Record<string, unknown> = {}, scene: Record<string, unknown> = {}, proxy?: number): Promise<Img> => {
  const t = await H();
  const img = (await t.evalGraph(graph(w, h, mat, scene), 'g_mwyokc0s3s8', { port: 'image', seconds, ...(proxy ? { proxy } : {}) })) as ImageValue;
  return premul(await t.pixels(img));
};
const down = (big: Img, k: number): Img => {
  const w = big.width / k;
  const h = big.height / k;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += big.data[((y * k + j) * big.width + x * k + i) * 4 + c];
        out[(y * w + x) * 4 + c] = s / (k * k);
      }
  return { data: out, width: w, height: h };
};
const diff = (a: Img, b: Img) => {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d += Math.abs(a.data[i + c] - b.data[i + c]);
    d /= 4;
    sum += d;
    max = Math.max(max, d);
  }
  return { mean: sum / (a.data.length / 4), max };
};
const log = (line: string) => {
  if (!OUT) return;
  mkdirSync(DIR, { recursive: true });
  appendFileSync(`${DIR}/numbers-hologram.txt`, `${line}\n`);
};
const save = (name: string, px: Img) => {
  if (!OUT) return;
  mkdirSync(DIR, { recursive: true });
  writePng(name, unpremul(px), true);
};

// scan lines dense enough to alias at phone size (the owner's project has 10 per unit; 60 and 200 are the Material's own range)
const CASES: [string, Record<string, unknown>][] = [
  ['owner-10', {}],
  ['dense-60', { scanLines: 60, rimStrength: 0.6 }],
  ['dense-200', { scanLines: 200, rimStrength: 0.6 }],
];

it('owner scene: error against a 2x2 reference, and the same look at half size', T, async () => {
  for (const [name, mat] of CASES) {
    const cur = await draw(480, 270, 0.5, mat);
    const ref = down(await draw(960, 540, 0.5, { ...mat }, { antiAlias: 'off' }), 2);
    const d = diff(cur, ref);
    // resolution independence: the picture at half the size (a playback proxy) against the full-size frame boxed down to that size
    const half = await draw(960, 540, 0.5, mat, {}, 0.5);
    const full = down(await draw(960, 540, 0.5, mat), 2);
    const rd = diff(half, full);
    log(`${name}: vs ref mean ${d.mean.toFixed(2)} max ${d.max.toFixed(0)} | proxy 0.5 vs full boxed mean ${rd.mean.toFixed(2)} max ${rd.max.toFixed(0)}`);
    save(`holo-${name}-cur`, cur);
    save(`holo-${name}-ref`, ref);
    if (!OUT) {
      expect(d.mean).toBeLessThan(4);
      expect(rd.mean).toBeLessThan(4);
    }
  }
});

it('owner scene: animated scan lines loop exactly and move smoothly', T, async () => {
  const mat = { holoCycles: 2, scanLines: 30, rimStrength: 0.5 };
  const a = await draw(240, 135, 0, mat);
  const b = await draw(240, 135, 4, mat);
  const step: number[] = [];
  let prev = a;
  for (let k = 1; k <= 6; k++) {
    const f = await draw(240, 135, k / 24, mat);
    step.push(diff(f, prev).mean);
    prev = f;
  }
  log(`loop seam mean ${diff(a, b).mean.toFixed(3)}; 24fps step means ${step.map((s) => s.toFixed(2)).join(' ')}`);
  if (!OUT) {
    expect(diff(a, b).mean).toBeLessThan(0.6);
    expect(Math.max(...step)).toBeLessThan(3);
  }
});
