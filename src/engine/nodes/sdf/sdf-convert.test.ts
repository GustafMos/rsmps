import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGraph } from '../../graph';
import { GROUP_TYPE } from '../../group';
import { convertSdf3dToScene } from '../../lib/sdf-convert';
import { harness } from '../../testing';
import type { GraphDoc, ImageValue, NodeInstance } from '../../types';

/**
 * Convert to SDF Scene on the real GPU: the converted scene must draw the same picture (and depth) as the SDF 3D node it came from.
 * The default camera, light, ambient occlusion and shadows are used unless a case changes them, so these are the full pictures.
 * Mean absolute difference per channel (0..255 for the picture, scene units for the depth, 0 where nothing is hit).
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 240_000 };
const proj = { width: 160, height: 160 };
/** Thresholds: the two renderers share the shader code, so exact cases differ by rounding only. */
const PIC_MAX = 0.2; // measured 0 to 0.05 for the exact cases (one silhouette pixel is 0.01 in depth)
const DEPTH_MAX = 0.05;
/** Twist and bend are inexact distances and take other step sizes in the two renderers: a few silhouette pixels differ. Repeat is cut to a number of copies. */
const LOOSE: Record<string, [number, number]> = { 'twist, bend, shell, inflate': [0.3, 0.5], repeated: [0.5, 0.2] };
const SAMPLES = process.env.SDF_CONVERT_SAMPLES;

const doc = (node: NodeInstance): GraphDoc => ({ ...createGraph('t'), project: { ...createGraph('t').project, ...proj }, nodes: [node], edges: [] });

async function both(params: Record<string, unknown>, seconds = 0, wired: string[] = []) {
  const t = await H();
  const original: NodeInstance = { id: 'o', type: 'sdf-3d', x: 0, y: 0, params: { ...params } };
  const res = convertSdf3dToScene(t.registry, { params, wired: new Set(wired) });
  const scene: NodeInstance = { id: 'g', type: GROUP_TYPE, x: 0, y: 0, params: res.params };
  const go = async (n: NodeInstance, port: string) => (await t.evalGraph(doc(n), n.id, { port, seconds })) as ImageValue;
  const [a, b, da, db] = [await go(original, 'image'), await go(scene, 'image'), await go(original, 'depth'), await go(scene, 'depth')];
  return { t, res, a, b, pic: await t.diff(a, b), depth: await t.diff(da, db) };
}

const spheres = { shape1: 'sphere', shape2: 'sphere', x1: -0.5, x2: 0.55, size1: 0.55, size2: 0.5 };
const CASES: Record<string, [Record<string, unknown>, number?]> = {
  'one box': [{ shape1: 'box', shape2: 'off', x1: 0, size1: 0.5, sizeB1: 0.3, sizeC1: 0.4, rx1: 20, ry1: 30, rz1: 10, color1: [0.9, 0.4, 0.2, 1] }],
  'three shapes, hard union': [{ shape1: 'sphere', shape2: 'box', shape3: 'torus', x1: -0.9, x2: 0, x3: 0.9, size1: 0.4, size2: 0.35, sizeB2: 0.3, sizeC2: 0.25, size3: 0.35, sizeB3: 0.1, smooth2: 0, smooth3: 0, color2: [0.2, 0.9, 0.4, 1], color3: [0.9, 0.9, 0.2, 1] }],
  'smooth union with colours': [{ ...spheres, smooth2: 0.8, gooey: 1.5 }],
  'subtract and intersect chain': [{ shape1: 'box', shape2: 'sphere', shape3: 'cylinder', shape4: 'sphere', x1: 0, x2: 0.4, x3: 0, x4: -0.2, size1: 0.7, sizeB1: 0.6, sizeC1: 0.6, size2: 0.5, size3: 0.25, sizeB3: 1.2, rx3: 90, size4: 0.8, op2: 'subtract', smooth2: 0, op3: 'subtract', smooth3: 0.1, op4: 'intersect', smooth4: 0.2 }],
  mirrored: [{ ...spheres, shape3: 'capsule', x3: 0.9, y3: 0.6, size3: 0.2, sizeB3: 0.3, x2: 0.7, size2: 0.3, smooth2: 0.2, mirrorX: true, mirrorY: true }],
  repeated: [{ shape1: 'sphere', shape2: 'off', x1: 0, size1: 0.4, repeatX: true, repeatSpacing: 1.6 }],
  'camera changed, scene moved': [{ ...spheres, smooth2: 0.4, cameraType: 'orthographic', scale: 0.4, x: 0.4, y: 0.55, rotX: -15, rotY: 60, rotZ: 8, posX: 0.3, posY: -0.2, objectScale: 1.3, ambient: 0.3, shadows: true }],
  'perspective, fov changed': [{ ...spheres, shape3: 'cone', x3: 0, y3: 0.9, size3: 0.4, sizeB3: 0.5, smooth3: 0.3, fov: 55, rotX: 40, rotY: -30 }],
  'spin at a later time': [{ ...spheres, shape3: 'rbox', x3: 0, y3: 0.8, size3: 0.3, sizeB3: 0.3, sizeC3: 0.3, smooth2: 0.5, spinY: 1, spinX: 1 }, 0.3],
  'twist, bend, shell, inflate': [{ shape1: 'box', shape2: 'off', x1: 0, size1: 0.5, sizeB1: 0.8, sizeC1: 0.4, dTwist: 60, dBend: 0.3, shell: 0.06, dInflate: 0.05 }],
  'octahedron, plane and a tilted cone': [{ shape1: 'octa', shape2: 'plane', shape3: 'cone', x1: -0.4, y2: -0.8, x3: 0.6, size1: 0.5, size3: 0.35, sizeB3: 0.5, rx3: 30, smooth2: 0.3, smooth3: 0.2, rx1: 20, ry1: 10 }],
};

