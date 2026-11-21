import { describe, expect, it } from 'vitest';
import { registerAudioNodes } from '../nodes';
import { AudioGraphRunner } from '../runner';
import { DEFAULT_PROJECT, type GraphDoc } from '../../types';

/**
 * The record bus: what is wired into a Recorder's Sound input, and only that. It must carry the sound even when nothing
 * is wired to an Audio Output (the master is then silent), and stay silent when no Recorder is fed.
 */
const graph = (edges: [string, string, string, string][]): GraphDoc => ({
  schema: 'rsmps/graph',
  version: 2,
  name: 't',
  project: { ...DEFAULT_PROJECT },
  nodes: [
    { id: 'osc', type: 'oscillator', x: 0, y: 0, params: {} },
    { id: 'rec', type: 'recorder', x: 0, y: 0, params: {} },
    { id: 'out', type: 'audio-out', x: 0, y: 0, params: {} },
  ],
  edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
});

function run(doc: GraphDoc): { master: number; rec: number } {
  const runner = new AudioGraphRunner(registerAudioNodes(), { sampleRate: 48000, blockSize: 128, fadeOnRebuild: false });
  runner.setGraph(doc);
  runner.setTransport({ playing: true });
  const l = new Float32Array(128), r = new Float32Array(128), rl = new Float32Array(128), rr = new Float32Array(128);
  let master = 0;
  let rec = 0;
  for (let b = 0; b < 40; b++) {
    runner.process(l, r, 128, null, null, undefined, rl, rr);
    for (let i = 0; i < 128; i++) { master = Math.max(master, Math.abs(l[i])); rec = Math.max(rec, Math.abs(rl[i])); }
  }
  return { master, rec };
}

describe('record bus', () => {
  it('carries the sound wired into a Recorder even when it is not sent to the speakers', () => {
    const v = run(graph([['osc', 'audio', 'rec', 'audio']]));
    expect(v.rec).toBeGreaterThan(0.01);
    expect(v.master).toBe(0);
  });
  it('the Recorder passes the sound on, so it can be heard and recorded', () => {
    const v = run(graph([['osc', 'audio', 'rec', 'audio'], ['rec', 'audio', 'out', 'audio']]));
    expect(v.rec).toBeGreaterThan(0.01);
    expect(v.master).toBeGreaterThan(0.01);
  });
  it('is silent when no Recorder is fed, whatever plays', () => {
    const v = run(graph([['osc', 'audio', 'out', 'audio']]));
    expect(v.rec).toBe(0);
    expect(v.master).toBeGreaterThan(0.01);
  });
});
