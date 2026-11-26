/**
 * Marker Camera end to end on the GPU: a picture of a marker on a table, drawn by a software renderer for a known camera, goes
 * through the node; a 3D Object is rendered with the camera the node outputs and must land where the marker is in the picture.
 */
import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { cameraBasis } from '../../lib/gen-camera';
import { cameraFromPose, projectPoint, rotationAngle, poseFromCamera, type MarkerPose, type Pt } from '../../lib/marker-pose';
import { greyToRgba, orbitPose, renderScene, trueCorners } from '../../lib/marker-testutil';
import { harness, type Harness } from '../../testing';
import { addNode, connect, createGraph } from '../../graph';
import type { AnyNodeDef, CameraValue, GraphDoc, ImageValue, RegionsValue } from '../../types';

const FOV = 50;
const [W, H] = [480, 270];
const SPIN0 = { spinX: 0, spinY: 0, spinZ: 0, rotX: 0, rotY: 0, rotZ: 0 };

function picture(t: Harness, pose: MarkerPose, o: { width?: number; height?: number; id?: number; mirror?: boolean } = {}): ImageValue {
  const width = o.width ?? W;
  const height = o.height ?? H;
  const g = renderScene({ width, height, fov: FOV, pose, id: o.id ?? 0, mirror: o.mirror, samples: 2 });
  const img = t.gpu.upload(greyToRgba(g), width, height, 1, true);
  t.gpu.retain(img.texture);
  return img;
}

/** Centre of everything opaque in a picture, in pixels (pixel centres). */
async function centreOf(t: Harness, img: ImageValue): Promise<{ n: number; x: number; y: number }> {
  const px = await t.pixels(img);
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const a = px.data[(y * px.width + x) * 4 + 3] / 255;
      n += a;
      sx += (x + 0.5) * a;
      sy += (y + 0.5) * a;
    }
  return { n, x: sx / n, y: sy / n };
}

const BASE = { fov: FOV, smoothing: 0, objectSize: 1, floor: 0, analysis: '480' };

