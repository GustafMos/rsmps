import { describe, expect, it } from 'vitest';
import { micNodesOf } from '../engine';
import { registerAudioNodes } from '../nodes';
import { DEFAULT_PROJECT, type GraphDoc } from '../../types';

const graph = (types: string[], edges: [string, string, string, string][]): GraphDoc => ({
  schema: 'rsmps/graph',
  version: 2,
  name: 't',
  project: { ...DEFAULT_PROJECT },
  nodes: types.map((type, i) => ({ id: `n${i}`, type, x: 0, y: 0, params: {} })),
  edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
});

describe('which nodes get a microphone', () => {
  const reg = registerAudioNodes();
  it('a Microphone node always; a Webcam only once one of its sound outputs is wired', () => {
    expect(micNodesOf(graph(['microphone'], []), reg).map((n) => n.id)).toEqual(['n0']);
    // a Webcam added for its picture: nothing is asked for
    expect(micNodesOf(graph(['camera-in', 'audio-out'], []), reg)).toEqual([]);
    expect(micNodesOf(graph(['camera-in', 'recorder'], [['n0', 'image', 'n1', 'image']]), reg)).toEqual([]);
    // the regression: a Webcam with its sound wired and NO Microphone node in the project
    expect(micNodesOf(graph(['camera-in', 'audio-out'], [['n0', 'audio', 'n1', 'audio']]), reg).map((n) => n.id)).toEqual(['n0']);
    expect(micNodesOf(graph(['camera-in', 'recorder'], [['n0', 'tap', 'n1', 'audio']]), reg).map((n) => n.id)).toEqual(['n0']);
  });
});
