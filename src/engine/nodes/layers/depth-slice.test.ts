import { describe, expect, it } from 'vitest';
import { harness } from '../../lib/mask-test';

describe('depth-slice', () => {
  it('splits by a depth map into filled layers', async () => {
    const t = await harness();
    // Three vertical bands: red (far) | green (mid) | blue (near) with matching depth values.
    const band = (x: number) => (x < 32 ? 0 : x < 64 ? 1 : 2);
    const colors: [number, number, number, number][] = [[210, 50, 50, 255], [50, 190, 70, 255], [60, 80, 220, 255]];
    const img = t.fromFn(96, 64, (x) => colors[band(x)]);
    const depth = t.fromFn(96, 64, (x) => {
      const v = [30, 128, 225][band(x)];
      return [v, v, v, 255];
    });
    const out = await t.run('depth-slice', { layers: 3, distribution: 'even', grow: 1, texture: 0, softness: 0.01 }, { image: img, depth });
    const l1 = await t.pixels(out.layer1 as never);
    const l2 = await t.pixels(out.layer2 as never);
    const l3 = await t.pixels(out.layer3 as never);
    expect(out.layer4).toBeNull();
    // Layer 1 (back): opaque everywhere, red slice kept, the hidden parts filled with red.
    expect(l1.at(10, 30)[3]).toBe(255);
    expect(l1.at(48, 30)[3]).toBe(255);
    expect(l1.at(10, 30)[0]).toBeGreaterThan(190);
    expect(l1.at(80, 30)[0]).toBeGreaterThan(170); // filled behind the blue band with red
    expect(l1.at(80, 30)[2]).toBeLessThan(100);
    // Layer 2: transparent where only the far slice is, green in its own slice, green fill behind the near slice.
    expect(l2.at(10, 30)[3]).toBeLessThan(10);
    expect(l2.at(48, 30)[3]).toBe(255);
    expect(l2.at(48, 30)[1]).toBeGreaterThan(160);
    expect(l2.at(85, 30)[3]).toBeGreaterThan(245);
    expect(l2.at(85, 30)[1]).toBeGreaterThan(150);
    expect(l2.at(85, 30)[2]).toBeLessThan(120);
    // Layer 3 (front): only the near slice.
    expect(l3.at(85, 30)[3]).toBeGreaterThan(245);
    expect(l3.at(85, 30)[2]).toBeGreaterThan(190);
    expect(l3.at(10, 30)[3]).toBeLessThan(10);
    expect(l3.at(48, 30)[3]).toBeLessThan(10);
    expect(out.depth && (out.depth as { kind: string }).kind).toBe('mask');
  });

  it('without a depth map, the vertical cue makes lower rows nearer', async () => {
    const t = await harness();
    const img = t.fromFn(64, 96, (x, y) => [90 + (x & 31), 120 + (y >> 2), 160, 255]);
    const out = await t.run('depth-slice', { layers: 3, vertical: 1, sharpness: 0, saturation: 0, brightness: 0, texture: 0 }, { image: img });
    const front = await t.pixels(out.layer3 as never);
    const back = await t.pixels(out.layer1 as never);
    expect(front.at(32, 90)[3]).toBeGreaterThan(240);
    expect(front.at(32, 5)[3]).toBeLessThan(15);
    expect(back.at(32, 5)[3]).toBe(255);
    expect(back.at(32, 90)[3]).toBe(255);
    const depth = await t.pixels(out.depth as never);
    expect(depth.at(32, 90)[0]).toBeGreaterThan(depth.at(32, 5)[0] + 120);
  });

  it('two layers; inverted depth maps flip the order', async () => {
    const t = await harness();
    const img = t.fromFn(64, 64, (x) => (x < 32 ? [220, 60, 60, 255] : [60, 60, 220, 255]));
    const depth = t.fromFn(64, 64, (x) => (x < 32 ? [20, 20, 20, 255] : [235, 235, 235, 255]));
    const a = await t.run('depth-slice', { layers: 2, texture: 0, distribution: 'even' }, { image: img, depth });
    expect((await t.pixels(a.layer2 as never)).at(50, 30)[3]).toBeGreaterThan(240);
    expect((await t.pixels(a.layer2 as never)).at(10, 30)[3]).toBeLessThan(15);
    const b = await t.run('depth-slice', { layers: 2, texture: 0, distribution: 'even', invertDepth: true }, { image: img, depth });
    expect((await t.pixels(b.layer2 as never)).at(10, 30)[3]).toBeGreaterThan(240);
    expect((await t.pixels(b.layer2 as never)).at(50, 30)[3]).toBeLessThan(15);
    expect(a.layer3).toBeNull();
  });
});