describe('marker-camera: the object lands on the marker', () => {
  const views: [string, number, number, number, number][] = [
    ['front', 5, 0, 50, 0],
    ['from the left', 5, -90, 45, 0],
    ['from the right', 5, 90, 45, 0],
    ['from behind', 5, 180, 45, 0],
    ['close', 2.6, 30, 60, -15],
    ['far', 8, -140, 50, 20],
    ['turned in the plane', 4.5, 0, 80, 40],
    ['low', 5.5, 60, 24, 0],
  ];
  it('a small ball placed on each corner of the marker is drawn on that corner, from every side', async () => {
    const t = await harness();
    let worst = 0;
    for (const [name, d, az, el, roll] of views) {
      const truth = orbitPose(d, az, el, roll, [0.15, 0, -0.1]);
      const img = picture(t, truth);
      const out = await t.run('marker-camera', BASE, { image: img });
      expect(out.found, name).toBe(1);
      const camera = out.camera as CameraValue;
      // the camera itself: where the phone is (the marker is 2 scene units wide at Object size 1) and how it is turned
      const want = cameraFromPose(truth, { fov: FOV, markerWidth: 2, floor: 0 });
      const got = poseFromCamera(camera, { markerWidth: 2, floor: 0 });
      expect((rotationAngle(got.r, truth.r) * 180) / Math.PI, name).toBeLessThan(2.5);
      const dist = Math.hypot(...want.position);
      expect(Math.hypot(camera.position[0] - want.position[0], camera.position[1] - want.position[1], camera.position[2] - want.position[2]) / dist, name).toBeLessThan(0.04);
      // corners of the marker in scene units: top-left (-1, +1), top-right (+1, +1) on the x / z ground plane; and the middle
      const corners = trueCorners({ width: W, height: H, fov: FOV, pose: truth });
      const spots: [number, number, Pt][] = [[-1, 1, corners[0]], [1, 1, corners[1]], [1, -1, corners[2]], [0, 0, projectPoint(truth, [0, 0, 0], W, H, FOV)!]];
      for (const [x, z, at] of spots) {
        const obj = await t.run('object-3d', { shape: 'sphere', objectScale: 0.12, posX: x, posY: 0, posZ: z, ...SPIN0 }, { camera, size: img } as never);
        const c = await centreOf(t, obj.image as ImageValue);
        expect(c.n, `${name} ${x},${z}`).toBeGreaterThan(4);
        const off = Math.hypot(c.x - at[0], c.y - at[1]);
        worst = Math.max(worst, off);
        expect(off, `${name} ${x},${z}`).toBeLessThan(2.5);
      }
    }
    // of a 480 pixel wide picture
    expect(worst).toBeLessThan(2.5);
  });
  it('a larger picture is searched in a small copy and still gives the right place; portrait works too', async () => {
    const t = await harness();
    for (const [w, h] of [[1280, 720], [540, 960]]) {
      const truth = orbitPose(5, 40, 50, 10);
      const img = picture(t, truth, { width: w, height: h });
      const out = await t.run('marker-camera', BASE, { image: img });
      expect(out.found).toBe(1);
      const obj = await t.run('object-3d', { shape: 'sphere', objectScale: 0.12, posX: 1, posZ: 1, ...SPIN0 }, { camera: out.camera as CameraValue, size: img } as never);
      const c = await centreOf(t, obj.image as ImageValue);
      const at = trueCorners({ width: w, height: h, fov: FOV, pose: truth })[1];
      // a search copy of 480 pixels for a 1280 pixel picture: under 1.5 search pixels
      expect(Math.hypot(c.x - at[0], c.y - at[1])).toBeLessThan((1.5 * Math.max(w, h)) / 480);
    }
  });
  it('Floor height: the standard cube stands on the paper at the default; Object size scales the scene', async () => {
    const t = await harness();
    const truth = orbitPose(5, 20, 35, 0);
    const img = picture(t, truth);
    const flat = (await t.run('marker-camera', BASE, { image: img })).camera as CameraValue;
    const { fov, smoothing, analysis } = BASE;
    // the defaults: paper at y = -0.55, so the camera is that much lower than with the paper through the origin
    const cam = (await t.run('marker-camera', { fov, smoothing, analysis }, { image: img })).camera as CameraValue;
    expect(cam.position[1]).toBeCloseTo(flat.position[1] - 0.55, 5);
    // the cube (half size 0.55) then touches the paper: the lowest point of its picture is on the marker's plane.
    // Its near bottom corners are the points (x, -0.55, z) of the scene = on the paper, 0.275 marker widths from the middle.
    const obj = await t.run('object-3d', { shape: 'cube', ...SPIN0 }, { camera: cam, size: img } as never);
    const px = await t.pixels(obj.image as ImageValue);
    let lowest = 0;
    for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) if (px.data[(y * px.width + x) * 4 + 3] > 128) lowest = Math.max(lowest, y + 1);
    const feet = [[-0.275, -0.275], [0.275, -0.275], [-0.275, 0.275], [0.275, 0.275]].map(([x, z]) => projectPoint(truth, [x, 0, z], W, H, FOV)![1]);
    expect(Math.abs(lowest - Math.max(...feet))).toBeLessThan(2.5);
    const big = (await t.run('marker-camera', { ...BASE, objectSize: 2 }, { image: img })).camera as CameraValue;
    // twice the object size = the marker is half as wide in scene units = the camera is half as far
    expect(Math.hypot(...big.position)).toBeCloseTo(Math.hypot(...flat.position) / 2, 4);
  });
  it('a mirrored picture (front camera) is flipped back: the Picture output is the true view and the object is on the marker in it', async () => {
    const t = await harness();
    const truth = orbitPose(5, 35, 50, 0);
    const img = picture(t, truth, { mirror: true, id: 2 });
    const out = await t.run('marker-camera', BASE, { image: img });
    expect(out.found).toBe(1);
    const plain = picture(t, truth, { id: 2 });
    expect(await t.diff(out.picture as ImageValue, plain)).toBeLessThan(1.5);
    const obj = await t.run('object-3d', { shape: 'sphere', objectScale: 0.12, posX: -1, posZ: 1, ...SPIN0 }, { camera: out.camera as CameraValue, size: img } as never);
    const c = await centreOf(t, obj.image as ImageValue);
    const at = trueCorners({ width: W, height: H, fov: FOV, pose: truth })[0];
    expect(Math.hypot(c.x - at[0], c.y - at[1])).toBeLessThan(2.5);
    expect((out.regions as RegionsValue).items[0].id).toBe(2);
  });
});

