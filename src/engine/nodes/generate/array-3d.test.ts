import { describe, expect, it } from 'vitest';
import { seamRatio } from '../../lib/copy-testutil';
import { harness } from '../../testing';
import type { CameraValue } from '../../types';

const project = { width: 64, height: 64 };
const RED: [number, number, number, number] = [255, 0, 0, 255];

const run = async (t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, inputs: Record<string, unknown>, seconds?: number) =>
  t.pixels((await t.run('array-3d', params, inputs as never, { project, seconds })).image as never);

describe('array-3d', () => {
  it('draws one card in the middle with transparency around it', async () => {
    const t = await harness();
    const px = await run(t, { countX: 1, countY: 1, countZ: 1 }, { image: t.solid(8, 8, RED) });
    expect([px.width, px.height]).toEqual([64, 64]);
    expect(px.at(32, 32)).toEqual(RED);
    expect(px.at(2, 2)[3]).toBe(0);
  });

  it('depth buffer decides overlaps: the nearer card wins whatever the draw order', async () => {
    const t = await harness();
    const params = { countX: 1, countY: 1, countZ: 2, spacingZ: 1, cardWidth: 2, tintMode: 'fill', tintA: [1, 0, 0, 1], tintB: [0, 0, 1, 1] };
    const px = await run(t, params, { image: t.solid(8, 8, [200, 200, 200, 255]) });
    // card 0 is nearest (z = 0, camera on -z) and is drawn FIRST; card 1 is behind it and drawn second
    expect(px.at(32, 32)).toEqual(RED);
    const back = await run(t, { ...params, travel: 0, tintA: [0, 0, 1, 1], tintB: [1, 0, 0, 1] }, { image: t.solid(8, 8, [200, 200, 200, 255]) });
    expect(back.at(32, 32)).toEqual([0, 0, 255, 255]);
  });

  it('alpha test: transparent texels of a near card show the card behind', async () => {
    const t = await harness();
    // left half transparent
    const src = t.fromFn(8, 8, (x) => [200, 200, 200, x < 4 ? 0 : 255]);
    const px = await run(t, { countX: 1, countY: 1, countZ: 2, spacingZ: 0.5, cardWidth: 2, cardRoll: 180, tintMode: 'fill', tintA: [1, 0, 0, 1], tintB: [0, 0, 1, 1] }, { image: src });
    // card 0 (red) only has a right half; its left half lets the (smaller-looking) blue card behind show through
    const right = px.at(40, 32);
    expect(right).toEqual(RED);
    const left = px.at(24, 32);
    expect(left[3]).toBe(255);
    expect(left[2]).toBeGreaterThan(200);
    expect(left[0]).toBe(0);
  });

  it('refuses more than 20,000 cards with a readable error', async () => {
    const t = await harness();
    await expect(run(t, { countX: 40, countY: 40, countZ: 20 }, { image: t.solid(4, 4, RED) })).rejects.toThrow(/20,000/);
    await expect(run(t, { layout: 'tunnel', countX: 100, countZ: 300 }, { image: t.solid(4, 4, RED) })).rejects.toThrow(/limit/);
  });

  it('every layout renders something', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x, y) => [x * 30, y * 30, 120, 255]);
    for (const layout of ['grid', 'tunnel', 'ring', 'helix']) {
      const px = await run(t, { layout, countX: 6, countY: 2, countZ: 6 }, { image: src });
      let filled = 0;
      for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 0) filled++;
      expect(filled, layout).toBeGreaterThan(40);
    }
  });

  it('a wired camera replaces the default one', async () => {
    const t = await harness();
    const cam: CameraValue = { kind: 'camera', projection: 'orthographic', fov: 40, orthoSize: 8, position: [0, 0, -5], target: [0, 0, 0], roll: 0, shift: [0, 0] };
    const src = t.solid(8, 8, RED);
    const a = await run(t, { countX: 1, countY: 1, countZ: 1 }, { image: src });
    const b = await run(t, { countX: 1, countY: 1, countZ: 1 }, { image: src, camera: cam });
    // orthographic, 8 units across, card 1 unit wide: 8 pixels wide, much smaller than the default framing
    expect(b.at(32, 32)).toEqual(RED);
    expect(b.at(20, 32)[3]).toBe(0);
    expect(a.at(20, 32)[3]).toBeGreaterThan(0);
  });

  it('sprite sheet: each card shows its own sprite', async () => {
    const t = await harness();
    const src = t.fromFn(8, 4, (x) => (x < 4 ? RED : [0, 0, 255, 255]));
    const px = await run(t, { countX: 2, countY: 1, countZ: 1, spacingX: 1.2, cardWidth: 1, sheetColumns: 2, sheetRows: 1 }, { image: src });
    let left = 0;
    let right = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const [r, , b, a] = px.at(x, y);
        if (a < 255) continue;
        if (x < 32 && r > 200) left++;
        if (x >= 32 && b > 200) right++;
      }
    }
    expect(left).toBeGreaterThan(100);
    expect(right).toBeGreaterThan(100);
  });

  it('fog fades far cards to the fog colour', async () => {
    const t = await harness();
    const base = { layout: 'tunnel', countX: 1, countZ: 6, radius: 0, spacingZ: 2, cardWidth: 4, stepRotate: 0 };
    const src = t.solid(4, 4, [255, 255, 255, 255]);
    const clear = await run(t, base, { image: src });
    const fogged = await run(t, { ...base, fog: true, fogColor: [0, 0, 0, 1], fogStart: 0.5, fogEnd: 2 }, { image: src });
    expect(clear.at(32, 32)[0]).toBeGreaterThan(200);
    expect(fogged.at(32, 32)[0]).toBeLessThan(clear.at(32, 32)[0]);
  });

  it('streams forever: a whole number of spacings per loop closes the loop; colours by depth too', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x, y) => [x * 30, y * 30, 150, 255]);
    const a = await seamRatio(t, 'array-3d', { layout: 'tunnel', countX: 4, countZ: 6, radius: 1.5, stepRotate: 20, travel: 1, fog: true, fogStart: 3, fogEnd: 9 }, { image: src }, 12, { width: 48, height: 48 });
    expect(a.motion).toBeGreaterThan(0.3);
    expect(a.wrap).toBeLessThan(a.max * 1.5 + 0.5);
    const b = await seamRatio(t, 'array-3d', { layout: 'grid', countX: 3, countY: 3, countZ: 5, travel: 2, colourBy: 'depth', tintMode: 'multiply', hueStep: 40 }, { image: src }, 12, { width: 48, height: 48 });
    expect(b.wrap).toBeLessThan(b.max * 1.5 + 0.5);
    const c = await seamRatio(t, 'array-3d', { layout: 'ring', countX: 7, countY: 2, orbit: 1 }, { image: src }, 12, { width: 48, height: 48 });
    expect(c.motion).toBeGreaterThan(0.3);
    expect(c.wrap).toBeLessThan(c.max * 1.5 + 0.5);
  });

  it('one draw call and no new pipeline whatever the card count', async () => {
    const t = await harness();
    const src = t.solid(4, 4, RED);
    await run(t, { countX: 2, countY: 2, countZ: 2 }, { image: src }); // warm-up: compiles the one pipeline
    const device = t.gpu.device;
    const queue = device.queue as unknown as { submit: (b: unknown[]) => void };
    const realSubmit = queue.submit.bind(queue);
    let submits = 0;
    queue.submit = (b) => {
      submits++;
      realSubmit(b);
    };
    const dev = device as unknown as { createRenderPipeline: (d: unknown) => unknown; createShaderModule: (d: unknown) => unknown };
    const rp = dev.createRenderPipeline.bind(dev);
    const sm = dev.createShaderModule.bind(dev);
    let pipelines = 0;
    let modules = 0;
    dev.createRenderPipeline = (d) => (pipelines++, rp(d));
    dev.createShaderModule = (d) => (modules++, sm(d));
    try {
      await t.run('array-3d', { countX: 25, countY: 25, countZ: 30, spacingX: 0.2, spacingY: 0.2, travel: 3, hueStep: 7 }, { image: src } as never, { project, seconds: 0.4 });
      await t.run('array-3d', { layout: 'tunnel', countX: 200, countZ: 100, fog: true, fogEnd: 33 }, { image: src } as never, { project });
    } finally {
      queue.submit = realSubmit;
      dev.createRenderPipeline = rp;
      dev.createShaderModule = sm;
    }
    expect(submits).toBe(2); // one command buffer (one render pass, one instanced draw) per render
    expect(pipelines).toBe(0);
    expect(modules).toBe(0);
  });
});
