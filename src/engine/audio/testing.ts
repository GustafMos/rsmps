/**
 * Headless helpers for testing audio kernels and graphs (no Web Audio, no GPU).
 */
import type { Registry } from '../define';
import type { AnyNodeDef, GraphDoc, InputSchema, OutputSchema } from '../types';
import { registerAudioNodes } from './nodes';
import { nsdf, pickPeriod } from './pitch';
import { resolveParams } from './params';
import { AudioGraphRunner } from './runner';
import type { AudioAsset, AudioIO, MidiEvent, StereoBlock } from './types';
import { BLOCK_SIZE } from './types';

export const SR = 48000;

export function sine(freq: number, n: number, sr = SR, amp = 1, phase = 0): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * Math.sin(2 * Math.PI * freq * (i / sr) + phase);
  return o;
}
export function saw(freq: number, n: number, sr = SR, amp = 1): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * (2 * (((freq * i) / sr) % 1) - 1);
  return o;
}
/** Harmonic "voice-like" tone: strong 2nd/3rd harmonics, weak fundamental (stress for octave errors). */
export function voice(freq: number, n: number, sr = SR, amp = 0.4): Float32Array {
  const o = new Float32Array(n);
  const gains = [0.5, 1, 0.8, 0.5, 0.3, 0.2];
  for (let h = 0; h < gains.length; h++) {
    if (freq * (h + 1) > sr * 0.45) break;
    for (let i = 0; i < n; i++) o[i] += gains[h] * Math.sin(2 * Math.PI * freq * (h + 1) * (i / sr));
  }
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(o[i]));
  for (let i = 0; i < n; i++) o[i] = (o[i] / m) * amp;
  return o;
}
export function noise(n: number, seed = 1, amp = 1): Float32Array {
  const o = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0; // mulberry32
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    o[i] = amp * ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  }
  return o;
}
export function impulse(n: number, at = 0, amp = 1): Float32Array {
  const o = new Float32Array(n);
  o[at] = amp;
  return o;
}
export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
export function peak(x: Float32Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}
export const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
/** Amplitude of the sinusoidal component at `freq` (Hann-windowed single-bin DFT). */
export function toneAmp(x: Float32Array, freq: number, sr = SR, from = 0, to = x.length): number {
  const n = to - from;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const a = (2 * Math.PI * freq * i) / sr;
    re += x[from + i] * w * Math.cos(a);
    im -= x[from + i] * w * Math.sin(a);
    wsum += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / wsum;
}
export function allFinite(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}
/** Frequency from rising zero crossings (clean tones only). */
export function zeroCrossFreq(x: Float32Array, sr = SR, from = 0, to = x.length): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * sr) / (last - first) : 0;
}

