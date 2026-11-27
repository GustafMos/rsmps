import { describe, expect, it } from 'vitest';
import { createGraph } from '../graph';
import { harness } from '../testing';
import type { GraphDoc, ImageValue } from '../types';
import worldAr from '../nodes/input/world-ar.node';
import cameraNode from '../nodes/generate/camera.node';

/** Several cameras, each with its own objects and its own light: they must not interfere. And the light sockets of the World AR Camera stay hidden. */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 120_000 };
type N = [id: string, type: string, params?: Record<string, unknown>];
type E = [from: string, fromPort: string, to: string, toPort: string];
const mk = (nodes: N[], edges: E[]): GraphDoc => {
  const g = createGraph('t');
  return {
    ...g,
    project: { ...g.project, width: 160, height: 160, fps: 30, loop: false, duration: 5 },
    nodes: nodes.map(([id, type, params], i) => ({ id, type, x: i * 100, y: 0, params: params ?? {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
};
const obj: Record<string, unknown> = { shape: 'sphere', objectScale: 0.7, ambient: 0.1, specular: 0 };
const render = async (t: Awaited<ReturnType<typeof harness>>, g: GraphDoc, node: string) => t.pixels((await t.evalGraph(g, node, { seconds: 0, port: 'image' })) as ImageValue);
const mean = (px: { data: ArrayLike<number> }) => {
  let s = 0;
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 200) { s += px.data[i] + px.data[i + 1] + px.data[i + 2]; n++; }
  return s / Math.max(1, n);
};
const diff = (a: { data: ArrayLike<number> }, b: { data: ArrayLike<number> }) => {
  let d = 0;
  for (let i = 0; i < a.data.length; i++) d = Math.max(d, Math.abs(a.data[i] - b.data[i]));
  return d;
};

describe('light rides on the camera, per camera', () => {
  it('two cameras with different lights shade their own objects, and each matches the one-camera graph', T, async () => {
    const t = await H();
    const camA: N = ['ca', 'camera', { lightOn: true, lightAzimuth: -60, lightElevation: 50, lightAmbient: 0.1 }];
    const camB: N = ['cb', 'camera', { lightOn: true, lightAzimuth: 120, lightElevation: 20, lightAmbient: 0.9 }];
    const both = mk([camA, camB, ['oa', 'object-3d', obj], ['ob', 'object-3d', obj]], [['ca', 'camera', 'oa', 'camera'], ['cb', 'camera', 'ob', 'camera']]);
    const onlyA = mk([camA, ['oa', 'object-3d', obj]], [['ca', 'camera', 'oa', 'camera']]);
    const onlyB = mk([camB, ['ob', 'object-3d', obj]], [['cb', 'camera', 'ob', 'camera']]);
    const a = await render(t, both, 'oa');
    const b = await render(t, both, 'ob');
    expect(diff(a, await render(t, onlyA, 'oa'))).toBe(0);
    expect(diff(b, await render(t, onlyB, 'ob'))).toBe(0);
    expect(diff(a, b)).toBeGreaterThan(20); // different light
    // a camera without the switch leaves the object's own light alone
    const plain = mk([['cp', 'camera', {}], ['oa', 'object-3d', obj]], [['cp', 'camera', 'oa', 'camera']]);
    const lit = mk([['cp', 'camera', { lightOn: true, lightAzimuth: -35, lightElevation: 40, lightAmbient: 0.1 }], ['oa', 'object-3d', obj]], [['cp', 'camera', 'oa', 'camera']]);
    expect(diff(await render(t, plain, 'oa'), await render(t, lit, 'oa'))).toBe(0); // same numbers as the node's own defaults
    const dark = mk([['cp', 'camera', { lightOn: true, lightAmbient: 0.9 }], ['oa', 'object-3d', obj]], [['cp', 'camera', 'oa', 'camera']]);
    expect(mean(await render(t, dark, 'oa'))).toBeGreaterThan(mean(await render(t, plain, 'oa')));
    // the object's own "Light from camera" off keeps its own light
    const optOut = mk([['cp', 'camera', { lightOn: true, lightAmbient: 0.9 }], ['oa', 'object-3d', { ...obj, lightFromCamera: false }]], [['cp', 'camera', 'oa', 'camera']]);
    expect(diff(await render(t, optOut, 'oa'), await render(t, plain, 'oa'))).toBe(0);
  });
});

describe('World AR Camera face', () => {
  it('the five light sockets and Zoom are hidden until wired or advanced; Camera and Picture stay', () => {
    const outs = worldAr.outputs as Record<string, { visibleIf?: (p: Record<string, unknown>) => boolean }>;
    for (const k of ['lightAzimuth', 'lightElevation', 'lightStrength', 'ambient', 'ambientColor', 'zoom']) {
      expect(outs[k].visibleIf!({})).toBe(false);
      expect(outs[k].visibleIf!({ advOut: true })).toBe(true);
    }
    expect(outs.camera.visibleIf).toBeUndefined();
    expect(outs.picture.visibleIf).toBeUndefined();
    expect(Object.keys(worldAr.params)).not.toContain('useForAll');
  });
  it('the 3D Camera light is off by default (old projects unchanged)', () => {
    expect((cameraNode.params as Record<string, { default: unknown }>).lightOn.default).toBe(false);
  });
});
