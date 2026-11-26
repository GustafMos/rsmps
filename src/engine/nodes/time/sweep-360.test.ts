import { expect, it } from 'vitest';
import { addNode, connect, createGraph, setParam } from '../../graph';
import { defineNode } from '../../define';
import { numberSource } from '../../lib/util-testsource';
import { harness } from '../../testing';
import type { GraphDoc, ImageValue } from '../../types';

/** A picture whose red is x, green is y and blue is a colour per frame, so every painted patch says which frame made it. */
const picture = (w: number, h: number) =>
  defineNode({
    id: 'sw-pic',
    title: 'sw-pic',
    category: 'input',
    description: 'test picture',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      return {
        image: ctx.gpu.pass({
          size: { width: w, height: h, unit: 1 },
          uniforms: { fr: ctx.time.frame },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(uv.x, uv.y, (30.0 + 18.0 * u.fr) / 255.0, 1.0); }',
        }),
      };
    },
  });

/** Where the camera points on each frame: [yaw, pitch, roll] in degrees. */
type Aim = [number, number, number?];

async function rig(aims: Aim[], params: Record<string, unknown> = {}, pw = 64, ph = 64) {
  const t = await harness([
    picture(pw, ph),
    numberSource('sw-yaw', (f) => aims[Math.min(f, aims.length - 1)][0]),
    numberSource('sw-pitch', (f) => aims[Math.min(f, aims.length - 1)][1]),
    numberSource('sw-roll', (f) => aims[Math.min(f, aims.length - 1)][2] ?? 0),
  ]);
  let g: GraphDoc = createGraph('sweep-test');
  g.project = { ...g.project, fps: 10, duration: 100, loop: false, width: 64, height: 64 };
  const pic = addNode(g, t.registry, 'sw-pic');
  const sw = addNode(pic.graph, t.registry, 'sweep-360', { x: 0, y: 0 }, { height: '512', ...params });
  g = connect(sw.graph, t.registry, { node: pic.node.id, port: 'image' }, { node: sw.node.id, port: 'image' });
  for (const [id, port] of [['sw-yaw', 'yaw'], ['sw-pitch', 'pitch'], ['sw-roll', 'roll']]) {
    const n = addNode(g, t.registry, id);
    g = connect(n.graph, t.registry, { node: n.node.id, port: 'value' }, { node: sw.node.id, port });
  }
  const node = sw.node.id;
  const state = { g };
  const frame = async (f: number) => (await t.evalGraph(state.g, node, { seconds: f / 10 })) as ImageValue;
  const set = (key: string, value: unknown) => {
    state.g = setParam(state.g, node, key, value);
  };
  return { t, frame, set };
}

const W = 1024;
const H = 512;
/** Canvas pixel at a longitude / latitude (degrees). */
const at = (lon: number, lat: number): [number, number] => [Math.round((lon / 360 + 0.5) * W - 0.5), Math.round((0.5 - lat / 180) * H - 0.5)];
const frameOf = (px: number[]) => Math.round((px[2] - 30) / 18);

it('one frame paints the canvas centre with the picture centre and leaves longitude 180 empty', async () => {
  const { t, frame } = await rig([[0, 0]]);
  const img = await frame(0);
  expect(img.width).toBe(W);
  expect(img.height).toBe(H);
  const px = await t.pixels(img);
  const c = px.at(...at(0, 0));
  expect(Math.abs(c[0] - 128)).toBeLessThan(10);
  expect(Math.abs(c[1] - 128)).toBeLessThan(10);
  expect(frameOf(c)).toBe(0);
  const back = px.at(0, H / 2);
  expect(back[0] + back[1] + back[2]).toBeLessThan(6);
  expect(back[3]).toBe(255);
});

it('turning right paints a patch to the right and keeps the first one; pitch moves the patch up', async () => {
  const { t, frame } = await rig([[0, 0], [90, 0], [0, 30]]);
  await frame(0);
  const px1 = await t.pixels(await frame(1));
  expect(frameOf(px1.at(...at(90, 0)))).toBe(1);
  expect(frameOf(px1.at(...at(0, 0)))).toBe(0);
  expect(px1.at(...at(180, 0))[0]).toBeLessThan(5);
  // red is the picture's x: left of the right-hand patch's centre is darker than right of it
  expect(px1.at(...at(75, 0))[0]).toBeLessThan(px1.at(...at(105, 0))[0]);
  const px2 = await t.pixels(await frame(2));
  // looking 30 degrees up: the picture centre is at latitude 30, the right-hand patch survives, the picture's top is brighter in green terms
  const up = px2.at(...at(0, 30));
  expect(frameOf(up)).toBe(2);
  expect(Math.abs(up[1] - 128)).toBeLessThan(12);
  expect(frameOf(px2.at(...at(90, 0)))).toBe(1);
  // the low part of frame 0 (below frame 2's view) is still frame 0
  expect(frameOf(px2.at(...at(0, -25)))).toBe(0);
});

it('Paused changes nothing, even when switched on in the middle of a sweep', async () => {
  const { t, frame, set } = await rig([[0, 0], [90, 0], [180, 0]]);
  await frame(0);
  const before = await t.pixels(await frame(1));
  set('paint', 'paused');
  const after = await t.pixels(await frame(2));
  let diff = 0;
  for (let i = 0; i < before.data.length; i++) diff = Math.max(diff, Math.abs(before.data[i] - after.data[i]));
  expect(diff).toBeLessThan(1);
  expect(frameOf(after.at(...at(90, 0)))).toBe(1);
});

