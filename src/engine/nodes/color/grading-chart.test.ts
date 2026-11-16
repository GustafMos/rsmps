import { expect, it } from 'vitest';
import { cubeText } from '../../lib/color-math';
import { CHART_H, CHART_W, makeChart } from '../../lib/color-testutil';
import { type Img, sheet, writePng } from '../../lib/gen-3d-testutil';
import { harness } from '../../testing';
import type { CurveValue, Host, ImageValue } from '../../types';

/** Renders the colour chart (hue sweep, pastel sweep, grey ramp, skin patches, scene colours) through each grading node into PNGs for looking at. */
const pts = (...p: [number, number][]): CurveValue => ({ keys: p.map(([t, v]) => ({ t, v, interp: 'smooth' as const })) });
const bump = (c: number, v: number): CurveValue => {
  const k = (t: number, val: number) => ({ t: ((t % 1) + 1) % 1, v: val, interp: 'smooth' as const });
  return { keys: [k(c - 0.12, 0.5), k(c - 0.06, 0.5), k(c, v), k(c + 0.06, 0.5), k(c + 0.12, 0.5)].sort((a, b) => a.t - b.t) };
};

it('renders the chart through every grading node', async () => {
  const bytes = new TextEncoder().encode(
    cubeText('3d', 33, (r, g, b) => {
      // a teal-and-orange look
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [Math.min(1, r * 1.05 + 0.08 * l), g * 0.98, Math.min(1, b * 0.9 + 0.12 * (1 - l))];
    }),
  ).buffer as ArrayBuffer;
  const host: Host = { assetInfo: () => null, assetFrame: async () => null, assetBytes: async () => bytes };
  const t = await harness([], host);
  const src = makeChart(t);
  const img = async (v: unknown): Promise<Img> => {
    const p = await t.pixels(v as ImageValue);
    return { data: p.data, width: p.width, height: p.height };
  };
  const original = await img(src);
  const make = async (name: string, variants: { id: string; params: Record<string, unknown> }[]) => {
    const items: Img[] = [original];
    for (const v of variants) items.push(await img((await t.run(v.id, v.params, { image: src })).image));
    writePng(name, sheet(items, items.length), false);
  };
  await make('grade-white-balance', [
    { id: 'white-balance', params: { temperature: 3200 } },
    { id: 'white-balance', params: { temperature: 9500 } },
    { id: 'white-balance', params: { tint: 0.8 } },
    { id: 'white-balance', params: { mode: 'neutral', neutral: [0.85, 0.7, 0.55, 1] } },
  ]);
  await make('grade-saturation', [
    { id: 'saturation', params: { mode: 'oklab', saturation: 0 } },
    { id: 'saturation', params: { mode: 'oklab', saturation: 2 } },
    { id: 'saturation', params: { mode: 'linear', saturation: 2 } },
    { id: 'saturation', params: { mode: 'hsl', saturation: 2 } },
    { id: 'saturation', params: { vibrance: 1, protectSkin: 1 } },
  ]);
  await make('grade-wheels', [
    { id: 'color-wheels', params: { liftColor: [0.4, 0.55, 0.8, 1], gainColor: [0.9, 0.65, 0.4, 1], gammaMaster: 0.1 } },
    { id: 'color-wheels', params: { space: 'linear', gainMaster: 0.4, liftMaster: -0.02 } },
    { id: 'color-wheels', params: { mode: 'cdl', slopeR: 1.2, slopeB: 0.8, powerG: 1.2, cdlOffsetB: 0.04, saturation: 1.2 } },
    { id: 'color-wheels', params: { contrast: 1.5, pivot: 0.435 } },
  ]);
  await make('grade-curves', [
    { id: 'curves', params: { master: pts([0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]) } },
    { id: 'curves', params: { red: pts([0, 0], [0.5, 0.62], [1, 1]), blue: pts([0, 0.05], [0.5, 0.45], [1, 0.95]) } },
    { id: 'curves', params: { hueVsSat: bump(0.59, 0) } },
    { id: 'curves', params: { hueVsHue: bump(0.59, 0.85), hueVsLum: bump(0.33, 0.75) } },
    { id: 'curves', params: { lumVsSat: pts([0, 0], [0.35, 0.5], [0.7, 0.5], [1, 0.1]), satVsSat: pts([0, 0.5], [0.6, 0.5], [1, 0.15]) } },
  ]);
  await make('grade-exposure', [
    { id: 'exposure', params: { stops: 1 } },
    { id: 'exposure', params: { stops: 1.5, rolloff: 0.6 } },
    { id: 'exposure', params: { stops: 1.5, tonemap: 'reinhard', whitePoint: 3 } },
    { id: 'exposure', params: { stops: 1.5, tonemap: 'hable', whitePoint: 4 } },
  ]);
  await make('grade-colour-space', [
    { id: 'color-space', params: { from: 'srgb', to: 'linear' } },
    { id: 'color-space', params: { from: 'srgb', to: 'logc3' } },
    { id: 'color-space', params: { from: 'srgb', to: 'slog3' } },
    { id: 'color-space', params: { from: 'srgb', to: 'davinci' } },
    { id: 'color-space', params: { from: 'p3', to: 'srgb' } },
  ]);
  await make('grade-lut', [
    { id: 'lut', params: { lut: ['look'] } },
    { id: 'lut', params: { lut: ['look'], intensity: 0.5, interpolation: 'trilinear' } },
  ]);
  const q = await t.run('hsl-qualifier', { hueCenter: 213, hueWidth: 25, hueSoft: 12, preview: 'highlight' }, { image: src });
  const matte = await img(q.mask);
  writePng('grade-qualifier', sheet([original, matte, await img(q.preview)], 3), false);
  const scopes: Img[] = [];
  for (const [type, channels] of [['waveform', 'luma'], ['waveform', 'rgb'], ['parade', 'luma'], ['histogram', 'rgb'], ['vectorscope', 'luma']]) {
    scopes.push(await img((await t.run('scope', { type, channels, resolution: 256 }, { image: src })).image));
  }
  // pad to equal widths for the sheet
  const wMax = Math.max(...scopes.map((s) => s.width));
  const padded = scopes.map((s) => {
    const d = new Uint8ClampedArray(wMax * s.height * 4);
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) for (let c = 0; c < 4; c++) d[(y * wMax + x) * 4 + c] = s.data[(y * s.width + x) * 4 + c];
    return { data: d, width: wMax, height: s.height };
  });
  writePng('grade-scopes', sheet(padded, 2), false);
  expect(CHART_W * CHART_H).toBeGreaterThan(0);
});
