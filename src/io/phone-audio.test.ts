import { describe, expect, it } from 'vitest';
import { PhoneAudioRouter, nodesForToken, phoneAudioWired } from './phone-audio';
import type { GraphDoc } from '../engine/types';

const node = (id: string, type: string, session = '') => ({ id, type, x: 0, y: 0, params: { session } });
const graph = (nodes: ReturnType<typeof node>[], edges: GraphDoc['edges'] = []): GraphDoc => ({ schema: 'rsmps/graph', version: 2, name: 't', project: { width: 1, height: 1, fps: 24, duration: 1, loop: false, lengthMode: 'relative', referenceSide: 1 }, nodes, edges });
const stream = (name: string) => ({ name }) as unknown as MediaStream;

describe('token -> node mapping', () => {
  it('finds every Phone Camera that uses the token, and ignores other nodes and empty tokens', () => {
    const g = graph([node('a', 'phone-camera', 'T1'), node('b', 'phone-camera', 'T1'), node('c', 'phone-camera', 'T2'), node('d', 'blur', 'T1')]);
    expect(nodesForToken(g, 'T1')).toEqual(['a', 'b']);
    expect(nodesForToken(g, 'T2')).toEqual(['c']);
    expect(nodesForToken(g, '')).toEqual([]);
  });
  it('treats a wired Sound or tap output as needing the audio engine', () => {
    const nodes = [node('p', 'phone-camera', 'T'), node('x', 'blur')];
    expect(phoneAudioWired(graph(nodes, [{ id: 'e', from: { node: 'p', port: 'image' }, to: { node: 'x', port: 'image' } }]))).toBe(false);
    expect(phoneAudioWired(graph(nodes, [{ id: 'e', from: { node: 'p', port: 'tap' }, to: { node: 'x', port: 'audio' } }]))).toBe(true);
    expect(phoneAudioWired(graph(nodes, [{ id: 'e', from: { node: 'p', port: 'audio' }, to: { node: 'x', port: 'audio' } }]))).toBe(true);
    expect(phoneAudioWired(graph([node('x', 'blur')]))).toBe(false);
  });
});

describe('PhoneAudioRouter', () => {
  function setup() {
    const calls: [string, string | null][] = [];
    const r = new PhoneAudioRouter((id, s) => calls.push([id, s ? (s as unknown as { name: string }).name : null]));
    return { r, calls };
  }
  it('attaches the stream to all nodes of the token as soon as both exist, in either order', () => {
    const a = setup();
    a.r.setGraph(graph([node('n1', 'phone-camera', 'T'), node('n2', 'phone-camera', 'T')]));
    expect(a.calls).toEqual([]);
    a.r.setStream('T', stream('s1'));
    expect(a.calls).toEqual([['n1', 's1'], ['n2', 's1']]);
    const b = setup();
    b.r.setStream('T', stream('s1'));
    b.r.setGraph(graph([node('n1', 'phone-camera', 'T')]));
    expect(b.calls).toEqual([['n1', 's1']]);
  });
  it('does not re-attach an unchanged stream and follows graph edits', () => {
    const { r, calls } = setup();
    const s = stream('s1');
    r.setStream('T', s);
    r.setGraph(graph([node('n1', 'phone-camera', 'T')]));
    r.setGraph(graph([node('n1', 'phone-camera', 'T')])); // same mapping
    expect(calls).toHaveLength(1);
    r.setGraph(graph([node('n1', 'phone-camera', 'OTHER'), node('n3', 'phone-camera', 'T')])); // n1 unlinked, n3 linked
    expect(calls.slice(1)).toEqual([['n1', null], ['n3', 's1']]);
    r.setGraph(graph([])); // node deleted
    expect(calls.at(-1)).toEqual(['n3', null]);
  });
  it('detaches on disconnect and re-attaches a new stream', () => {
    const { r, calls } = setup();
    r.setGraph(graph([node('n1', 'phone-camera', 'T')]));
    r.setStream('T', stream('s1'));
    r.setStream('T', null);
    r.setStream('T', stream('s2'));
    expect(calls).toEqual([['n1', 's1'], ['n1', null], ['n1', 's2']]);
  });
});