it('Only new areas keeps the earlier snapshot where the camera comes back', async () => {
  const { t, frame } = await rig([[0, 0], [90, 0], [20, 0]], { paint: 'fresh', soft: 0 });
  await frame(0);
  await frame(1);
  const px = await t.pixels(await frame(2));
  expect(frameOf(px.at(...at(10, 0)))).toBe(0);
  // new ground (to the right of frame 0's view, left of frame 1's) is painted by frame 2
  expect(frameOf(px.at(...at(50, 0)))).toBe(2);
});

it('Clear wipes the canvas and paints only the current view', async () => {
  const { t, frame, set } = await rig([[0, 0], [90, 0], [90, 0]]);
  await frame(0);
  await frame(1);
  set('clear', 1);
  const px = await t.pixels(await frame(2));
  expect(frameOf(px.at(...at(90, 0)))).toBe(2);
  const old = px.at(...at(0, 0));
  expect(old[0] + old[1] + old[2]).toBeLessThan(6);
});

it('Mirror picture flips the picture left to right', async () => {
  const a = await rig([[0, 0]]);
  const b = await rig([[0, 0]], { mirror: true });
  const pa = await a.t.pixels(await a.frame(0));
  const pb = await b.t.pixels(await b.frame(0));
  expect(pa.at(...at(-15, 0))[0]).toBeLessThan(pa.at(...at(15, 0))[0]);
  expect(pb.at(...at(-15, 0))[0]).toBeGreaterThan(pb.at(...at(15, 0))[0]);
});

it('Yaw turns right: the picture painted at yaw 90 is centred on longitude 90 and upright', async () => {
  const { t, frame } = await rig([[90, 0]]);
  const px = await t.pixels(await frame(0));
  // the picture's top is up: green grows downward in the picture
  expect(px.at(...at(90, 10))[1]).toBeLessThan(px.at(...at(90, -10))[1]);
});

it('Roll clockwise tips the picture: its right edge ends up lower on the canvas', async () => {
  const { t, frame } = await rig([[0, 0, 30]]);
  const px = await t.pixels(await frame(0));
  // picture red = x. With the camera rolled clockwise, the camera's right (high red) lies below the centre line
  const right = px.at(...at(10, -10));
  const rightUp = px.at(...at(10, 10));
  expect(right[0]).toBeGreaterThan(rightUp[0]);
});

it('Fade old fades what is not painted back to empty, Blurred fill and Transparent show different empties', async () => {
  const { t, frame } = await rig([[0, 0], [180, 0], [180, 0], [180, 0]], { fade: 100 });
  await frame(0);
  await frame(1);
  await frame(2);
  const px = await t.pixels(await frame(3));
  // 100 percent per second at 10 fps: 0.1 per frame, so frame 0's patch has faded to about 0.7 of its colour by frame 3
  const faded = px.at(...at(0, 0));
  expect(faded[0]).toBeLessThan(120);
  expect(faded[0]).toBeGreaterThan(40);

  const tr = await rig([[0, 0]], { empty: 'transparent' });
  const ptr = await tr.t.pixels(await tr.frame(0));
  expect(ptr.at(0, H / 2)[3]).toBeLessThan(3);
  expect(ptr.at(...at(0, 0))[3]).toBe(255);

  const bl = await rig([[0, 0]], { empty: 'blur' });
  const pbl = await bl.t.pixels(await bl.frame(0));
  const far = pbl.at(0, H / 2);
  expect(far[3]).toBe(255);
  // a smeared copy of the painted patch: neither black nor the grey default
  expect(far[0] + far[1] + far[2]).toBeGreaterThan(30);
});

it('every output renders at its size without NaN, holes or errors', async () => {
  for (const output of ['panorama', 'planet', 'look', 'follow']) {
    const { t, frame } = await rig([[0, 0], [60, 10, 5], [120, -10]], { output, empty: 'blur' }, 64, 48);
    await frame(0);
    await frame(1);
    const img = await frame(2);
    const px = await t.pixels(img);
    if (output === 'panorama') expect([img.width, img.height]).toEqual([W, H]);
    if (output === 'planet') expect([img.width, img.height]).toEqual([H, H]);
    if (output === 'look' || output === 'follow') expect([img.width, img.height]).toEqual([64, 48]);
    let low = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i] < 250) low++;
    expect(low, output).toBe(0);
  }
});

it('Follow phone shows the live picture in the middle with the painted surroundings around it', async () => {
  const { t, frame } = await rig([[0, 0], [40, 0]], { output: 'follow', lookView: 120, view: 70 }, 64, 64);
  await frame(0);
  const px = await t.pixels(await frame(1));
  // the phone points at yaw 40: the middle of the view is the live frame (blue of frame 1), the left part is what frame 0 painted
  expect(frameOf(px.at(32, 32))).toBe(1);
  expect(frameOf(px.at(4, 32))).toBe(0);
});

it('a bigger Canvas height starts a fresh canvas', async () => {
  const { t, frame, set } = await rig([[0, 0], [90, 0]]);
  await frame(0);
  set('height', '1024');
  const px = await t.pixels(await frame(1));
  expect(px.width).toBe(2048);
  const old = px.at(1024, 512);
  expect(old[0] + old[1] + old[2]).toBeLessThan(6);
});
