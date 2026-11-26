// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { flattenGraph } from '../group';
import type { Edge, GraphDoc, NodeInstance } from '../types';
import { clipSourceTime } from './media-time';
import { buildTakeGraph, clipParams, findLiveInputs, findMotionInputs, soundPlan, takeFrameTime } from './take-graph';

const node = (id: string, type: string, params: Record<string, unknown> = {}, extra: Partial<NodeInstance> = {}): NodeInstance => ({ id, type, x: 0, y: 0, params, ...extra });
const wire = (from: string, to: string, toPort = 'image', fromPort = 'image'): Edge => ({ id: `${from}>${to}.${toPort}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const doc = (nodes: NodeInstance[], edges: Edge[], project: Partial<GraphDoc['project']> = {}): GraphDoc => ({
  schema: 'rsmps/graph',
  version: 2,
  name: 'test',
  project: { width: 1280, height: 720, fps: 25, duration: 4, loop: true, lengthMode: 'relative', referenceSide: 1080, ...project },
  nodes,
  edges,
});

/** camera -> blur -> recorder -> out, plus a camera that only feeds the Recorder's Sound and a camera that feeds nothing. */
const plain = () =>
  doc(
    [node('cam', 'camera-in', { mirror: true }), node('blur', 'blur'), node('rec', 'recorder'), node('out', 'image-out'), node('mic-cam', 'camera-in'), node('other', 'camera-in'), node('url', 'url-in', { url: 'http://x/y.mjpg' }), node('mix', 'blend')],
    [wire('cam', 'blur'), wire('blur', 'mix', 'a'), wire('url', 'mix', 'b'), wire('mix', 'rec'), wire('rec', 'out'), wire('mic-cam', 'rec', 'audio', 'audio'), wire('cam', 'out', 'audio', 'audio')],
  );

/** The camera sits inside a group; the Recorder is at the top level. */
const grouped = () =>
  doc(
    [
      node('g', 'group', {
        kind: 'group',
        nodes: [node('cam', 'camera-in'), node('inv', 'invert')],
        edges: [wire('cam', 'inv'), { id: 'o', from: { node: 'inv', port: 'image' }, to: { node: '@out', port: 'out' } }],
        inputs: [],
        outputs: [{ id: 'out', type: 'image', label: 'Out' }],
        exposed: [],
      }),
      node('rec', 'recorder'),
    ],
    [wire('g', 'rec', 'image', 'out')],
  );

describe('finding what is live upstream of a Recorder', () => {
  it('finds the live pictures that feed its picture input, and only those', () => {
    const found = findLiveInputs(plain(), 'rec');
    expect(found.map((n) => `${n.id}:${n.type}`)).toEqual(['cam:camera-in', 'url:url-in']);
    expect(found[0].params).toEqual({ mirror: true });
  });
  it('skips a bypassed live node, and knows nothing about a Recorder that is not there', () => {
    const g = plain();
    g.nodes[0] = { ...g.nodes[0], bypass: true };
    expect(findLiveInputs(g, 'rec').map((n) => n.id)).toEqual(['url']);
    expect(findLiveInputs(g, 'nope')).toEqual([]);
  });
  it('looks inside groups and names the node by its path', () => {
    expect(findLiveInputs(grouped(), 'rec').map((n) => n.id)).toEqual(['g/cam']);
  });
  it('finds motion nodes that follow live sensors, not ones that play a recorded take', () => {
    const g = doc(
      [node('m1', 'phone-motion', { device: 'this' }), node('m2', 'ar-camera', { source: 'recorded', take: { v: 1 } }), node('fx', 'transform'), node('cam', 'camera-in'), node('rec', 'recorder')],
      [wire('cam', 'fx'), wire('m1', 'fx', 'angle', 'yaw'), wire('m2', 'fx', 'x', 'x'), wire('fx', 'rec')],
    );
    expect(findMotionInputs(g, 'rec').map((n) => n.id)).toEqual(['m1']);
  });
  it('plans which sound is recorded: none, the one wired into the Recorder, or the mix that is playing', () => {
    expect(soundPlan(false, true)).toBe('none');
    expect(soundPlan(true, true)).toBe('wired');
    expect(soundPlan(true, false)).toBe('mix');
  });
});

describe('the clock of a take', () => {
  it('runs on when time ran on', () => {
    expect(takeFrameTime(0, 25, null)).toEqual({ seconds: 0, pass: 0 });
    expect(takeFrameTime(250, 25, null)).toEqual({ seconds: 10, pass: 0 });
  });
  it('wraps at the project length when the project looped, counting the passes', () => {
    expect(takeFrameTime(99, 25, 100)).toEqual({ seconds: 99 / 25, pass: 0 });
    expect(takeFrameTime(100, 25, 100)).toEqual({ seconds: 0, pass: 1 });
    expect(takeFrameTime(250, 25, 100)).toEqual({ seconds: 2, pass: 2 });
  });
});

describe('the copy that is rendered', () => {
  const OUT = { frame: 'project', codec: 'avc' };
  it('replaces each recorded live node by a Media In playing its clip once, in step with the take', () => {
    const g = plain();
    const before = JSON.stringify(g);
    const built = buildTakeGraph(g, 'rec', [{ id: 'cam', assetId: 'A', startsAt: -0.04 }, { id: 'url', assetId: 'B', startsAt: 0.5 }], { time: 'run', output: OUT })!;
    expect(JSON.stringify(g)).toBe(before); // the user's document is untouched
    const cam = built.graph.nodes.find((n) => n.id === 'cam')!;
    expect(cam.type).toBe('media-in');
    expect(cam.params).toEqual({ assets: ['A'], trim: [0, 1], fps: 0, fullRes: true, loopVideo: false, offset: 0.04, volume: 0, mute: true });
    expect(built.graph.nodes.find((n) => n.id === 'url')!.params.offset).toBe(-0.5);
    // the picture wire stays, the camera's sound wire goes (the recorded sound is the sound)
    expect(built.graph.edges.some((e) => e.from.node === 'cam' && e.to.node === 'blur')).toBe(true);
    expect(built.graph.edges.some((e) => e.from.node === 'cam' && e.from.port === 'audio')).toBe(false);
    // cameras that were not recorded stay as they are
    expect(built.graph.nodes.find((n) => n.id === 'other')!.type).toBe('camera-in');
  });
  it('keeps the project length and turns Loop off when time ran on; keeps both when the project looped', () => {
    const run = buildTakeGraph(plain(), 'rec', [], { time: 'run', output: OUT })!;
    expect(run.graph.project).toMatchObject({ duration: 4, fps: 25, loop: false });
    const loop = buildTakeGraph(plain(), 'rec', [], { time: 'loop', output: OUT })!;
    expect(loop.graph.project).toMatchObject({ duration: 4, loop: true });
  });
  it('adds an Output that renders the picture flowing through the Recorder', () => {
    const built = buildTakeGraph(plain(), 'rec', [], { time: 'run', output: OUT })!;
    const out = built.graph.nodes.find((n) => n.id === built.outputId)!;
    expect(out).toMatchObject({ type: 'image-out', params: { frame: 'project', codec: 'avc', kind: 'video', enabled: true } });
    expect(built.graph.edges.at(-1)).toMatchObject({ from: { node: 'rec', port: 'image' }, to: { node: built.outputId, port: 'image' } });
    const taken = plain();
    taken.nodes.push(node('take-out', 'blur'));
    expect(buildTakeGraph(taken, 'rec', [], { time: 'run', output: OUT })!.outputId).toBe('take-out-2');
    expect(buildTakeGraph(plain(), 'gone', [], { time: 'run', output: OUT })).toBeNull();
  });
  it('a clip shows its own frame for every moment of the take, and holds its ends', () => {
    const info = { duration: 10, fps: 30 };
    const p = clipParams({ id: 'cam', assetId: 'A', startsAt: 0.5 }) as never;
    expect(clipSourceTime(info, p, 0)).toBe(0); // before the clip began: its first frame
    expect(clipSourceTime(info, p, 3.5)).toBeCloseTo(3, 6);
    expect(clipSourceTime(info, p, 99)).toBeCloseTo(10, 3); // after its end: its last frame, never a wrap
    // third pass of a 4 second loop: the project clock says 1 s, the take is 9 s in
    const later = clipParams({ id: 'cam', assetId: 'A', startsAt: 0.5 }, 8) as never;
    expect(clipSourceTime(info, later, 1)).toBeCloseTo(8.5, 6);
  });
  it('replaces a live node inside a group in place', () => {
    const built = buildTakeGraph(grouped(), 'rec', [{ id: 'g/cam', assetId: 'A', startsAt: 0 }], { time: 'run', output: OUT })!;
    const flat = flattenGraph(built.graph).graph;
    expect(flat.nodes.find((n) => n.id === 'g/cam')).toMatchObject({ type: 'media-in', params: { assets: ['A'] } });
    expect(flat.edges.some((e) => e.from.node === 'g/cam' && e.to.node === 'g/inv')).toBe(true);
    expect(findLiveInputs(built.graph, 'rec')).toEqual([]);
  });
  it('a Recorder inside a group is rendered from the plain form of the graph', () => {
    const g = doc(
      [
        node('cam', 'camera-in'),
        node('g', 'group', {
          kind: 'group',
          nodes: [node('rec', 'recorder')],
          edges: [{ id: 'i', from: { node: '@in', port: 'in' }, to: { node: 'rec', port: 'image' } }],
          inputs: [{ id: 'in', type: 'image', label: 'In' }],
          outputs: [],
          exposed: [],
        }),
      ],
      [wire('cam', 'g', 'in')],
    );
    expect(findLiveInputs(g, 'g/rec').map((n) => n.id)).toEqual(['cam']);
    const built = buildTakeGraph(g, 'g/rec', [{ id: 'cam', assetId: 'A', startsAt: 0 }], { time: 'run', output: OUT })!;
    expect(built.graph.nodes.some((n) => n.type === 'group')).toBe(false);
    expect(built.graph.edges.at(-1)).toMatchObject({ from: { node: 'g/rec', port: 'image' }, to: { node: built.outputId } });
    expect(built.graph.edges.some((e) => e.from.node === 'cam' && e.to.node === 'g/rec')).toBe(true);
  });
  it('gives motion nodes the take that was recorded with the picture', () => {
    const g = doc([node('m', 'phone-motion', { device: 'this', gainX: 2 }), node('cam', 'camera-in'), node('rec', 'recorder')], [wire('cam', 'rec')]);
    const built = buildTakeGraph(g, 'rec', [], { time: 'run', output: OUT, motion: new Map([['m', { v: 1, fps: 25 }]]) })!;
    expect(built.graph.nodes.find((n) => n.id === 'm')!.params).toMatchObject({ device: 'this', gainX: 2, source: 'recorded', take: { v: 1, fps: 25 }, loopTake: false });
  });
});
