/**
 * The owner's real AR project (trimmed: the World AR Camera with its 290-frame take, a sphere with pixelate and glitch, a Stack,
 * a Recorder and the Image Out the AR view showed) rendered as a video with the real engine. The saved video must show the object.
 * Stand-in: the camera clip is a solid blue picture served by the test host (590x1280, the owner's phone).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { arVideoSize, buildWorldArVideoGraph } from '../../engine/lib/ar-video-graph';
import { sampleWorldTake, type WorldTake } from '../../engine/lib/world-take';
import { harness, type Harness } from '../../engine/testing';
import type { AssetInfo, GraphDoc, Host, ImageValue } from '../../engine/types';
import fixture from './fixtures/owner-ar-project.json';
import { stampWorldAr, worldArNodeIds } from './engine-source';

const CLIP_RGB = [20, 40, 230];
const AR = 'n_mwxp52ld1sr';
const OBJ = 'n_mwx80z4r71p';
const OUT = 'n_mwx7zy4y2jf';
const STACK = 'n_mwx81dpcand';
const REC = 'n_mwxbn2g943f';
const PIX = 'n_mwxbwgzma7z';
const GLITCH = 'n_mwxbwot0dc5';
const FPS = 25;

let h: Harness;
let clip: ImageValue;
const base = fixture as unknown as GraphDoc;
const take = base.nodes.find((n) => n.id === AR)!.params.take as WorldTake;

beforeAll(async () => {
  const host: Host = {
    assetInfo: (id) => (id === take.clipAsset ? ({ id, name: 'clip', kind: 'video', width: 590, height: 1280, duration: 11.6, fps: FPS, hasAudio: false } as AssetInfo) : null),
    liveFrame: async () => null,
    liveBlocked: () => true,
    assetFrame: async () => (clip ? { texture: clip.texture, width: clip.width, height: clip.height } : null),
  };
  h = await harness([], host);
  clip = h.solid(590, 1280, [CLIP_RGB[0], CLIP_RGB[1], CLIP_RGB[2], 255]);
});

const edit = (g: GraphDoc, f: (n: GraphDoc['nodes'][number]) => GraphDoc['nodes'][number]): GraphDoc => ({ ...g, nodes: g.nodes.map(f) });
const setParams = (g: GraphDoc, id: string, p: Record<string, unknown>) => edit(g, (n) => (n.id === id ? { ...n, params: { ...n.params, ...p } } : n));

async function dump(img: ImageValue | null, name: string) {
  const dir = process.env.RS_AR_PPM_DIR;
  if (!dir) return;
  const px = await h.pixels(img);
  const out = Buffer.alloc(px.width * px.height * 3);
  for (let i = 0; i < px.width * px.height; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round((px.data[i * 4 + c] * px.data[i * 4 + 3]) / 255 + (c === 2 ? 0 : 0));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.ppm`, Buffer.concat([Buffer.from(`P6 ${px.width} ${px.height} 255\n`), out]));
}

/** Share of pixels that are not the plain camera clip. */
async function cover(img: ImageValue | null): Promise<number> {
  const px = await h.pixels(img);
  let n = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const q = px.at(x, y);
      if (Math.abs(q[0] - CLIP_RGB[0]) + Math.abs(q[1] - CLIP_RGB[1]) + Math.abs(q[2] - CLIP_RGB[2]) > 60) n++;
    }
  return n / (px.width * px.height);
}

async function videoCover(g: GraphDoc, viewed: string, frames: number[], tag?: string, port = 'image'): Promise<number[]> {
  const size = arVideoSize({ width: 590, height: 1280 }, g.project, 1280);
  const built = buildWorldArVideoGraph(g, { arId: AR, viewedId: viewed, viewedPort: port, take, clipAsset: take.clipAsset!, width: size.width, height: size.height, output: {} })!;
  const merge = built.graph.nodes.find((n) => n.label === 'Object over camera')!.id;
  const out: number[] = [];
  for (const f of frames) {
    const res = await h.engine.evaluate({ graph: built.graph, node: merge, seconds: f / FPS });
    expect(res.errors.size, [...res.errors.values()].join(';')).toBe(0);
    if (tag) await dump(res.value as ImageValue, `${tag}-${f}`);
    out.push(await cover(res.value as ImageValue));
  }
  return out;
}

const FRAMES = [0, 60, 100, 150, 200, 289];

describe('the owner project as a saved AR video', () => {
  it('shows the object when the AR view showed an Image Out (it has no picture of its own: the video takes what is wired into it)', async () => {
    const viaOut = await videoCover(base, OUT, FRAMES, 'out');
    const viaStack = await videoCover(base, STACK, FRAMES);
    const viaRecorder = await videoCover(base, REC, FRAMES);
    expect(viaOut).toEqual(viaStack);
    expect(viaRecorder).toEqual(viaStack);
    for (const k of [1, 2, 3, 4]) expect(viaOut[k], `frame ${FRAMES[k]}`).toBeGreaterThan(0.002);
    // the AR view of the same moments (the Image Out evaluates to what arrives on it)
    for (const k of [2, 3, 4]) {
      const m = sampleWorldTake(take, FRAMES[k] / FPS);
      const r = await h.engine.evaluate({ graph: stampWorldAr(base, worldArNodeIds(base), m), node: OUT, canvas: { width: 590, height: 1280 }, proxy: 1, quality: 'preview' });
      expect(r.errors.size, [...r.errors.values()].join(';')).toBe(0);
      const px = await h.pixels(r.value as ImageValue);
      let n = 0;
      for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) if (px.at(x, y)[3] > 40) n++;
      expect(n / (px.width * px.height), `live frame ${FRAMES[k]}`).toBeGreaterThan(0.002);
    }
  }, 600000);

  it('an Image Out with nothing wired in has no picture: no video graph', () => {
    const g = { ...base, edges: base.edges.filter((e) => !(e.to.node === OUT)) };
    expect(buildWorldArVideoGraph(g, { arId: AR, viewedId: OUT, viewedPort: 'image', take, clipAsset: take.clipAsset!, width: 590, height: 1280, output: {} })).toBeNull();
  });
});
