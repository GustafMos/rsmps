import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0) as unknown as number);
vi.stubGlobal('cancelAnimationFrame', (n: number) => clearTimeout(n));

const { Editor } = await import('./editor');
const { MidiController, dotCss } = await import('./midi');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { addNode, connect, createGraph } = await import('../../engine/graph');
const { parseGraph } = await import('../../io/projects');
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

interface FakeInput {
  id: string;
  name: string;
  onmidimessage: ((e: { data: number[] }) => void) | null;
}

function setup(withDevice = true) {
  const input: FakeInput = { id: 'dev1', name: 'Test Pad', onmidimessage: null };
  const access = { inputs: new Map([['dev1', input]]), onstatechange: null as null | (() => void) };
  vi.stubGlobal('navigator', { requestMIDIAccess: withDevice ? async () => access : async () => Promise.reject(new Error('denied')) });
  type Sub = (s: { seconds: number; playing: boolean }) => void;
  const player = {
    seconds: 0,
    playing: false,
    subs: [] as Sub[],
    getState() {
      return { seconds: this.seconds, playing: this.playing };
    },
    subscribe(fn: Sub) {
      this.subs.push(fn);
      return () => undefined;
    },
    seek(s: number) {
      this.seconds = s;
    },
    play() {
      this.playing = true;
    },
    pause() {
      this.playing = false;
    },
  };
  const io = { registry, library: { list: () => [] }, player } as unknown as Io;
  const ed = new Editor(io);
  let g = createGraph('t');
  const media = addNode(g, registry, 'media-in', { x: 0, y: 0 });
  g = media.graph;
  const ca = addNode(g, registry, 'color-adjust', { x: 300, y: 0 });
  g = ca.graph;
  const gl = addNode(g, registry, 'glitch', { x: 600, y: 0 });
  g = gl.graph;
  g = connect(g, registry, { node: media.node.id, port: 'image' }, { node: ca.node.id, port: 'image' });
  ed.loadGraph(g);
  const midi = new MidiController(ed, io);
  const send = (...data: number[]) => input.onmidimessage?.({ data });
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const param = (id: string, key: string) => ed.state.graph.nodes.find((n) => n.id === id)!.params[key];
  return { ed, io, midi, player, send, flush, param, ca: ca.node.id, glitch: gl.node.id };
}

