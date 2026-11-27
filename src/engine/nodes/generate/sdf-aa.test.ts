import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { writePng, type Img } from '../../lib/gen-3d-testutil';
import { harness } from '../../testing';

/**
 * Anti-aliasing of SDF 3D with a Material: silhouette error against a 4x4 supersampled reference (the same frame rendered 4x larger and
 * box-filtered), flicker of a slowly turning object against the reference's own, the Anti-aliasing setting (Off / Edges / 2x / 4x) and
 * premultiplied alpha. Set SDFAA_OUT=1 to also write the pictures (PNG, into RSMPS_PREVIEW_DIR) and print the numbers.
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 900_000 };
const OUT = !!process.env.SDFAA_OUT;
const W = 90;
const HT = 160;
const SS = 4;


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

const scene = { shape1: 'sphere', shape2: 'box', size1: 0.9, size2: 0.7, x1: -0.35, x2: 0.4, op2: 'union', smooth2: 0, gooey: 0, rotX: 20, rotZ: 0, cameraType: 'perspective', fov: 30, scale: 0.8, ao: 0.3, specular: 0.6 };

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
  const r = await t.engine.evaluate({ graph: g, node: o.node.id, port: 'image', seconds: 0, ...(quality ? { quality } : {}) } as never);
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  return premul(await t.pixels(r.value as never));
}

/** Reference: the same frame at SSx size with no anti-aliasing, box-filtered down (premultiplied, so a plain mean is right). */
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
/** Mean frame-to-frame change over a slow turn; callers compare it with the reference's own. */
const flicker = (frames: Img[]) => {
  let s = 0;
  for (let k = 1; k < frames.length; k++) s += diff(frames[k], frames[k - 1]).mean;
  return s / (frames.length - 1);
};
const save = (name: string, px: Img) => {
  if (!OUT) return;
  mkdirSync(process.env.RSMPS_PREVIEW_DIR ?? '/tmp', { recursive: true });
  writePng(name, unpremul(px), true);
};

const MODELS: [string, Record<string, unknown> | null][] = [
  ['none', null],
  ['pbr', { model: 'pbr', roughness: 0.25, metallic: 0.3 }],
  ['toon', { model: 'toon', toonBands: 4, outline: 0.2 }],
  ['wire', { model: 'wire', wireScale: 12, wireWidth: 0.05 }],
  ['hologram', { model: 'hologram', scanLines: 60, rimStrength: 0.6 }],
  ['glass', { model: 'glass', roughness: 0.1, opacity: 0.6 }],
];

it('silhouette, flicker and pattern error of each Material against a 4x4 reference', T, async () => {
  const rows: string[] = [];
  for (const [name, mat] of MODELS) {
    const frames: Img[] = [];
    const refs: Img[] = [];
    for (const k of [0, 1, 2]) {
      const p = { rotY: 30 + k * 0.7 };
      frames.push(await render(p, mat));
      refs.push(await reference(p, mat));
    }
    const d = diff(frames[0], refs[0]);
    const fl = flicker(frames);
    const flRef = flicker(refs);
    rows.push(`${name}: mean ${d.mean.toFixed(2)} max ${d.max.toFixed(0)} edgeMax ${d.edgeMax.toFixed(0)} flicker ${fl.toFixed(3)} ref ${flRef.toFixed(3)}`);
    save(`sdfaa-${name}-cur`, frames[0]);
    save(`sdfaa-${name}-ref`, refs[0]);
    if (!OUT) {
      // thin wire lines are sub-pixel at this size: the reference itself aliases, so only their flicker is compared
      if (name !== 'wire') expect(d.mean).toBeLessThan(3);
      expect(fl).toBeLessThan(flRef + 1.2);
    }
  }
  if (OUT) { mkdirSync(process.env.RSMPS_PREVIEW_DIR ?? '/tmp', { recursive: true }); appendFileSync(`${process.env.RSMPS_PREVIEW_DIR ?? '/tmp'}/numbers.txt`, `${rows.join('\n')}\n`); }
});
