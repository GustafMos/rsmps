import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { fitDistance, layoutPanes, layoutRadius, orbitCamera, type LayoutOptions } from '../../lib/frame-array';
import { harness } from '../../testing';
import type { AnyNodeDef, ImageValue } from '../../types';

const W = 96;
const H = 54;
const project = { width: W, height: H, fps: 10, duration: 2, loop: true };

/** A clip whose whole picture is one colour that says which frame it is: red = 10 per frame. Counts how often it renders. */
function frameColorSource(id: string, spy: { n: number }): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test clip: the frame number as a colour',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      return {
        image: ctx.gpu.pass({
          size: ctx.canvas,
          uniforms: { red: (ctx.time.frame * 10) / 255 },
          wgsl: /* wgsl */ `fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.red, 0.0, 1.0, 1.0); }`,
        }),
      };
    },
  });
}

// a row of three seen straight on, with nothing that changes a pane's colour
const base = { layout: 'row', count: 3, yaw: 0, tilt: 0, swing: 0, distance: 1, fov: 40, fade: 0, dim: 0, border: 0, background: [0, 0, 0, 1] };
const layout: LayoutOptions = { layout: 'row', count: 3, aspect: W / H, spacing: 1, arc: 360, fan: [0, 0], grid: [1, 1, 1] };

/** The pixel where the middle of pane k lands for the camera above. */
function paneCenterPixel(k: number): [number, number] {
  const cam = orbitCamera(0, 0, fitDistance(layoutRadius(layout), 40), 40);
  const c = layoutPanes(layout)[k].center;
  const sx = c[0] / (cam.pos[2] * cam.tanHalf * (W / H));
  return [Math.round((sx * 0.5 + 0.5) * W - 0.5), Math.round(H / 2)];
}

describe('frame-array', () => {
  it('every pane shows the clip at its own moment', async () => {
    const spy = { n: 0 };
    const t = await harness([frameColorSource('fa-clip', spy)]);
    // 20 frames in the loop; three panes over 30% of it = 2 frames between neighbours
    const run = async (params: Record<string, unknown>, seconds: number) => t.pixels((await t.run('frame-array', { ...base, ...params }, { image: { node: 'fa-clip' } }, { project, seconds })).image as ImageValue);
    const px = await run({ flow: 'play', span: 0.3 }, 0.5);
    const reds = [0, 1, 2].map((k) => px.at(...paneCenterPixel(k))[0]);
    expect(reds[0]).toBeCloseTo(50, -1);
    expect(reds[1]).toBeCloseTo(70, -1);
    expect(reds[2]).toBeCloseTo(90, -1);
    // between the panes and around them: the background
    expect(px.at(2, 2)).toEqual([0, 0, 0, 255]);
    // looking back in time, and wrapping around the start of the loop
    const back = await run({ flow: 'play', span: -0.3 }, 0.1);
    expect([0, 1, 2].map((k) => back.at(...paneCenterPixel(k))[0])).toEqual([10, 190, 170]);
    // still frames: the same three frames whatever the time
    for (const seconds of [0, 0.7]) {
      const sheet = await run({ flow: 'sheet', span: 0.3 }, seconds);
      expect([0, 1, 2].map((k) => sheet.at(...paneCenterPixel(k))[0])).toEqual([0, 20, 40]);
    }
  });

  it('pulls one frame per pane, and none for a still picture', async () => {
    const spy = { n: 0 };
    const t = await harness([frameColorSource('fa-clip2', spy)]);
    await t.run('frame-array', { ...base, flow: 'play', span: 0.3 }, { image: { node: 'fa-clip2' } }, { project, seconds: 0.5 });
    expect(spy.n).toBe(3);
    // nine panes over two frames: only two different moments to fetch
    spy.n = 0;
    await t.run('frame-array', { ...base, count: 9, flow: 'play', span: 0.05 }, { image: { node: 'fa-clip2' } }, { project, seconds: 1 });
    expect(spy.n).toBe(2);
    const still = t.solid(W, H, [40, 200, 90, 255]);
    const px = await t.pixels((await t.run('frame-array', { ...base, flow: 'play' }, { image: still }, { project, seconds: 0.5 })).image as ImageValue);
    for (const k of [0, 1, 2]) expect(px.at(...paneCenterPixel(k))).toEqual([40, 200, 90, 255]);
  });

  it('nearer panes cover farther ones, and Add lets them shine through', async () => {
    const spy = { n: 0 };
    const t = await harness([frameColorSource('fa-clip3', spy)]);
    const stack = { ...base, layout: 'stack', fan: [0, 0], flow: 'play', span: 0.3 };
    const front = await t.pixels((await t.run('frame-array', stack, { image: { node: 'fa-clip3' } }, { project, seconds: 0.5 })).image as ImageValue);
    // straight on, the first pane (the present frame, 5) hides the rest
    expect(front.at(W / 2, H / 2)[0]).toBeCloseTo(50, -1);
    const behind = await t.pixels((await t.run('frame-array', { ...stack, yaw: 180 }, { image: { node: 'fa-clip3' } }, { project, seconds: 0.5 })).image as ImageValue);
    expect(behind.at(W / 2, H / 2)[0]).toBeCloseTo(90, -1);
    const add = await t.pixels((await t.run('frame-array', { ...stack, blend: 'add' }, { image: { node: 'fa-clip3' } }, { project, seconds: 0.5 })).image as ImageValue);
    expect(add.at(W / 2, H / 2)[0]).toBeCloseTo(50 + 70 + 90, -1);
  });

  it('marks the present pane and draws borders', async () => {
    const t = await harness();
    // four times larger than the other tests, so a border is a few pixels wide (a tenth of a pane about 35 pixels high)
    const still = t.solid(W * 4, H * 4, [100, 100, 100, 255]);
    const px = await t.pixels((await t.run('frame-array', { ...base, flow: 'play', dim: 0.5, border: 0.1, borderColor: [0, 0, 1, 1], nowColor: [1, 0, 0, 1] }, { image: still }, { project })).image as ImageValue);
    const x = (k: number) => paneCenterPixel(k)[0] * 4 + 2;
    const y = H * 2;
    expect(px.at(x(0), y)[0]).toBeCloseTo(100, -1);
    expect(px.at(x(1), y)[0]).toBeCloseTo(50, -1);
    expect(px.at(x(2), y)[0]).toBeCloseTo(50, -1);
    // along the middle line: the present pane has a red border on both sides, the others a blue one
    const between = (x(0) + x(1)) / 2;
    const red: number[] = [];
    const blue: number[] = [];
    for (let i = 0; i < px.width; i++) {
      const [r, , b2] = px.at(i, y);
      if (r > 200 && b2 < 40) red.push(i);
      if (b2 > 200 && r < 40) blue.push(i);
    }
    expect(red.length).toBeGreaterThanOrEqual(4);
    expect(blue.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...red)).toBeLessThan(x(0));
    expect(Math.max(...red)).toBeGreaterThan(x(0));
    expect(Math.max(...red)).toBeLessThan(between);
    expect(Math.min(...blue)).toBeGreaterThan(between);
  });

  it('a clear background stays transparent between the panes', async () => {
    const t = await harness();
    const still = t.solid(W, H, [100, 100, 100, 255]);
    const px = await t.pixels((await t.run('frame-array', { ...base, background: [0, 0, 0, 0] }, { image: still }, { project })).image as ImageValue);
    expect(px.at(2, 2)[3]).toBe(0);
    expect(px.at(...paneCenterPixel(1))[3]).toBe(255);
  });
});
