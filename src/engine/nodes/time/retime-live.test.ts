import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { DEFAULT_PROJECT, type GraphDoc, type Host } from '../../types';

/**
 * A live camera has no past. Retime's stop-motion asks its input for the same held moment on several frames; the camera node
 * passes that moment on to the host (`liveFrame(..., at)`), which keeps the picture it took for it (src/io/live.ts).
 */
it('stop-motion on a live camera asks the host for the held moment, on every frame of the hold', async () => {
  const asked: number[] = [];
  let tex: GPUTexture | null = null;
  const host: Host = {
    liveFrame: async (_source, _maxSide, at) => {
      asked.push(at ?? -1);
      return tex ? { texture: tex, width: 8, height: 8 } : null;
    },
  } as Host;
  const t = await harness([], host);
  tex = t.solid(8, 8, [200, 100, 50, 255]).texture;
  const graph = (tick: number): GraphDoc => ({
    schema: 'rsmps/graph',
    version: 2,
    name: 'live hold',
    project: { ...DEFAULT_PROJECT, width: 8, height: 8, fps: 24, duration: 2, loop: false },
    nodes: [
      { id: 'cam', type: 'camera-in', x: 0, y: 0, params: { mirror: false, liveTick: String(tick) } },
      { id: 'rt', type: 'retime', x: 200, y: 0, params: { holdFps: 4 } },
    ],
    edges: [{ id: 'e1', from: { node: 'cam', port: 'image' }, to: { node: 'rt', port: 'image' } }],
  });
  const held: number[] = [];
  for (let f = 0; f < 12; f++) {
    asked.length = 0;
    const out = await t.evalGraph(graph(f + 1), 'rt', { seconds: f / 24 });
    expect(out).not.toBeNull();
    // the moment Retime holds: 4 a second = every 6 frames
    const want = Math.floor(f / 6) * 0.25;
    expect(asked.some((a) => Math.abs(a - want) < 1e-9)).toBe(true);
    held.push(want);
  }
  expect([...new Set(held)]).toEqual([0, 0.25]);
});
