/**
 * The AR video against the real engine (lavapipe): what the finished video shows must be what the AR view showed.
 *
 * A take is made by driving the real AR loop with the fake XR session (tap to place away from the world origin, a walking phone, a
 * pinch and a twist while recording). For some recorded frames the object picture the live view asked for is rendered through the
 * real graph (the way EnginePictureSource does), and the same frame is rendered from the video graph (buildWorldArVideoGraph).
 * Stand-in: the camera clip is a solid blue picture served by the test host (decoding a video is not possible in the harness).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../engine/graph';
import { arVideoSize, buildWorldArVideoGraph } from '../../engine/lib/ar-video-graph';
import { qAxisAngle, qMul } from '../../engine/lib/motion-math';
import { buildWorldTake, type WorldMoment, type WorldSample } from '../../engine/lib/world-take';
import { lensFromFov, type XrPose, type Lens } from '../../engine/lib/xr-math';
import { harness, type Harness } from '../../engine/testing';
import type { AssetInfo, GraphDoc, Host, ImageValue } from '../../engine/types';
import { stampWorldAr, worldArNodeIds } from './engine-source';
import { FakeXrSession, fakeTransform } from './fake-xr';
import { ArLoop, pictureSize, type ArPainter, type ArPicture, type ArPictureSource } from './loop';
import { featuresOf } from './xr-api';

const FPS = 30;
const FLOOR_SPOT: XrPose = { p: [0.6, 0, -2.2], q: [0, 0, 0, 1] };
const CLIP_RGB = [20, 40, 230];

class Painter implements ArPainter {
  begin() {}
  picture() {}
  ring() {}
  camera() {
    return { canvas: true };
  }
}
class Source implements ArPictureSource {
  private seq = 0;
  private last: ArPicture | null = null;
  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number } }): boolean {
    this.last = { moment: req.moment, depth: req.depth, width: req.size.width, height: req.size.height, seq: ++this.seq };
    return true;
  }
  latest() {
    return this.last;
  }
  error() {
    return null;
  }
}

/** Drive the real loop: place away from the origin, walk, pinch and twist while recording. */
function record(lens: Lens, camera: { width: number; height: number }) {
  const session = new FakeXrSession({ lens, width: camera.width, height: camera.height });
  session.camera = camera;
  session.viewer = { p: [0, 1.4, 0], q: qAxisAngle('x', -25) };
  const source = new Source();
  let clock = 0;
  const loop = new ArLoop({
    session,
    referenceSpace: { space: 'local' },
    hitTestSource: { source: 'viewer' },
    layer: session.layer,
    features: featuresOf(session),
    painter: new Painter(),
    source,
    show: { kind: 'layer' },
    maxSide: 960,
    seconds: () => clock / 1000,
    now: () => clock,
    makeTransform: fakeTransform,
    screen: () => ({ width: 360, height: 640 }),
    onState: () => undefined,
  });
  loop.start();
  const step = () => {
    clock += 33;
    session.step(33);
  };
  session.hit = FLOOR_SPOT;
  step();
  step();
  // recording starts BEFORE the object is placed: the first frames have no object
  let n = 0;
  loop.startRecording({ push: () => n++ });
  for (let i = 0; i < 3; i++) step();
  loop.gesture({ type: 'tap', x: 180, y: 320 });
  for (let i = 0; i < 40; i++) {
    const eye: [number, number, number] = [0.2 + i * 0.03, 1.4, 0.3 - i * 0.02];
    // walking, and looking roughly at the spot (a few degrees off, drifting): the object stays in view
    const yaw = (Math.atan2(-(FLOOR_SPOT.p[0] - eye[0]), -(FLOOR_SPOT.p[2] - eye[2])) * 180) / Math.PI + Math.sin(i / 5) * 4;
    session.viewer = { p: eye, q: qMul(qAxisAngle('y', yaw), qAxisAngle('x', -30)) };
    if (i === 14) {
      loop.gesture({ type: 'pinch', factor: 1.4 });
      loop.gesture({ type: 'twist', deg: 35 });
    }
    step();
  }
  const rec = loop.stopRecording()!;
  loop.stop();
  return rec.samples as WorldSample[];
}

let h: Harness;
let clipColour: ImageValue;
beforeAll(async () => {
  const host: Host = {
    assetInfo: (id) => (id === 'clip' ? ({ id, name: 'clip', kind: 'video', width: 540, height: 960, duration: 3, fps: FPS, hasAudio: false } as AssetInfo) : null),
    liveFrame: async () => null,
    liveBlocked: () => true, // the AR view owns the camera: a Webcam node is transparent live
    assetFrame: async () => (clipColour ? { texture: clipColour.texture, width: clipColour.width, height: clipColour.height } : null),
  };
  h = await harness([], host);
  clipColour = h.solid(540, 960, [CLIP_RGB[0], CLIP_RGB[1], CLIP_RGB[2], 255]);
});