async function sample(name: string, r: Awaited<ReturnType<typeof both>>) {
  if (!SAMPLES) return;
  mkdirSync(SAMPLES, { recursive: true });
  const [pa, pb] = [await r.t.pixels(r.a), await r.t.pixels(r.b)];
  const w = pa.width;
  const out = Buffer.alloc(w * 2 * pa.height * 3);
  for (let y = 0; y < pa.height; y++) {
    for (let x = 0; x < w * 2; x++) {
      const src = x < w ? pa : pb;
      const i = (y * w + (x % w)) * 4;
      const a = src.data[i + 3] / 255;
      const bg = ((x >> 3) + (y >> 3)) % 2 ? 150 : 110;
      for (let c = 0; c < 3; c++) out[(y * w * 2 + x) * 3 + c] = Math.round(src.data[i + c] * a + bg * (1 - a));
    }
  }
  writeFileSync(`${SAMPLES}/${name.replace(/\W+/g, '-')}.ppm`, Buffer.concat([Buffer.from(`P6\n${w * 2} ${pa.height}\n255\n`), out]));
}

describe('convert to SDF Scene: the same picture and depth as SDF 3D', () => {
  for (const [name, [params, seconds]] of Object.entries(CASES)) {
    it(name, T, async () => {
      const r = await both(params, seconds ?? 0);
      await sample(name, r);
      if (process.env.SDF_CONVERT_LOG) appendFileSync(process.env.SDF_CONVERT_LOG, `parity ${name}: picture ${r.pic.toFixed(4)}, depth ${r.depth.toFixed(5)}, notes ${r.res.notes.length}\n`);
      expect(r.pic).toBeLessThan(LOOSE[name]?.[0] ?? PIC_MAX);
      expect(r.depth).toBeLessThan(LOOSE[name]?.[1] ?? DEPTH_MAX);
    });
  }
});

describe('convert to SDF Scene: features with no equivalent', () => {
  it('are named in the notes and the scene still renders', T, async () => {
    const t = await H();
    const params = { ...spheres, smooth2: 0.5, morph: true, morphAmount: 0.3, fold: 5, dTaper: 0.4, dMelt: 0.2, dExplode: 0.1, dLowFi: 16, dMorph: 0.2, dInflate: -0.05 };
    const res = convertSdf3dToScene(t.registry, { params, wired: new Set(['texture', 'displaceMap']) });
    const text = res.notes.join('\n');
    for (const word of ['Morph between shape 1 and 2', 'Kaleidoscope', 'Texture', 'Displace map', 'Taper', 'Melt', 'Explode', 'Low-fi snap', 'Morph to sphere', 'negative amount']) expect(text, word).toContain(word);
    expect(res.portMap.texture).toBeNull();
    expect(res.portMap.displaceMap).toBeNull();
    const scene: NodeInstance = { id: 'g', type: GROUP_TYPE, x: 0, y: 0, params: res.params };
    const px = await t.pixels((await t.evalGraph(doc(scene), 'g', { port: 'image' })) as ImageValue);
    let seen = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 128) seen++;
    expect(seen).toBeGreaterThan(500);
  });
});