export interface KernelRun {
  params?: Record<string, unknown>;
  /** Audio input signals by input name: [L, R] (R defaults to L). */
  inputs?: Record<string, Float32Array | [Float32Array, Float32Array]>;
  /** MIDI input events by input name; `offset` is the ABSOLUTE sample position in the run. */
  midi?: Record<string, MidiEvent[]>;
  /** Events as if sent from the on-screen keyboard (absolute offsets). */
  uiMidi?: MidiEvent[];
  deviceMidi?: MidiEvent[];
  mic?: Float32Array | [Float32Array, Float32Array];
  assets?: Record<string, AudioAsset>;
  frames: number;
  sampleRate?: number;
  time?: Partial<AudioIO['time']>;
}
export interface KernelResult {
  out: Record<string, [Float32Array, Float32Array]>;
  midiOut: Record<string, MidiEvent[]>;
  /** Last published value of each signal after the run. */
  signals: Record<string, number>;
  /** Value of each signal after every block (index = block number), for shape assertions. */
  signalHistory: Record<string, number[]>;
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const pair = (x: Float32Array | [Float32Array, Float32Array]): [Float32Array, Float32Array] => (Array.isArray(x) ? x : [x, x]);

/** Run a single node's kernel over `frames` samples in 128-sample blocks. */
export function runKernel(def: AnyNodeDef, run: KernelRun): KernelResult {
  const sr = run.sampleRate ?? SR;
  const kernel = def.audio!;
  const state = kernel.create({ sampleRate: sr, blockSize: BLOCK_SIZE, nodeId: 'test-' + def.id });
  const params = resolveParams(def, run.params);
  const out: Record<string, [Float32Array, Float32Array]> = {};
  const midiOut: Record<string, MidiEvent[]> = {};
  for (const [k, o] of Object.entries(def.outputs as OutputSchema)) {
    if (o.type === 'audio') out[k] = [new Float32Array(run.frames), new Float32Array(run.frames)];
    else midiOut[k] = [];
  }
  if (def.category === 'output') out.master = [new Float32Array(run.frames), new Float32Array(run.frames)];
  const bufOut: Record<string, StereoBlock> = {};
  for (const k of Object.keys(out)) bufOut[k] = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)];
  const bufMidiOut: Record<string, MidiEvent[]> = {};
  for (const k of Object.keys(midiOut)) bufMidiOut[k] = [];
  const assets = run.assets ?? {};
  const signals: Record<string, number> = {};
  const signalHistory: Record<string, number[]> = {};
  const live = { mic: null as StereoBlock | null, deviceMidi: [] as MidiEvent[], uiMidi: [] as MidiEvent[] };
  const io: AudioIO = {
    frames: BLOCK_SIZE,
    sampleRate: sr,
    signal: (name, value) => {
      signals[name] = value;
    },
    in: {},
    midiIn: {},
    out: bufOut,
    midiOut: bufMidiOut,
    params,
    time: { seconds: 0, sample: 0, bpm: 120, playing: true, loop: false, duration: 0, ...run.time },
    assets: { get: (id) => assets[id] },
    live,
  };
  const sliceEvents = (evs: MidiEvent[] | undefined, start: number, n: number) =>
    (evs ?? []).filter((e) => e.offset >= start && e.offset < start + n).map((e) => ({ ...e, offset: e.offset - start }));
  const inBufs: Record<string, StereoBlock> = {};
  for (const k of Object.keys(def.inputs)) inBufs[k] = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)];
  const micBuf: StereoBlock = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)];
  const t0 = run.time?.sample ?? 0;
  for (let start = 0; start < run.frames; start += BLOCK_SIZE) {
    const n = Math.min(BLOCK_SIZE, run.frames - start);
    io.frames = n;
    io.time.sample = t0 + start;
    io.time.seconds = io.time.sample / sr;
    for (const [k, def2] of Object.entries(def.inputs as InputSchema)) {
      if (def2.type === 'audio') {
        const src = run.inputs?.[k];
        if (src) {
          const [l, r] = pair(src);
          inBufs[k][0].fill(0);
          inBufs[k][1].fill(0);
          inBufs[k][0].set(l.subarray(start, start + n));
          inBufs[k][1].set(r.subarray(start, start + n));
          io.in[k] = inBufs[k];
        } else io.in[k] = null;
      } else if (def2.type === 'midi') {
        io.midiIn[k] = sliceEvents(run.midi?.[k], start, n);
      }
    }
    if (run.mic) {
      const [l, r] = pair(run.mic);
      micBuf[0].fill(0);
      micBuf[1].fill(0);
      micBuf[0].set(l.subarray(start, start + n));
      micBuf[1].set(r.subarray(start, start + n));
      live.mic = micBuf;
    }
    live.uiMidi = sliceEvents(run.uiMidi, start, n);
    live.deviceMidi = sliceEvents(run.deviceMidi, start, n);
    for (const b of Object.values(bufOut)) {
      b[0].fill(0);
      b[1].fill(0);
    }
    for (const list of Object.values(bufMidiOut)) list.length = 0;
    kernel.process(state, io);
    for (const k of Object.keys(signals)) (signalHistory[k] ??= []).push(signals[k]);
    for (const k of Object.keys(out)) {
      out[k][0].set(bufOut[k][0].subarray(0, n), start);
      out[k][1].set(bufOut[k][1].subarray(0, n), start);
    }
    for (const k of Object.keys(midiOut)) for (const e of bufMidiOut[k]) midiOut[k].push({ ...e, offset: e.offset + start });
  }
  return { out, midiOut, signals, signalHistory, state };
}