/** Review aid: a PPM of the picture over black (set RS_AR_PPM_DIR to write them). */
async function dump(img: ImageValue | null, name: string) {
  const dir = process.env.RS_AR_PPM_DIR;
  if (!dir) return;
  const px = await h.pixels(img);
  const out = Buffer.alloc(px.width * px.height * 3);
  for (let i = 0; i < px.width * px.height; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round((px.data[i * 4 + c] * px.data[i * 4 + 3]) / 255);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.ppm`, Buffer.concat([Buffer.from(`P6 ${px.width} ${px.height} 255\n`), out]));
}

async function centroid(img: ImageValue | null, isObject: (p: [number, number, number, number]) => boolean) {
  const px = await h.pixels(img);
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (isObject(px.at(x, y))) {
        n++;
        sx += x;
        sy += y;
      }
  return { cover: n / (px.width * px.height), x: n ? sx / n / px.width : NaN, y: n ? sy / n / px.height : NaN };
}

function project(): { graph: GraphDoc; ar: string; obj: string; merge: string; cam: string } {
  let g = createGraph('ar');
  const ar = addNode(g, h.registry, 'world-ar', { x: 0, y: 0 }, { size: 0.5 });
  const obj = addNode(ar.graph, h.registry, 'object-3d', { x: 200, y: 0 });
  const cam = addNode(obj.graph, h.registry, 'camera-in', { x: 0, y: 200 });
  const merge = addNode(cam.graph, h.registry, 'merge', { x: 400, y: 0 });
  g = connect(merge.graph, h.registry, { node: ar.node.id, port: 'camera' }, { node: obj.node.id, port: 'camera' });
  g = connect(g, h.registry, { node: cam.node.id, port: 'image' }, { node: merge.node.id, port: 'background' });
  g = connect(g, h.registry, { node: obj.node.id, port: 'image' }, { node: merge.node.id, port: 'foreground' });
  return { graph: g, ar: ar.node.id, obj: obj.node.id, merge: merge.node.id, cam: cam.node.id };
}

const SHAPES = [
  { name: 'portrait', camera: { width: 1080, height: 1920 }, lens: lensFromFov(60, 1080 / 1920), clip: { width: 540, height: 960 } },
  { name: 'landscape', camera: { width: 1920, height: 1080 }, lens: lensFromFov(60, 1920 / 1080), clip: { width: 960, height: 540 } },
];

describe('the finished AR video shows the object where the AR view showed it', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: object visible, same place on screen as live`, async () => {
      const samples = record(shape.lens, shape.camera);
      expect(samples.some((s) => !s.object)).toBe(true); // the first frames are before the tap
      expect(samples.some((s) => s.object)).toBe(true);
      const take = buildWorldTake(samples, { fps: FPS })!;
      expect(take.clip).toBe(true);
      const p = project();
      const size = arVideoSize(shape.clip, { width: 100, height: 100 }, 1280);
      clipColour = h.solid(size.width, size.height, [CLIP_RGB[0], CLIP_RGB[1], CLIP_RGB[2], 255]);
      const built = buildWorldArVideoGraph(p.graph, { arId: p.ar, viewedId: p.merge, viewedPort: 'image', take, clipAsset: 'clip', width: size.width, height: size.height, output: {} })!;
      const mergeId = built.graph.nodes.find((n) => n.label === 'Object over camera')!.id;
      const live = pictureSize(shape.lens, 960);
      const isObj = (q: [number, number, number, number]) => q[3] > 40;
      const isNotClip = (q: [number, number, number, number]) => Math.abs(q[0] - CLIP_RGB[0]) + Math.abs(q[1] - CLIP_RGB[1]) + Math.abs(q[2] - CLIP_RGB[2]) > 60;
      let compared = 0;
      for (const i of [0, 2, 6, 12, 20, 30, 40]) {
        const s = samples[Math.min(i, samples.length - 1)];
        const moment: WorldMoment = { view: s.view, lens: s.lens, object: s.object };
        // live: the way EnginePictureSource renders for a moment
        const stamped = stampWorldAr(p.graph, worldArNodeIds(p.graph), moment);
        const liveRes = await h.engine.evaluate({ graph: stamped, node: p.merge, canvas: live, proxy: 1, quality: 'preview' });
        expect(liveRes.errors.size, [...liveRes.errors.values()].join(';')).toBe(0);
        if (i === 20) await dump(liveRes.value as ImageValue, `live-${shape.name}`);
        const liveC = await centroid(liveRes.value as ImageValue, isObj);
        // video: frame s.frame of the clip
        const res = await h.engine.evaluate({ graph: built.graph, node: mergeId, seconds: (s.frame ?? 0) / FPS });
        expect(res.errors.size, [...res.errors.values()].join(';')).toBe(0);
        if (i === 20) await dump(res.value as ImageValue, `video-${shape.name}`);
        const vidC = await centroid(res.value as ImageValue, isNotClip);
        if (!s.object) {
          expect(liveC.cover, `frame ${i} live (not placed)`).toBe(0);
          expect(vidC.cover, `frame ${i} video (not placed)`).toBe(0);
          continue;
        }
        expect(liveC.cover, `frame ${i}: live coverage`).toBeGreaterThan(0.005);
        expect(vidC.cover, `frame ${i}: video coverage`).toBeGreaterThan(0.005);
        expect(Math.abs(vidC.x - liveC.x), `frame ${i}: x centroid live ${liveC.x} video ${vidC.x}`).toBeLessThan(0.03);
        expect(Math.abs(vidC.y - liveC.y), `frame ${i}: y centroid live ${liveC.y} video ${vidC.y}`).toBeLessThan(0.03);
        expect(Math.abs(vidC.cover / liveC.cover - 1), `frame ${i}: size live ${liveC.cover} video ${vidC.cover}`).toBeLessThan(0.1);
        compared++;
      }
      expect(compared).toBeGreaterThan(3);
    }, 120000);
  }
});
