import { describe, expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { movingBarSource, timeChain } from '../../lib/fx-testutil';

const OFF = { glow: 0, halation: 0, vignette: 0, convergence: 0, curveX: 0, curveY: 0, cornerRadius: 0, maskType: 'none', blackLevel: 0, saturation: 1 };

describe('crt-display', () => {
  it('Auto output size enlarges small pixel art by a whole number', async () => {
    const t = await harness();
    const out = await t.run('crt-display', {}, { image: t.solid(16, 12, [120, 120, 120, 255]) });
    const img = out.image as { width: number; height: number; unit: number };
    expect(img.width / 16).toBe(img.height / 12);
    expect(img.width).toBeGreaterThan(64);
    const same = await t.run('crt-display', { outputScale: 'same' }, { image: t.solid(16, 12, [120, 120, 120, 255]) });
    expect((same.image as { width: number }).width).toBe(16);
  });

  it('one scan line per picture row: dark gaps between rows, locked to the art pixels', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '8', scanStrength: 1, beamWidth: 0.2 }, { image: t.solid(8, 8, [180, 180, 180, 255]) })).image as never);
    const col = Array.from({ length: 8 }, (_, y) => px.at(32, 24 + y)[1]);
    expect(Math.max(...col)).toBeGreaterThan(Math.min(...col) + 60);
    expect(px.at(32, 24)[1]).toBe(px.at(32, 32)[1]); // period = 8 output px = one picture row
    const flat = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '8', scanStrength: 0 }, { image: t.solid(8, 8, [180, 180, 180, 255]) })).image as never);
    expect(Math.abs(flat.at(32, 24)[1] - flat.at(32, 28)[1])).toBeLessThan(3);
  });

  it('bright lines grow fatter than dark ones', async () => {
    const t = await harness();
    const run = async (v: number) => {
      const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '8', scanStrength: 1, beamWidth: 0.2, beamBloom: 0.4 }, { image: t.solid(8, 8, [v, v, v, 255]) })).image as never);
      const col = Array.from({ length: 8 }, (_, y) => px.at(32, 24 + y)[1] / 255);
      return Math.min(...col) / Math.max(...col);
    };
    expect(await run(250)).toBeGreaterThan(await run(90));
  });

  it('aperture grille splits the picture into red, green and blue stripes without darkening it much', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [140, 140, 140, 255]);
    const base = { ...OFF, outputScale: '4', scanStrength: 0 };
    const on = await t.pixels((await t.run('crt-display', { ...base, maskType: 'aperture', maskStrength: 1, maskPitch: 0.75 }, { image: src })).image as never);
    const off = await t.pixels((await t.run('crt-display', base, { image: src })).image as never);
    const row = Array.from({ length: 12 }, (_, x) => on.at(8 + x, 16));
    const dominant = new Set(row.map((c) => c.indexOf(Math.max(c[0], c[1], c[2]))));
    expect(dominant.size).toBe(3);
    let mOn = 0;
    let mOff = 0;
    for (let x = 8; x < 20; x++) for (let c = 0; c < 3; c++) { mOn += on.at(x, 16)[c]; mOff += off.at(x, 16)[c]; }
    expect(mOn / mOff).toBeGreaterThan(0.75);
    expect(mOn / mOff).toBeLessThan(1.3);
  });

  it('every mask type renders (slot, shadow, fine)', async () => {
    const t = await harness();
    for (const maskType of ['slot', 'shadow', 'pvm']) {
      const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '4', maskType, maskStrength: 1 }, { image: t.solid(8, 8, [140, 140, 140, 255]) })).image as never);
      const vals = new Set<number>();
      for (let x = 0; x < 32; x++) vals.add(px.at(x, 5)[0] + px.at(x, 5)[1] * 256);
      expect(vals.size, maskType).toBeGreaterThan(2);
    }
  });

  it('blend dither smooths a one-pixel checkerboard', async () => {
    const t = await harness();
    const checker = t.checker(16, 16, 1);
    const spread = async (blendDither: number) => {
      const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '4', scanStrength: 0, blendDither, colorBleed: 0 }, { image: checker })).image as never);
      const row = Array.from({ length: 16 }, (_, x) => px.at(24 + x, 32)[1]);
      return Math.max(...row) - Math.min(...row);
    };
    expect(await spread(1)).toBeLessThan((await spread(0)) * 0.6);
  });

  it('curvature rounds the screen: black corners, or transparent when asked', async () => {
    const t = await harness();
    const src = t.solid(16, 16, [200, 200, 200, 255]);
    const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '4', curveX: 1, curveY: 1, cornerRadius: 0.2 }, { image: src })).image as never);
    expect(px.at(0, 0).slice(0, 4)).toEqual([0, 0, 0, 255]);
    expect(px.at(32, 32)[0]).toBeGreaterThan(120);
    const open = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '4', curveX: 1, curveY: 1, cornerRadius: 0.2, blackOutside: false }, { image: src })).image as never);
    expect(open.at(0, 0)[3]).toBe(0);
  });

  it('transparent input shows a dark tube, never a hole', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('crt-display', { ...OFF, outputScale: '4' }, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
    expect(px.at(16, 16)[3]).toBe(255);
    expect(px.at(16, 16)[0]).toBeLessThan(12);
  });

  it('glow spreads light into dark neighbours; presets change the picture', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => (Math.hypot(x - 8, y - 8) < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const base = { ...OFF, outputScale: '4', scanStrength: 0 };
    const a = await t.pixels((await t.run('crt-display', { ...base, glow: 1 }, { image: src })).image as never);
    const b = await t.pixels((await t.run('crt-display', base, { image: src })).image as never);
    expect(a.at(32 + 14, 32)[0]).toBeGreaterThan(b.at(32 + 14, 32)[0] + 5);
    const outs = new Set<string>();
    for (const preset of ['arcade', 'consumer', 'trinitron', 'portable', 'terminal', 'lcd']) {
      const px = await t.pixels((await t.run('crt-display', { preset }, { image: src })).image as never);
      outs.add(Array.from(px.at(30, 20)).join());
    }
    expect(outs.size).toBeGreaterThan(3);
    const term = await t.pixels((await t.run('crt-display', { preset: 'terminal' }, { image: t.solid(16, 16, [200, 100, 200, 255]) })).image as never);
    const c = term.at(60, 60);
    expect(c[1]).toBeGreaterThan(c[0]);
    expect(c[1]).toBeGreaterThan(c[2]);
  });

  it('phosphor persistence leaves a ghost of the previous frames and wraps with the loop', async () => {
    const t = await harness([movingBarSource()]);
    const params = { ...OFF, outputScale: 'same', scanStrength: 0, blendDither: 0, colorBleed: 0, brightness: 1 };
    const ghost = async (persistence: number, seconds: number) => {
      const { graph, node } = timeChain(t, 'fx-moving-bar', 'crt-display', { ...params, persistence });
      return t.pixels((await t.evalGraph(graph, node, { seconds })) as never);
    };
    const off = await ghost(0, 1);
    const on = await ghost(2, 1);
    expect(on.at(17, 10)[0]).toBeGreaterThan(off.at(17, 10)[0] + 40);
    // frame 0 pulls frames 19 and 18 (bar at 38%32=6 and 4): the ghost joins the loop
    const first = await ghost(2, 0);
    expect(first.at(5, 10)[0]).toBeGreaterThan(60);
  });

  it('static noise and the hum bar animate and loop', async () => {
    const t = await harness();
    const src = t.solid(16, 16, [120, 120, 120, 255]);
    const n = await t.loopCheck('crt-display', { ...OFF, outputScale: 'same', noise: 0.8 }, { image: src });
    expect(n.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(n.motion).toBeGreaterThan(0.5);
    const h = await t.loopCheck('crt-display', { ...OFF, outputScale: 'same', hum: 1, humCycles: 1 }, { image: src });
    expect(h.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(h.motion).toBeGreaterThan(0.2);
    const still = await t.loopCheck('crt-display', { ...OFF, outputScale: 'same' }, { image: src });
    expect(still.motion).toBe(0);
  });
});

describe('crt-display flat screen', () => {
  it('Curved screen off fills the frame to the corners with any preset; on, the corners are cut out', async () => {
    const t = await harness();
    const src = t.solid(160, 120, [200, 200, 200, 255]);
    for (const preset of ['arcade', 'portable', 'consumer']) {
      const curved = await t.pixels((await t.run('crt-display', { preset, outputScale: 'same' }, { image: src })).image as never);
      const flat = await t.pixels((await t.run('crt-display', { preset, outputScale: 'same', curved: false }, { image: src })).image as never);
      const lum = (c: number[]) => c[0] + c[1] + c[2];
      expect(lum(flat.at(1, 1)) + lum(flat.at(158, 118))).toBeGreaterThan(lum(curved.at(1, 1)) + lum(curved.at(158, 118)) + 60);
      expect(flat.at(0, 0)[3]).toBe(255);
    }
  });
});
