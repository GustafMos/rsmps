import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { groupDefOf } from '../../group';
import { sdfShape, sdfValue } from '../../lib/sdf-scene';
import { harness } from '../../testing';
import type { Img } from '../../lib/gen-3d-testutil';
import type { CameraValue, GraphDoc, ImageValue } from '../../types';

/**
 * Anti-aliasing together with the ground shadow (SDF Scene Output): every sub-sample ray goes through the floor branch, the average stays
 * premultiplied-correct, the object / floor contact has no fringe, and the shadow stays where it was. Set SDFAAGROUND_PPM=<file.ppm> to
 * write a picture (edges | 4x | 4x4 reference, over mid grey).
 */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 300_000 };
const N = 128;
const SS = 4;
const cam: CameraValue = { kind: 'camera', projection: 'orthographic', fov: 40, orthoSize: 8, position: [0, 10, -10], target: [0, 0, 0], roll: 0, shift: [0, 0] };
const S = Math.SQRT1_2;
const pix = (x: number, y: number, z: number): [number, number] => [64 + 16 * x, 64 - 16 * (S * y + S * z)];
// a nearly black ball: a bright fringe at its contact with the floor shadow could only come from a wrong blend
const scene = sdfValue(sdfShape('s', 'sphere', { size: [0.5, 0.5, 0.5], color: [0.04, 0.04, 0.04] }));
const base = { ambient: 1, specular: 0, ao: 0, groundShadow: true, groundStrength: 0.8, lightAzimuth: -90, lightElevation: 45 };

async function render(params: Record<string, unknown>, size = N): Promise<Img> {
  const t = await H();
  const out = await t.run('sdf-render', { ...base, ...params }, { scene: scene as never, camera: cam as never }, { project: { width: size, height: size } });
  return t.pixels(out.image as ImageValue);
}
/** Over mid grey (128), luminance-free: per channel. */
const over = (px: Img): Img => {
  const d = new Uint8ClampedArray(px.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = px.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) d[i + c] = px.data[i + c] * a + 128 * (1 - a);
    d[i + 3] = 255;
  }
  return { data: d, width: px.width, height: px.height };
};
const down = (big: Img): Img => {
  const w = big.width / SS;
  const out = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big.data[((y * SS + j) * big.width + x * SS + i) * 4 + c];
        out[(y * w + x) * 4 + c] = s / (SS * SS);
      }
  return { data: out, width: w, height: w };
};
const meanErr = (a: Img, b: Img) => {
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a.data[i + c] - b.data[i + c]);
  return s / (a.data.length / 4 * 3);
};
/** Alpha-weighted centre of the shadow: the pixels that are not opaque and lie outside the ball's disc (its edge pixels are partly covered). */
const centroid = (px: Img) => {
  let sx = 0;
  let sy = 0;
  let m = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const a = px.data[(y * px.width + x) * 4 + 3];
      if (a >= 250 || Math.hypot(x + 0.5 - 64, y + 0.5 - 64) < 11) continue;
      sx += x * a;
      sy += y * a;
      m += a;
    }
  return { x: sx / m, y: sy / m, mass: m };
};

it('ground shadow with 4x anti-aliasing: same place, same picture as a 4x4 reference, no fringe, no new pipeline', T, async () => {
  const t = await H();
  const edges = await render({ antiAlias: 'edges' });
  const x4 = await render({ antiAlias: 'x4' });
  const x2 = await render({ antiAlias: 'x2' });
  const ref = over(down(await render({ antiAlias: 'off' }, N * SS)));

  const ce = centroid(edges);
  for (const q of [x4, x2]) {
    const c = centroid(q);
    expect(c.mass).toBeGreaterThan(0);
    expect(Math.abs(c.x - ce.x)).toBeLessThan(1);
    expect(Math.abs(c.y - ce.y)).toBeLessThan(1);
    expect(c.mass / ce.mass).toBeGreaterThan(0.9);
    expect(c.mass / ce.mass).toBeLessThan(1.1);
  }
  // the shadow shows: some non-opaque pixels carry black with alpha
  expect(ce.mass).toBeGreaterThan(5000);

  const eo = over(edges);
  const xo = over(x4);
  expect(meanErr(xo, ref)).toBeLessThan(1.5);
  expect(meanErr(xo, ref)).toBeLessThan(meanErr(eo, ref) + 0.05);

  // the contact of the ball with the floor: nothing brighter than the background in a window around it
  const [cx, cy] = pix(0, -0.51, 0);
  for (const [name, img] of [['edges', eo], ['x4', xo], ['x2', over(x2)]] as const) {
    let max = 0;
    for (let y = Math.round(cy) - 8; y <= Math.round(cy) + 8; y++)
      for (let x = Math.round(cx) - 14; x <= Math.round(cx) + 14; x++) for (let c = 0; c < 3; c++) max = Math.max(max, img.data[(y * N + x) * 4 + c]);
    expect(max, `fringe at the contact (${name})`).toBeLessThanOrEqual(128 + 3);
  }

  // switching the setting with the shadow on compiles nothing new
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const m of ['off', 'edges', 'x2', 'x4', 'best']) await render({ antiAlias: m, groundStrength: 0.7 });
  expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);

  const ppm = process.env.SDFAAGROUND_PPM;
  if (ppm) {
    const imgs = [eo, xo, ref];
    const head = Buffer.from(`P6\n${N * 3} ${N}\n255\n`);
    const body = Buffer.alloc(N * 3 * N * 3);
    imgs.forEach((im, k) => {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let c = 0; c < 3; c++) body[(y * N * 3 + k * N + x) * 3 + c] = im.data[(y * N + x) * 4 + c];
    });
    writeFileSync(ppm, Buffer.concat([head, body]));
  }
});

it('an old SDF Scene without either setting lists Anti-aliasing and Ground shadow', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../io/world-ar/fixtures/sdf-ar-hologram.json', import.meta.url), 'utf8')) as GraphDoc;
  const old = fixture.nodes.find((n) => n.id === 'g_mwyokc0s3s8')!;
  const saved = (old.params as { exposed: { id: string }[] }).exposed.map((x) => x.id);
  expect(saved).not.toContain('antiAlias');
  expect(saved).not.toContain('groundShadow');
  const def = groupDefOf(old);
  expect(Object.keys(def.params)).toContain('antiAlias');
  expect(Object.keys(def.params)).toContain('groundShadow');
  expect((def.params.antiAlias as { absent?: string }).absent).toBe('edges');
});
