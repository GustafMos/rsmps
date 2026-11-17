/**
 * With Loop OFF nothing changes: loop snapping only acts when the project loops. These checksums were recorded from the nodes BEFORE the
 * loop-snapping work, with awkward values, Loop off; the same params must still give the same pixels.
 */
import { describe, expect, it } from 'vitest';
import { harness } from '../testing';

const PAL5: [number, number, number][] = [[1, 0.1, 0.1], [1, 0.8, 0.1], [0.2, 0.9, 0.3], [0.1, 0.6, 1], [0.7, 0.2, 0.9]];

interface Row {
  id: string;
  params: Record<string, unknown>;
  input: 'img' | 'ring' | 'mov' | 'two' | 'size';
}
const ROWS: Record<string, Row> = {
  'zoom colours 5/2': { id: 'infinite-zoom', input: 'ring', params: { scale: 0.45, levels: 8, speed: 2, recolor: 'fill', palette: PAL5, attached: true } },
  'zoom tint 2/3 hue': { id: 'infinite-zoom', input: 'ring', params: { scale: 0.45, levels: 8, speed: 3, recolor: 'multiply', palette: PAL5.slice(0, 2), hueStep: 37, attached: true } },
  'zoom flowing': { id: 'infinite-zoom', input: 'ring', params: { scale: 0.45, levels: 8, speed: 1, recolor: 'fill', palette: PAL5, attached: false } },
  'array hue 90 scroll': { id: 'array', input: 'img', params: { mode: 'infinite', columns: 2, rows: 1, spacing: [0, 0], scrollX: 1, hueStep: 90, outputSize: 'input' } },
  'array bright scroll': { id: 'array', input: 'img', params: { mode: 'grid', columns: 3, rows: 3, scrollX: 2, brightnessStep: 0.1, outputSize: 'input' } },
  'array tint scroll': { id: 'array', input: 'img', params: { mode: 'infinite', columns: 3, rows: 2, spacing: [0, 0], scrollX: 1, scrollY: -2, tintMode: 'multiply', hueStep: 30, outputSize: 'input' } },
  'kaleido tunnel twist': { id: 'kaleidoscope', input: 'img', params: { mode: 'logpolar', segments: 5, twist: 0.5, fall: 2, spin: 1 } },
  'kaleido mirror scroll': { id: 'kaleidoscope', input: 'img', params: { mode: 'mirror', scroll: [0.37, 1.3], spin: 1 } },
  'retime 1.3': { id: 'retime', input: 'mov', params: { speed: 1.3 } },
  'retime 0.37 reverse': { id: 'retime', input: 'mov', params: { speed: 0.37, reverse: true } },
  'retime stop-motion': { id: 'retime', input: 'mov', params: { speed: 2.5, holdFps: 7 } },
  'smear refresh 5': { id: 'motion-smear', input: 'mov', params: { refresh: 5, hold: 3, bleed: 1 } },
  'array3d card colours': { id: 'array-3d', input: 'img', params: { layout: 'tunnel', countX: 4, countZ: 7, radius: 1.5, travel: 1, colourBy: 'card', tintMode: 'multiply', hueStep: 40 } },
};

const SOURCES = {
  bar: { node: 'audit-loop-off-bar' },
};
void SOURCES;

/** Recorded before the change (Loop off, 24 frames at 8 fps, 32x32, frames 0, 5, 11, 17). */
const GOLDEN: Record<string, number[]> = {
  'zoom colours 5/2': [160397, 414300, 537742, 471623],
  'zoom tint 2/3 hue': [348742, 299395, 801124, 134280],
  'zoom flowing': [160397, 693757, 395748, 208874],
  'array hue 90 scroll': [405650, 618579, 552545, 863203],
  'array bright scroll': [59755, 649891, 393068, 540667],
  'array tint scroll': [13279, 975505, 241143, 938196],
  'kaleido tunnel twist': [573055, 382644, 188477, 382644],
  'kaleido mirror scroll': [992202, 112321, 953587, 71047],
  'retime 1.3': [240717, 956107, 972239, 229138],
  'retime 0.37 reverse': [783892, 77731, 661146, 169770],
  'retime stop-motion': [240717, 704016, 680208, 266380],
  'smear refresh 5': [160437, 160437, 474315, 834678],
  'array3d card colours': [322695, 919907, 667400, 541064],
};

describe('Loop off: unchanged output', () => {
  it('matches the recorded checksums', async () => {
    const { defineNode } = await import('../define');
    const bar = defineNode({
      id: 'audit-loop-off-bar',
      title: 'Bar',
      category: 'input',
      description: 'test',
      keywords: [],
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render(ctx) {
        const phase = ctx.time.phase;
        return { image: ctx.gpu.pass({ label: 'bar', size: ctx.canvas, uniforms: { phase }, wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f { let d = abs(fract(uv.x - u.phase + 0.5) - 0.5); return vec4f(vec3f(max(select(0.0, 1.0, d < 0.1), 0.15 + 0.25 * uv.y)), 1.0); }` }) };
      },
    });
    const t = await harness([bar]);
    const still = t.fromFn(32, 32, (x, y) => [(x * 8) & 255, (y * 8) & 255, 120 + ((x ^ y) & 1) * 80, 255]);
    const ring = t.fromFn(32, 32, (x, y) => (Math.min(x, y, 31 - x, 31 - y) < 6 ? [200, (x * 8) & 255, (y * 8) & 255, 255] : [0, 0, 0, 0]));
    const got: Record<string, number[]> = {};
    for (const [name, row] of Object.entries(ROWS)) {
      const inputs = row.input === 'img' ? { image: still } : row.input === 'ring' ? { image: ring } : row.input === 'mov' ? { image: { node: 'audit-loop-off-bar' } } : {};
      const sums: number[] = [];
      for (const f of [0, 5, 11, 17]) {
        const out = await t.run(row.id, row.params, inputs as never, { seconds: f / 8, project: { fps: 8, duration: 3, loop: false, width: 32, height: 32 } });
        const data = await t.gpu.read(out.image as never, false);
        let h = 0;
        for (let i = 0; i < data.length; i++) h = (h * 31 + data[i] * (i % 7 + 1)) % 1000003;
        sums.push(h);
      }
      got[name] = sums;
    }
    const bad = Object.keys(GOLDEN).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(GOLDEN[k]));
    expect(bad, 'rows whose Loop-off output changed').toEqual([]);
    expect(got).toEqual(GOLDEN);
  }, 120_000);
});
