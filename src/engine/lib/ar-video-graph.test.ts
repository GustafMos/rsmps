// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Edge, GraphDoc, NodeInstance } from '../types';
import { arVideoFrames, arVideoSize, buildWorldArVideoGraph, type ArVideoOptions } from './ar-video-graph';
import { clipParams } from './take-graph';
import { buildWorldTake, sampleWorldTake, type WorldSample } from './world-take';

const node = (id: string, type: string, params: Record<string, unknown> = {}, extra: Partial<NodeInstance> = {}): NodeInstance => ({ id, type, x: 10, y: 20, params, ...extra });
const wire = (from: string, to: string, toPort = 'image', fromPort = 'image'): Edge => ({ id: `${from}.${fromPort}>${to}.${toPort}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const doc = (nodes: NodeInstance[], edges: Edge[]): GraphDoc => ({
  schema: 'rsmps/graph',
  version: 2,
  name: 'test',
  project: { width: 1920, height: 1080, fps: 25, duration: 4, loop: true, lengthMode: 'relative', referenceSide: 1080 },
  nodes,
  edges,
});

/** A synthetic take: the phone walks along x at 1 m/s, one pose per clip frame, 30 frames per second, the clip's frames 2..31. */
function walk(first = 0): ReturnType<typeof buildWorldTake> {
  const samples: WorldSample[] = [];
  for (let n = 0; n < 30; n++) samples.push({ t: n / 30, frame: first + n, view: { p: [(first + n) / 30, 1.4, 0], q: [0, 0, 0, 1] }, lens: [1, 1, 0, 0], object: { p: [0, 0, -1.5], q: [0, 0, 0, 1], scale: 1 } });
  return buildWorldTake(samples, { fps: 30 });
}

const take = walk()!;
const opts = (over: Partial<ArVideoOptions> = {}): ArVideoOptions => ({ arId: 'ar', viewedId: 'obj', viewedPort: 'image', take, clipAsset: 'clip1', width: 720, height: 1280, output: { codec: 'avc' }, ...over });

/** world-ar -> object (camera), world-ar.picture -> material colour; a Webcam also feeds the object; an unrelated Webcam. */
const project = () =>
  doc(
    [node('ar', 'world-ar', { size: 0.5 }), node('cam', 'camera-in', { facing: 'back' }), node('cam2', 'camera-in'), node('mat', 'material'), node('obj', 'object-3d'), node('fx', 'blur'), node('out', 'image-out')],
    [wire('ar', 'obj', 'camera', 'camera'), wire('ar', 'mat', 'color', 'picture'), wire('mat', 'obj', 'material', 'material'), wire('obj', 'fx'), wire('cam', 'fx', 'mask'), wire('fx', 'out'), wire('cam', 'out', 'audio', 'audio')],
  );

describe('the render graph of a World AR video', () => {
  it('viewing an Image Out merges what is wired into it (an Image Out gives no picture itself)', () => {
    const g = project();
    const r = buildWorldArVideoGraph(g, opts({ viewedId: 'out' }))!;
    const fg = r.graph.edges.find((e) => e.to.port === 'foreground')!;
    expect(fg.from).toEqual({ node: 'fx', port: 'image' });
    const bare = doc([node('ar', 'world-ar'), node('out', 'image-out')], []);
    expect(buildWorldArVideoGraph(bare, opts({ viewedId: 'out' }))).toBeNull();
  });

  it('the camera plays the take, Picture and the Webcam become the camera clip, and the object is merged over the clip into an Output', () => {
    const g = project();
    const r = buildWorldArVideoGraph(g, opts({ viewedId: 'fx' }))!;
    const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
    const ar = byId.get('ar')!;
    expect(ar.params).toMatchObject({ take, startAt: 0, loopTake: false, live: null });
    // the Webcam above the viewed node is the clip, at the clip's own size and clock; the unrelated Webcam is left alone
    expect(byId.get('cam')).toMatchObject({ type: 'media-in', params: clipParams({ id: 'cam', assetId: 'clip1', startsAt: 0 }) });
    expect(byId.get('cam2')!.type).toBe('camera-in');
    // Picture is wired to a Media In with the same clip, not to the world-ar node
    expect(r.graph.edges.find((e) => e.to.node === 'mat')!.from).toEqual({ node: 'ar-clip', port: 'image' });
    expect(byId.get('ar-clip')).toMatchObject({ type: 'media-in', params: { assets: ['clip1'], offset: 0, fullRes: true } });
    // the camera's sound wire to the output is gone (the clip is the sound), the picture wires stay
    expect(r.graph.edges.some((e) => e.from.node === 'cam' && e.from.port === 'audio')).toBe(false);
    expect(r.graph.edges.some((e) => e.from.node === 'cam' && e.to.node === 'fx')).toBe(true);
    // the video: merge(background = clip, foreground = the viewed node) -> the Output
    const into = (id: string, port: string) => r.graph.edges.find((e) => e.to.node === id && e.to.port === port)!.from;
    const out = byId.get(r.outputId)!;
    expect(out).toMatchObject({ type: 'image-out', params: { kind: 'video', enabled: true, codec: 'avc' } });
    const merge = into(r.outputId, 'image').node;
    expect(byId.get(merge)!.type).toBe('merge');
    expect(into(merge, 'background')).toEqual({ node: 'ar-clip', port: 'image' });
    expect(into(merge, 'foreground')).toEqual({ node: 'fx', port: 'image' });
    expect(r.graph.project).toMatchObject({ width: 720, height: 1280, fps: 30, loop: false });
    expect(r.graph.project.duration).toBe(4); // the project length is kept (animations counted per project do not stretch)
  });

  it('the project is not touched', () => {
    const g = project();
    const before = JSON.stringify(g);
    buildWorldArVideoGraph(g, opts({ viewedId: 'fx' }));
    expect(JSON.stringify(g)).toBe(before);
  });

  it('a graph that already has the Picture as its background is composited over the clip once, not twice: the clip is one node, the merge one', () => {
    const g = doc(
      [node('ar', 'world-ar'), node('obj', 'object-3d'), node('bg', 'merge'), node('out', 'image-out')],
      [wire('ar', 'obj', 'camera', 'camera'), wire('ar', 'bg', 'background', 'picture'), wire('obj', 'bg', 'foreground'), wire('bg', 'out')],
    );
    const r = buildWorldArVideoGraph(g, opts({ viewedId: 'bg' }))!;
    expect(r.graph.nodes.filter((n) => n.type === 'media-in')).toHaveLength(1);
    expect(r.graph.nodes.filter((n) => n.type === 'merge')).toHaveLength(2); // the user's own, and the one over the clip: the latter paints with the graph's own alpha
    expect(r.clipNodes).toEqual(['ar-clip']);
  });

  it('without a camera clip the viewed node goes straight to the Output (over black) and Picture is an empty Media In', () => {
    const g = project();
    const r = buildWorldArVideoGraph(g, opts({ viewedId: 'fx', clipAsset: null }))!;
    expect(r.graph.nodes.some((n) => n.type === 'merge')).toBe(false);
    expect(r.graph.edges.find((e) => e.to.node === r.outputId)!.from).toEqual({ node: 'fx', port: 'image' });
    expect(r.graph.nodes.find((n) => n.id === 'cam')!.type).toBe('camera-in');
    expect(r.graph.nodes.find((n) => n.id === 'ar-clip')).toMatchObject({ type: 'media-in', params: { assets: [] } });
  });

  it('a take whose first clip frames had no pose starts the camera at that clip frame', () => {
    const late = walk(3)!;
    expect(late.clipFirst).toBe(3);
    const r = buildWorldArVideoGraph(project(), opts({ viewedId: 'fx', take: late }))!;
    expect(r.graph.nodes.find((n) => n.id === 'ar')!.params.startAt).toBeCloseTo(3 / 30, 6);
    // the pose of clip frame 3 is read at the project time of clip frame 3
    expect(sampleWorldTake(late, 3 / 30 - 3 / 30).view.p[0]).toBeCloseTo(3 / 30, 3);
  });

  it('is null when a node is gone', () => {
    expect(buildWorldArVideoGraph(project(), opts({ viewedId: 'nope' }))).toBeNull();
    expect(buildWorldArVideoGraph(project(), opts({ arId: 'nope', viewedId: 'fx' }))).toBeNull();
  });
});

describe('size and length of the video', () => {
  it('is the clip\'s size, no larger than 1280 on its long side, even', () => {
    expect(arVideoSize({ width: 1080, height: 1920 }, { width: 100, height: 100 }, 1280)).toEqual({ width: 720, height: 1280 });
    expect(arVideoSize({ width: 640, height: 480 }, { width: 100, height: 100 }, 1280)).toEqual({ width: 640, height: 480 });
    expect(arVideoSize(null, { width: 1920, height: 1080 }, 1280)).toEqual({ width: 1280, height: 720 });
  });
  it('is the clip\'s length at the take\'s rate, or the take\'s own without a clip', () => {
    expect(arVideoFrames(take, 1.5)).toBe(45);
    expect(arVideoFrames(take, null)).toBe(take.frames);
    expect(arVideoFrames(take, 0)).toBe(take.frames);
  });
});