describe('marker-camera: outputs and options', () => {
  it('no marker: Found is 0, no region, and the camera looks away so a 3D object does not show', async () => {
    const t = await harness();
    const out = await t.run('marker-camera', BASE, { image: t.checker(W, H, 40) });
    expect(out.found).toBe(0);
    expect((out.regions as RegionsValue).items).toEqual([]);
    expect(out.distance).toBe(0);
    const obj = await t.run('object-3d', { shape: 'cube' }, { camera: out.camera as CameraValue } as never, { project: { width: 96, height: 96 } });
    expect((await centreOf(t, obj.image as ImageValue)).n).toBe(0);
  });
  it('choose by number; the region is the marker\'s box; Distance is in centimetres of the printed size', async () => {
    const t = await harness();
    const truth = orbitPose(6, 0, 60, 0);
    const img = picture(t, truth, { id: 3 });
    expect((await t.run('marker-camera', { ...BASE, marker: '4' }, { image: img })).found).toBe(1);
    expect((await t.run('marker-camera', { ...BASE, marker: '2' }, { image: img })).found).toBe(0);
    const out = await t.run('marker-camera', { ...BASE, printSize: 10 }, { image: img });
    expect(out.distance as number).toBeGreaterThan(57);
    expect(out.distance as number).toBeLessThan(63);
    const box = (out.regions as RegionsValue).items[0].box;
    const c = trueCorners({ width: W, height: H, fov: FOV, pose: truth });
    expect(box[0] * W).toBeCloseTo(Math.min(...c.map((p) => p[0])), 0);
    expect(box[3] * H).toBeCloseTo(Math.max(...c.map((p) => p[1])), 0);
  });
  it('Picture is the input itself unless something is drawn; the overlay draws the outline; Cover hides the black square', async () => {
    const t = await harness();
    const truth = orbitPose(4, 0, 70, 0);
    const img = picture(t, truth);
    const plain = await t.run('marker-camera', BASE, { image: img });
    expect((plain.picture as ImageValue).texture).toBe(img.texture);
    const corners = trueCorners({ width: W, height: H, fov: FOV, pose: truth });
    const over = await t.pixels((await t.run('marker-camera', { ...BASE, overlay: true }, { image: img })).picture as ImageValue);
    // a quarter along the top side of the marker: green (the middle is where the blue "away" axis ends)
    const mid = [Math.round(corners[0][0] * 0.75 + corners[1][0] * 0.25), Math.round(corners[0][1] * 0.75 + corners[1][1] * 0.25)];
    let green = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (over.at(mid[0] + dx, mid[1] + dy)[1] > 200 && over.at(mid[0] + dx, mid[1] + dy)[0] < 120) green++;
    expect(green).toBeGreaterThan(0);
    // the axes start in the middle of the marker: red (x) to the right of it
    const mx = projectPoint(truth, [0.25, 0, 0], W, H, FOV)!;
    expect(over.at(Math.round(mx[0]), Math.round(mx[1]))[0]).toBeGreaterThan(200);
    const covered = await t.pixels((await t.run('marker-camera', { ...BASE, cover: true }, { image: img })).picture as ImageValue);
    const before = await t.pixels(img);
    // every pixel of the black square is paper-white now; far from the marker nothing changed
    let dark = 0;
    const x0 = Math.ceil(Math.min(...corners.map((p) => p[0])));
    const x1 = Math.floor(Math.max(...corners.map((p) => p[0])));
    const y0 = Math.ceil(Math.min(...corners.map((p) => p[1])));
    const y1 = Math.floor(Math.max(...corners.map((p) => p[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (covered.at(x, y)[0] < 200) dark++;
    expect(dark).toBe(0);
    expect(covered.at(5, 5)).toEqual(before.at(5, 5));
    expect(before.at(Math.round(corners[0][0]) + 4, Math.round(corners[0][1]) + 4)[0]).toBeLessThan(80);
  });
  it('Flat picture: a picture wired in lies on the marker, pinned to its corners', async () => {
    const t = await harness();
    const truth = orbitPose(4.5, 25, 55, 0);
    const img = picture(t, truth);
    // left half red, right half blue: so left and right can be told apart
    const art = t.fromFn(64, 64, (x) => (x < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = await t.run('marker-camera', { ...BASE, stickerSize: 1 }, { image: img, sticker: art });
    const flat = await t.pixels(out.flat as ImageValue);
    const at = (u: number, v: number): [number, number, number, number] => {
      const p = projectPoint(truth, [u, 0, v], W, H, FOV)!;
      return flat.at(Math.round(p[0] - 0.5), Math.round(p[1] - 0.5));
    };
    expect(at(-0.3, 0.2)[0]).toBeGreaterThan(200); // the marker's left side: red
    expect(at(-0.3, 0.2)[2]).toBeLessThan(60);
    expect(at(0.3, -0.2)[2]).toBeGreaterThan(200); // its right side: blue
    expect(at(0.7, 0)[3]).toBe(0); // outside the square: nothing
    expect(at(0, 0.7)[3]).toBe(0);
    const c = await centreOf(t, out.flat as ImageValue);
    const mid = projectPoint(truth, [0, 0, 0], W, H, FOV)!;
    expect(Math.hypot(c.x - mid[0], c.y - mid[1])).toBeLessThan(4);
  });
});

describe('AR Marker node (a marker on a screen)', () => {
  it('every marker it draws is found, with the right number; turning it turns the scene', async () => {
    const t = await harness();
    const project = { width: 320, height: 180 };
    for (let id = 1; id <= 6; id++) {
      const img = (await t.run('marker', { marker: String(id), fill: 0.6 }, {}, { project })).image as ImageValue;
      const out = await t.run('marker-camera', { ...BASE, analysis: '320' }, { image: img });
      expect(out.found, `marker ${id}`).toBe(1);
      expect((out.regions as RegionsValue).items[0].id).toBe(id - 1);
      // seen from straight above, the top edge up on screen: the camera is over the marker and "up" in the picture is +z
      const cam = out.camera as CameraValue;
      expect(cam.position[1]).toBeGreaterThan(2);
      expect(Math.hypot(cam.position[0], cam.position[2])).toBeLessThan(0.05);
      const b = cameraBasis(cam);
      expect(b.up[2]).toBeGreaterThan(0.99);
      expect(b.right[0]).toBeGreaterThan(0.99);
    }
    // top edge to the right of the screen: the scene's +z is now to the right in the picture
    const turned = (await t.run('marker', { marker: '2', turn: '1' }, {}, { project })).image as ImageValue;
    const cam = (await t.run('marker-camera', { ...BASE, analysis: '320' }, { image: turned })).camera as CameraValue;
    expect(cameraBasis(cam).right[2]).toBeGreaterThan(0.99);
  });
});

/** A clip: the camera circles the marker; from frame `gapFrom` to `gapTo` the marker is out of the picture. */
function clipSource(id: string, t: () => Harness, poseAt: (frame: number) => MarkerPose | null): AnyNodeDef {
  const made = new Map<number, ImageValue>();
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test clip of a marker',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      const f = ctx.time.frame;
      let img = made.get(f);
      if (!img) {
        const pose = poseAt(f);
        const g = pose ? renderScene({ width: 320, height: 180, fov: FOV, pose, samples: 2 }) : new Uint8Array(320 * 180).fill(120);
        img = t().gpu.upload(greyToRgba(g), 320, 180, 1, true);
        t().gpu.retain(img.texture);
        made.set(f, img);
      }
      return { image: img };
    },
  });
}

describe('marker-camera: from frame to frame', () => {
  const FPS = 10;
  const project = { fps: FPS, duration: 3, loop: false, width: 320, height: 180 };
  const poseAt = (f: number): MarkerPose | null => (f >= 10 && f < 20 ? null : orbitPose(5, f * 4, 50, 0));
  const setup = async () => {
    // eslint-disable-next-line prefer-const
    let t: Harness;
    const id = `marker-clip-${Math.random().toString(36).slice(2)}`;
    t = await harness([clipSource(id, () => t, poseAt)]);
    // one graph per set of params, kept for the whole test: the node's memory of the frame before belongs to the node in the graph
    const graphs = new Map<string, { g: GraphDoc; node: string }>();
    const at = async (f: number, params: Record<string, unknown>) => {
      const key = JSON.stringify(params);
      let e = graphs.get(key);
      if (!e) {
        let g = createGraph('marker');
        g = { ...g, project: { ...g.project, ...project } };
        const s = addNode(g, t.registry, id);
        const m = addNode(s.graph, t.registry, 'marker-camera', { x: 0, y: 0 }, { ...BASE, analysis: '320', ...params });
        e = { g: connect(m.graph, t.registry, { node: s.node.id, port: 'image' }, { node: m.node.id, port: 'image' }), node: m.node.id };
        graphs.set(key, e);
      }
      const camera = (await t.evalGraph(e.g, e.node, { seconds: f / FPS, port: 'camera' })) as CameraValue;
      const found = (await t.evalGraph(e.g, e.node, { seconds: f / FPS, port: 'found' })) as number;
      return { camera, found };
    };
    return { t, at };
  };
  const azimuth = (cam: CameraValue): number => (Math.atan2(cam.position[0], -cam.position[2]) * 180) / Math.PI;

  it('the camera follows the phone round the marker', async () => {
    const { at } = await setup();
    for (const f of [0, 3, 6, 9]) {
      const out = await at(f, {});
      expect(out.found).toBe(1);
      expect(azimuth(out.camera as CameraValue)).toBeCloseTo(f * 4, 0);
    }
  });
  it('marker lost: Keep it there holds the last pose; Hide drops it after the hold time; Fade out fades Found', async () => {
    const { at } = await setup();
    const play = async (params: Record<string, unknown>, to: number) => {
      const found: number[] = [];
      let cam: CameraValue | null = null;
      for (let f = 6; f <= to; f++) {
        const o = await at(f, params);
        found.push(o.found as number);
        cam = o.camera as CameraValue;
      }
      return { found, cam: cam! };
    };
    const hold = await play({ lost: 'hold' }, 16);
    expect(hold.found).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(azimuth(hold.cam)).toBeCloseTo(36, 0); // still where frame 9 saw it
    const hide = await play({ lost: 'hide', holdTime: 0.3 }, 16);
    // frames 10, 11, 12 are 0.1, 0.2 and 0.3 s after the last sighting: still held; then gone
    expect(hide.found).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(cameraBasis(hide.cam).forward[1]).toBeGreaterThan(0.99); // looking away, straight up
    const fade = await play({ lost: 'fade', holdTime: 0.2 }, 16);
    expect(fade.found.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(fade.found[6]).toBeCloseTo(0.75, 5);
    expect(fade.found[7]).toBeCloseTo(0.5, 5);
    expect(fade.found[10]).toBe(0);
    // found again at frame 20: back at once, at the new place (not sliding over from the old one)
    const back = await play({ lost: 'fade', smoothing: 0.8 }, 20);
    expect(back.found[back.found.length - 1]).toBe(1);
    expect(Math.abs(azimuth(back.cam) - 80)).toBeLessThan(1.5);
  });
  it('smoothing calms a jittering pose and does not change a steady one; jumping in time starts afresh', async () => {
    const { at } = await setup();
    // scrubbing straight to a frame gives that frame's own pose, whatever was shown before
    await at(2, { smoothing: 0.9 });
    const jumped = await at(8, { smoothing: 0.9 });
    expect(azimuth(jumped.camera as CameraValue)).toBeCloseTo(32, 0);
    // playing on from there the smoothed camera trails only a little behind a steady move
    const next = await at(9, { smoothing: 0.9 });
    const a = azimuth(next.camera as CameraValue);
    expect(a).toBeGreaterThan(32);
    expect(a).toBeLessThan(36.5);
  });
});