describe('MIDI learn controller', () => {
  it('learns the next control, stores it in the project, and undo removes it', async () => {
    const t = setup();
    await t.midi.learn(t.ca, 'brightness');
    expect(t.midi.store.get().learning?.param).toBe('brightness');
    t.send(0xb0, 21, 64);
    const map = t.ed.state.graph.midiMap!;
    expect(map.mappings.length).toBe(1);
    expect(map.mappings[0]).toMatchObject({ node: t.ca, param: 'brightness', source: { kind: 'cc', number: 21, channel: 0, device: 'dev1' }, min: -1, max: 1 });
    expect(t.midi.store.get().learning).toBeNull();
    expect(t.midi.mappingsFor(t.ca, 'brightness').length).toBe(1);
    t.ed.undo();
    expect(t.ed.state.graph.midiMap).toBeUndefined();
  });

  it('writes the mapped value into the parameter; a whole sweep is one undo step; pickup waits for the knob', async () => {
    const t = setup();
    await t.midi.learn(t.ca, 'brightness');
    t.send(0xb0, 21, 0); // learns
    expect(t.param(t.ca, 'brightness') ?? 0).toBe(0);
    // the knob is at the bottom, the parameter in the middle of -1..1: nothing happens until the knob reaches it
    t.send(0xb0, 21, 10);
    await t.flush();
    expect(t.param(t.ca, 'brightness') ?? 0).toBe(0);
    for (const v of [50, 64, 80, 100, 127]) {
      t.send(0xb0, 21, v);
      await t.flush();
    }
    expect(t.param(t.ca, 'brightness')).toBe(1);
    t.ed.undo(); // the whole sweep
    expect(t.param(t.ca, 'brightness') ?? 0).toBe(0);
    expect(t.ed.state.graph.midiMap?.mappings.length).toBe(1); // the mapping itself survives
  });

  it('a switch follows a pad, an enum steps; unlearn removes every mapping of the setting', async () => {
    const t = setup();
    await t.midi.learn(t.glitch, 'freeze');
    t.send(0x90, 36, 100);
    t.send(0x80, 36, 0);
    await t.flush();
    const first = t.ed.state.graph.midiMap!.mappings[0];
    expect(first.mode).toBe('momentary'); // a pad on a switch is momentary by default
    t.midi.updateMapping(first.id, { mode: 'toggle' });
    t.send(0x90, 36, 100);
    await t.flush();
    expect(t.param(t.glitch, 'freeze')).toBe(true);
    t.send(0x80, 36, 0);
    t.send(0x90, 36, 100);
    await t.flush();
    expect(t.param(t.glitch, 'freeze')).toBe(false);
    await t.midi.learn(t.glitch, 'preset');
    t.send(0x90, 40, 100); // learns the pad
    t.send(0x80, 40, 0);
    t.send(0x90, 40, 100);
    t.send(0x80, 40, 0);
    t.send(0x90, 40, 100);
    await t.flush();
    expect(t.param(t.glitch, 'preset')).toBe('broken'); // two presses within one frame: custom -> light -> broken
    t.midi.unlearn(t.glitch, 'freeze');
    expect(t.midi.mappingsFor(t.glitch, 'freeze').length).toBe(0);
    expect(t.midi.mappingsFor(t.glitch, 'preset').length).toBe(1);
  });

  it('ignores note-offs and a resting wheel while learning, and ignores a setting that a wire drives', async () => {
    const t = setup();
    await t.midi.learn(t.ca, 'brightness');
    t.send(0x80, 60, 0);
    expect(t.midi.store.get().learning).not.toBeNull();
    t.send(0xe0, 0, 0x40);
    expect(t.midi.store.get().learning).not.toBeNull();
    t.send(0xb0, 1, 64);
    expect(t.midi.store.get().learning).toBeNull();
    const k = addNode(t.ed.state.graph, registry, 'keyframes', { x: 0, y: 300 });
    t.ed.edit(() => connect(k.graph, registry, { node: k.node.id, port: 'value' }, { node: t.ca, port: 'brightness' }));
    t.send(0xb0, 1, 127);
    await t.flush();
    expect(t.param(t.ca, 'brightness') ?? 0).toBe(0);
  });

  it('reports a denied MIDI permission without throwing', async () => {
    const t = setup(false);
    await t.midi.learn(t.ca, 'brightness');
    expect(t.midi.store.get().status).toBe('denied');
    expect(t.midi.store.get().learning).toBeNull();
    expect(t.midi.statusText()).toMatch(/blocked/);
  });

  it('records one pass of a knob into a Keyframes node wired to the setting', async () => {
    const t = setup();
    t.midi.init();
    await t.midi.learn(t.ca, 'brightness');
    t.send(0xb0, 21, 64);
    const id = t.ed.state.graph.midiMap!.mappings[0].id;
    t.midi.updateMapping(id, { pickup: 'jump' });
    t.midi.startRecording(id);
    expect(t.midi.store.get().recording).not.toBeNull();
    const dur = t.ed.state.graph.project.duration;
    const tick = (sec: number) => {
      t.player.seconds = sec;
      t.player.playing = true;
      for (const s of t.player.subs) s({ seconds: sec, playing: true });
    };
    tick(0);
    for (let i = 0; i <= 10; i++) {
      tick((dur * i) / 11);
      t.send(0xb0, 21, Math.round((127 * i) / 10));
      await t.flush();
    }
    tick(0.01); // the loop wrapped: recording ends
    expect(t.midi.store.get().recording).toBeNull();
    const g = t.ed.state.graph;
    const kf = g.nodes.find((n) => n.type === 'keyframes')!;
    expect(kf).toBeTruthy();
    expect(g.edges.some((e) => e.from.node === kf.id && e.to.node === t.ca && e.to.port === 'brightness')).toBe(true);
    const curve = kf.params.curve as { keys: { t: number; v: number }[] };
    expect(curve.keys.length).toBeGreaterThan(2);
    expect(curve.keys.length).toBeLessThan(40);
    expect(Math.max(...curve.keys.map((k) => k.v))).toBeCloseTo(1, 1);
  });
});

describe('project storage and dots', () => {
  it('midiMap is carried through parseGraph, dropped when empty or damaged', () => {
    const g = createGraph('x');
    const m = { id: 'a', node: 'n', param: 'p', source: { kind: 'cc', number: 1, channel: -1, device: '' }, min: 0, max: 1, curve: 'linear', invert: false, mode: 'toggle', pickup: 'pickup' };
    expect(parseGraph(JSON.parse(JSON.stringify({ ...g, midiMap: { mappings: [m] } }))).midiMap?.mappings.length).toBe(1);
    expect(parseGraph(JSON.parse(JSON.stringify({ ...g, midiMap: { mappings: [] } }))).midiMap).toBeUndefined();
    expect(parseGraph(JSON.parse(JSON.stringify({ ...g, midiMap: 'junk' }))).midiMap).toBeUndefined();
    expect(parseGraph(JSON.parse(JSON.stringify(g))).midiMap).toBeUndefined();
  });

  it('the dot stylesheet targets inspector rows and node rows, once per setting, and escapes quotes', () => {
    expect(dotCss(undefined)).toBe('');
    const m = (id: string, node: string) => ({ id, node, param: 'p"x', source: { kind: 'cc' as const, number: 1, channel: -1, device: '' }, min: 0, max: 1, curve: 'linear' as const, invert: false, mode: 'toggle' as const, pickup: 'pickup' as const });
    const css = dotCss({ mappings: [m('1', 'n1'), m('2', 'n1')] });
    expect(css).toContain('[data-param-node="n1"][data-param-key="p\\"x"]');
    expect(css).toContain('[data-node-id="n1"] [data-param-key="p\\"x"]');
    expect(css.match(/\[data-param-node="n1"\]/g)!.length).toBe(2); // once for position:relative, once for ::after
  });
});