let cachedRegistry: Registry | null = null;
export function audioRegistry(): Registry {
  return (cachedRegistry ??= registerAudioNodes());
}
export function getDef(id: string): AnyNodeDef {
  const d = audioRegistry().get(id);
  if (!d) throw new Error('unknown node ' + id);
  return d;
}

/* ----------------------------- graph building ---------------------------- */

export interface GraphSpec {
  nodes: { id: string; type: string; params?: Record<string, unknown>; bypass?: boolean }[];
  /** 'a.port -> b.port' */
  edges: string[];
}
export function makeGraph(spec: GraphSpec, project: Partial<GraphDoc['project']> = {}): GraphDoc {
  return {
    schema: 'rsmps/graph',
    version: 2,
    name: 'test',
    project: { width: 64, height: 64, fps: 24, duration: 4, loop: false, lengthMode: 'relative', referenceSide: 1080, ...project },
    nodes: spec.nodes.map((n, i) => ({ id: n.id, type: n.type, x: i * 10, y: 0, params: n.params ?? {}, bypass: n.bypass })),
    edges: spec.edges.map((s, i) => {
      const m = /^([\w-]+)\.(\w+)\s*->\s*([\w-]+)\.(\w+)$/.exec(s.trim());
      if (!m) throw new Error('bad edge ' + s);
      return { id: 'e' + i, from: { node: m[1], port: m[2] }, to: { node: m[3], port: m[4] } };
    }),
    frames: [],
  };
}

/** Run a graph through the runner for `seconds`, returning the stereo master. */
export function renderGraph(
  doc: GraphDoc,
  seconds: number,
  opts: { sampleRate?: number; mic?: Float32Array; fade?: boolean; playing?: boolean; assets?: Record<string, { sampleRate: number; channels: Float32Array[] }> } = {},
): { left: Float32Array; right: Float32Array; runner: AudioGraphRunner } {
  const sr = opts.sampleRate ?? SR;
  const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: sr, fadeOnRebuild: opts.fade ?? false });
  runner.setGraph(doc);
  for (const [id, pcm] of Object.entries(opts.assets ?? {})) runner.setAsset(id, pcm);
  runner.setTransport({ playing: opts.playing ?? true, seconds: 0, duration: doc.project.duration, loop: doc.project.loop });
  const total = Math.round(seconds * sr);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const bl = new Float32Array(BLOCK_SIZE);
  const br = new Float32Array(BLOCK_SIZE);
  for (let p = 0; p < total; p += BLOCK_SIZE) {
    const n = Math.min(BLOCK_SIZE, total - p);
    if (opts.mic) runner.process(bl, br, n, opts.mic.subarray(p, p + n));
    else runner.process(bl, br, n);
    left.set(bl.subarray(0, n), p);
    right.set(br.subarray(0, n), p);
  }
  return { left, right, runner };
}

export const on = (note: number, offset: number, velocity = 1, channel = 0): MidiEvent => ({ type: 'on', note, velocity, value: 0, offset, channel });
export const off = (note: number, offset: number, channel = 0): MidiEvent => ({ type: 'off', note, velocity: 0, value: 0, offset, channel });

/** Fundamental frequency of a pitched signal by McLeod autocorrelation over a 4096-sample window starting at `from` (0 if none). */
export function pitchHz(x: Float32Array, sr = SR, from = 0, minHz = 40, maxHz = 2000): number {
  const w = 4096;
  const win = Float32Array.from(x.subarray(from, from + w)); // copy; remove DC so asymmetric waves work
  let mean = 0;
  for (let i = 0; i < win.length; i++) mean += win[i];
  mean /= win.length;
  for (let i = 0; i < win.length; i++) win[i] -= mean;
  const maxLag = Math.min(w / 2 - 2, Math.floor(sr / minHz));
  const out = new Float32Array(maxLag + 2);
  nsdf(win, win.length, maxLag, out);
  const r = pickPeriod(out, Math.max(2, Math.floor(sr / maxHz)), maxLag, 0.9, { lag: 0, clarity: 0 });
  return r.lag > 0 ? sr / r.lag : 0;
}
