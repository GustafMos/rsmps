/**
 * AudioGraphRunner: compiles a GraphDoc into an ordered list of kernel instances and processes it
 * one block at a time. Plain TypeScript, no browser APIs: the same class runs inside the
 * AudioWorkletProcessor (live) and in a plain loop (export, tests).
 */
import type { Registry } from '../define';
import type { AnyNodeDef, GraphDoc, InputSchema, OutputSchema, ParamSchema } from '../types';
import type { RecordedTake, RecordingState } from './api';
import { resolveParams } from './params';
import { toAudioAsset } from './pcm';
import {
  BLOCK_SIZE,
  type AudioAsset,
  type AudioIO,
  type AudioKernel,
  type AudioTime,
  type MidiEvent,
  type StereoBlock,
} from './types';

export interface RunnerOptions {
  sampleRate: number;
  blockSize?: number;
  /** Fade the master in over ~10 ms after a topology change (default true). Offline renders turn it off. */
  fadeOnRebuild?: boolean;
  /** Export mode: audio-out nodes that are switched off (`enabled` false) or bypassed are not rendered. */
  exportOnly?: boolean;
}

export interface TransportUpdate {
  /** Batch item being previewed or exported. */
  item?: number;
  playing?: boolean;
  /** Seek to this position. */
  seconds?: number;
  duration?: number;
  loop?: boolean;
  bpm?: number;
}

interface Source {
  node: PlanNode;
  port: string;
}

interface PlanNode {
  id: string;
  type: string;
  def: AnyNodeDef;
  kernel: AudioKernel;
  state: unknown;
  params: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  bypass: boolean;
  io: AudioIO;
  sink: boolean;
  audioInNames: string[];
  midiInNames: string[];
  outBufs: StereoBlock[];
  meterBuf: StereoBlock | undefined;
  midiOutLists: MidiEvent[][];
  audioSrcs: Record<string, Source[]>;
  midiSrcs: Record<string, Source[]>;
  sums: Record<string, StereoBlock>;
  merges: Record<string, MidiEvent[]>;
  uiPending: MidiEvent[];
  peak: [number, number];
  signals: Record<string, number>;
}

const isAudioNode = (def: AnyNodeDef | undefined): def is AnyNodeDef => !!def && !!def.audio;

const isExported = (n: { params: Record<string, unknown>; bypass?: boolean }): boolean => n.params.enabled !== false && !n.bypass;

/** True if an audio-out that is included in exports (not switched off, not bypassed) has something wired into it. */
export function hasExportAudio(graph: GraphDoc, registry: Registry): boolean {
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (isAudioNode(def) && def.category === 'output' && isExported(n) && graph.edges.some((e) => e.to.node === n.id)) return true;
  }
  return false;
}

/** True if the graph has an audio sink with something wired into it. */
export function hasAudioOutput(graph: GraphDoc, registry: Registry): boolean {
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (isAudioNode(def) && def.category === 'output' && graph.edges.some((e) => e.to.node === n.id)) return true;
  }
  return false;
}

/** True if the graph has an analysis tap (stream node with a stream input but no stream output) that something feeds. */
export function hasSignalTap(graph: GraphDoc, registry: Registry): boolean {
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!isAudioNode(def) || def.category === 'output') continue;
    const outs = Object.values(def.outputs as OutputSchema);
    if (outs.some((o) => o.type === 'audio' || o.type === 'midi') && !def.audio?.runWhenFed) continue;
    const ins = def.inputs as InputSchema;
    if (graph.edges.some((e) => e.to.node === n.id && ins[e.to.port] && (ins[e.to.port].type === 'audio' || ins[e.to.port].type === 'midi'))) return true;
  }
  return false;
}

/** Asset ids referenced by audio nodes that are upstream of an output. */
export function audioAssetIds(graph: GraphDoc, registry: Registry, item = 0): string[] {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!isAudioNode(def)) continue;
    const k = def.audio!;
    if (k.loadAssetsOnlyWhenWired && !graph.edges.some((e) => e.from.node === n.id && (def.outputs as OutputSchema)[e.from.port]?.type === 'audio')) continue;
    if (k.assets) {
      for (const id of k.assets(resolveParams(def, n.params), item)) ids.add(id);
      continue;
    }
    for (const [key, p] of Object.entries(def.params as ParamSchema)) {
      if (p.type === 'assets') {
        const v = n.params[key];
        if (Array.isArray(v)) for (const id of v) if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return [...ids];
}

export class AudioGraphRunner {
  readonly sampleRate: number;
  readonly blockSize: number;
  readonly time: AudioTime = { seconds: 0, sample: 0, bpm: 120, playing: false, loop: false, duration: 0, item: 0 };

  private registry: Registry;
  private fadeOnRebuild: boolean;
  private exportOnly: boolean;
  private nodes = new Map<string, PlanNode>();
  private order: PlanNode[] = [];
  private sinks: PlanNode[] = [];
  private signature = '';
  private assets = new Map<string, AudioAsset>();
  private assetApi = { get: (id: string) => this.assets.get(id) };
  private deviceMidi: MidiEvent[] = [];
  private deviceMidiBlock: MidiEvent[] = [];
  private fadeLeft = 0;
  private fadeTotal: number;
  private faults = 0;
  private micSlots = new Map<string, number>();
  private recNode: string | null = null;

  constructor(registry: Registry, options: RunnerOptions) {
    this.registry = registry;
    this.sampleRate = options.sampleRate;
    this.blockSize = options.blockSize ?? BLOCK_SIZE;
    this.fadeOnRebuild = options.fadeOnRebuild ?? true;
    this.exportOnly = options.exportOnly ?? false;
    this.fadeTotal = Math.max(1, Math.round(this.sampleRate * 0.01));
  }

  /** Number of kernels currently running (upstream of an output). */
  get nodeCount(): number {
    return this.order.length;
  }
  /** How many times a kernel produced NaN/Infinity and was reset. */
  get faultCount(): number {
    return this.faults;
  }
  hasOutput(): boolean {
    return this.sinks.length > 0;
  }
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }
  /** Kernel state of a node (tests, debugging). */
  stateOf(id: string): unknown {
    return this.nodes.get(id)?.state;
  }

  setAsset(id: string, pcm: { sampleRate: number; channels: Float32Array[]; video?: { duration: number; fps: number } } | null): void {
    if (!pcm) this.assets.delete(id);
    else this.assets.set(id, toAudioAsset(pcm, this.sampleRate));
  }

  setTransport(t: TransportUpdate): void {
    const tm = this.time;
    if (t.playing !== undefined) tm.playing = t.playing;
    if (t.duration !== undefined) tm.duration = t.duration;
    if (t.loop !== undefined) tm.loop = t.loop;
    if (t.bpm !== undefined) tm.bpm = t.bpm;
    if (t.item !== undefined) tm.item = t.item;
    if (t.seconds !== undefined) {
      tm.sample = Math.max(0, Math.round(t.seconds * this.sampleRate));
      tm.seconds = tm.sample / this.sampleRate;
    }
  }

  /**
   * Route microphone nodes to host input slots (worklet input k carries one microphone): { nodeId: slot }.
   * Nodes without a slot read the default microphone block passed to `process` (slot-less hosts, tests).
   */
  setMicSlots(slots: Record<string, number>): void {
    this.micSlots.clear();
    for (const k of Object.keys(slots)) this.micSlots.set(k, slots[k]);
  }

  /** Send a host command to a node's kernel (see `AudioKernel.control`). Returns its result, or undefined if the node is not running. */
  control(nodeId: string, message: unknown): unknown {
    const pn = this.nodes.get(nodeId);
    return pn?.kernel.control ? pn.kernel.control(pn.state, message, pn.params) : undefined;
  }

  /**
   * Arm one recording node (Timeline) for a track, or pass null to disarm. Arming another node disarms the previous one.
   * What is wired to the node's recordAudio / recordMidi input is what gets captured.
   */
  armRecording(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void {
    if (this.recNode && this.recNode !== nodeId) this.control(this.recNode, { type: 'arm', target: null });
    this.control(nodeId, { type: 'arm', target });
    this.recNode = target ? nodeId : null;
  }

  /**
   * Begin capturing on the armed node. `latency` = seconds of device latency to compensate (baseLatency + outputLatency).
   * Added to it: the largest `latencyMs` param among the nodes feeding the recording (a Phone Camera's link delay).
   */
  startRecording(latency = 0): void {
    if (this.recNode) this.control(this.recNode, { type: 'start', latency: latency + this.upstreamLatency(this.recNode) });
  }

  /** Largest `latencyMs` (as seconds) of any node upstream of `nodeId`: delay the signal picked up on its way in. */
  private upstreamLatency(nodeId: string): number {
    const seen = new Set<string>();
    let best = 0;
    const visit = (pn: PlanNode | undefined) => {
      if (!pn || seen.has(pn.id)) return;
      seen.add(pn.id);
      const ms = pn.params.latencyMs;
      if (typeof ms === 'number' && Number.isFinite(ms) && pn.id !== nodeId) best = Math.max(best, ms / 1000);
      for (const list of [...Object.values(pn.audioSrcs), ...Object.values(pn.midiSrcs)]) for (const src of list) visit(src.node);
    };
    visit(this.nodes.get(nodeId));
    return best;
  }

  /** Stop and return the take (null if nothing was captured). The node stays armed. */
  stopRecording(): RecordedTake | null {
    return this.recNode ? ((this.control(this.recNode, { type: 'stop' }) as RecordedTake | null) ?? null) : null;
  }

  recordingState(): RecordingState {
    const s = this.recNode ? (this.control(this.recNode, { type: 'state' }) as RecordingState | undefined) : undefined;
    return s ?? { armed: false, recording: false, phase: 'idle', seconds: 0, countIn: 0, level: [0, 0], nodeId: null, error: null };
  }

  /** Queue a MIDI event for the next block. `nodeId` null = hardware device input (all device nodes see it). */
  sendMidi(nodeId: string | null, ev: MidiEvent): void {
    if (nodeId === null) this.deviceMidi.push(ev);
    else this.nodes.get(nodeId)?.uiPending.push(ev);
  }

  /**
   * Install a graph. Param-only changes update in place and keep all state; a changed set of nodes or
   * wires recompiles, keeping the state of nodes whose id and type did not change.
   * Returns true when the topology was rebuilt.
   */
  setGraph(doc: GraphDoc): boolean {
    const registry = this.registry;
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const sinkIds = doc.nodes.filter((n) => {
      const d = registry.get(n.type);
      return isAudioNode(d) && d.category === 'output' && (!this.exportOnly || isExported(n));
    });
    // Edges that carry stream data between audio nodes.
    const edges = doc.edges.filter((e) => {
      const a = byId.get(e.from.node);
      const b = byId.get(e.to.node);
      if (!a || !b) return false;
      const da = registry.get(a.type);
      const db = registry.get(b.type);
      if (!isAudioNode(da) || !isAudioNode(db)) return false;
      const o = da.outputs[e.from.port];
      const i = db.inputs[e.to.port];
      return !!o && !!i && o.type === i.type && (o.type === 'audio' || o.type === 'midi');
    });
    // Roots: the audio sinks, plus analysis taps (stream nodes with a stream input but no stream output, e.g. the
    // sound -> picture bridge nodes). Taps run even when nothing is wired to an audio-out.
    const hasStreamOut = (d: AnyNodeDef) => Object.values(d.outputs as OutputSchema).some((o) => o.type === 'audio' || o.type === 'midi');
    const tapIds = doc.nodes.filter((n) => {
      const d = registry.get(n.type);
      return isAudioNode(d) && d.category !== 'output' && (!hasStreamOut(d) || !!d.audio?.runWhenFed) && edges.some((e) => e.to.node === n.id);
    });
    // Upstream closure of the roots.
    const needed = new Set<string>();
    const stack = [...sinkIds, ...tapIds].map((n) => n.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (needed.has(id)) continue;
      needed.add(id);
      for (const e of edges) if (e.to.node === id) stack.push(e.from.node);
    }
    const liveEdges = edges.filter((e) => needed.has(e.from.node) && needed.has(e.to.node));
    const sig =
      [...needed].sort().map((id) => id + ':' + byId.get(id)!.type).join(',') +
      '|' +
      liveEdges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort().join(',');

    // Create / update nodes.
    const next = new Map<string, PlanNode>();
    for (const id of needed) {
      const inst = byId.get(id)!;
      const def = registry.get(inst.type)!;
      let pn = this.nodes.get(id);
      if (pn && pn.type !== inst.type) pn = undefined;
      if (!pn) pn = this.createNode(id, def);
      pn.def = def;
      resolveParams(def, inst.params, pn.params);
      pn.bypass = !!inst.bypass;
      next.set(id, pn);
    }
    if (sig === this.signature && next.size === this.nodes.size) return false;

    this.nodes = next;
    // Wire sources.
    for (const pn of next.values()) {
      pn.audioSrcs = {};
      pn.midiSrcs = {};
    }
    for (const e of liveEdges) {
      const dst = next.get(e.to.node)!;
      const src = next.get(e.from.node)!;
      const type = dst.def.inputs[e.to.port].type;
      const table = type === 'audio' ? dst.audioSrcs : dst.midiSrcs;
      (table[e.to.port] ??= []).push({ node: src, port: e.from.port });
    }
    // Topological order (DFS post-order from sinks).
    const order: PlanNode[] = [];
    const seen = new Set<string>();
    const visit = (pn: PlanNode) => {
      if (seen.has(pn.id)) return;
      seen.add(pn.id);
      for (const list of [...Object.values(pn.audioSrcs), ...Object.values(pn.midiSrcs)]) for (const s of list) visit(s.node);
      order.push(pn);
    };
    for (const s of [...sinkIds, ...tapIds]) visit(next.get(s.id)!);
    this.order = order;
    this.sinks = order.filter((n) => n.sink);
    this.signature = sig;
    if (this.fadeOnRebuild) this.fadeLeft = this.fadeTotal;
    return true;
  }

  private createNode(id: string, def: AnyNodeDef): PlanNode {
    const bs = this.blockSize;
    const kernel = def.audio as AudioKernel;
    const sink = def.category === 'output';
    const out: Record<string, StereoBlock> = {};
    const midiOut: Record<string, MidiEvent[]> = {};
    for (const [name, o] of Object.entries(def.outputs as OutputSchema)) {
      if (o.type === 'audio') out[name] = [new Float32Array(bs), new Float32Array(bs)];
      else if (o.type === 'midi') midiOut[name] = [];
    }
    if (sink) out.master = [new Float32Array(bs), new Float32Array(bs)];
    const sums: Record<string, StereoBlock> = {};
    const merges: Record<string, MidiEvent[]> = {};
    const ins: AudioIO['in'] = {};
    const midiIn: AudioIO['midiIn'] = {};
    for (const [name, i] of Object.entries(def.inputs as InputSchema)) {
      if (i.type === 'audio') {
        sums[name] = [new Float32Array(bs), new Float32Array(bs)];
        ins[name] = null;
      } else if (i.type === 'midi') {
        merges[name] = [];
        midiIn[name] = [];
      }
    }
    const params: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const signals: Record<string, number> = {};
    const io: AudioIO = {
      signal: (name, value) => {
        signals[name] = value;
      },
      frames: bs,
      sampleRate: this.sampleRate,
      in: ins,
      midiIn,
      out,
      midiOut,
      params,
      time: this.time,
      assets: this.assetApi,
      live: { mic: null, deviceMidi: this.deviceMidiBlock, uiMidi: [] },
    };
    return {
      id,
      type: def.id,
      def,
      kernel,
      state: kernel.create({ sampleRate: this.sampleRate, blockSize: bs, nodeId: id }),
      params,
      bypass: false,
      io,
      sink,
      audioInNames: Object.keys(sums),
      midiInNames: Object.keys(merges),
      outBufs: Object.values(out),
      meterBuf: sink ? out.master : Object.values(out)[0],
      midiOutLists: Object.values(midiOut),
      audioSrcs: {},
      midiSrcs: {},
      sums,
      merges,
      uiPending: [],
      peak: [0, 0],
      signals,
    };
  }

  /**
   * Process one block (`frames` <= blockSize) into outL/outR (overwritten).
   * `micL`/`micR` are the live input for this block (R defaults to L); omit offline.
   */
  process(
    outL: Float32Array,
    outR: Float32Array,
    frames: number,
    micL?: Float32Array | null,
    micR?: Float32Array | null,
    slotMics?: ([Float32Array, Float32Array] | null)[],
  ): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    if (frames > this.blockSize) throw new Error(`frames ${frames} exceeds block size ${this.blockSize}`);
    const tm = this.time;
    tm.seconds = tm.sample / this.sampleRate;

    // Device MIDI for this block.
    this.deviceMidiBlock.length = 0;
    for (let i = 0; i < this.deviceMidi.length; i++) this.deviceMidiBlock.push(this.deviceMidi[i]);
    this.deviceMidi.length = 0;
    const mic: StereoBlock | null = micL ? [micL, micR ?? micL] : null;

    for (const pn of this.order) {
      const io = pn.io;
      io.frames = frames;
      const slot = this.micSlots.size ? this.micSlots.get(pn.id) : undefined;
      io.live.mic = slot === undefined ? mic : (slotMics?.[slot] ?? null);
      io.live.uiMidi.length = 0;
      for (let i = 0; i < pn.uiPending.length; i++) io.live.uiMidi.push(pn.uiPending[i]);
      pn.uiPending.length = 0;
      for (let k = 0; k < pn.outBufs.length; k++) {
        pn.outBufs[k][0].fill(0, 0, frames);
        pn.outBufs[k][1].fill(0, 0, frames);
      }
      for (let k = 0; k < pn.midiOutLists.length; k++) pn.midiOutLists[k].length = 0;

      // Gather inputs: one wire is read in place, several are summed/merged.
      for (let k = 0; k < pn.audioInNames.length; k++) {
        const name = pn.audioInNames[k];
        const srcs = pn.audioSrcs[name];
        if (!srcs || srcs.length === 0) {
          io.in[name] = null;
        } else if (srcs.length === 1) {
          io.in[name] = srcs[0].node.io.out[srcs[0].port];
        } else {
          const sum = pn.sums[name];
          sum[0].fill(0, 0, frames);
          sum[1].fill(0, 0, frames);
          for (const s of srcs) {
            const b = s.node.io.out[s.port];
            for (let i = 0; i < frames; i++) {
              sum[0][i] += b[0][i];
              sum[1][i] += b[1][i];
            }
          }
          io.in[name] = sum;
        }
      }
      for (let k = 0; k < pn.midiInNames.length; k++) {
        const name = pn.midiInNames[k];
        const srcs = pn.midiSrcs[name];
        if (!srcs || srcs.length === 0) {
          io.midiIn[name] = pn.merges[name];
          pn.merges[name].length = 0;
        } else if (srcs.length === 1) {
          io.midiIn[name] = srcs[0].node.io.midiOut[srcs[0].port];
        } else {
          const m = pn.merges[name];
          m.length = 0;
          for (const s of srcs) for (const ev of s.node.io.midiOut[s.port]) m.push(ev);
          // stable insertion sort by offset
          for (let i = 1; i < m.length; i++) {
            const x = m[i];
            let j = i - 1;
            while (j >= 0 && m[j].offset > x.offset) {
              m[j + 1] = m[j];
              j--;
            }
            m[j + 1] = x;
          }
          io.midiIn[name] = m;
        }
      }

      if (pn.bypass) this.bypass(pn, frames);
      else pn.kernel.process(pn.state, io);

      // Containment: a misbehaving kernel must not poison the whole mix.
      let acc = 0;
      for (let k = 0; k < pn.outBufs.length; k++) {
        const l = pn.outBufs[k][0];
        const r = pn.outBufs[k][1];
        for (let i = 0; i < frames; i++) acc += l[i] * 0 + r[i] * 0;
      }
      if (acc !== acc) {
        this.faults++;
        for (let k = 0; k < pn.outBufs.length; k++) {
          pn.outBufs[k][0].fill(0, 0, frames);
          pn.outBufs[k][1].fill(0, 0, frames);
        }
        pn.state = pn.kernel.create({ sampleRate: this.sampleRate, blockSize: this.blockSize, nodeId: pn.id });
      } else if (pn.meterBuf) {
        const ml = pn.meterBuf[0];
        const mr = pn.meterBuf[1];
        let peakL = pn.peak[0];
        let peakR = pn.peak[1];
        for (let i = 0; i < frames; i++) {
          const x = ml[i];
          const y = mr[i];
          if (x > peakL) peakL = x;
          else if (-x > peakL) peakL = -x;
          if (y > peakR) peakR = y;
          else if (-y > peakR) peakR = -y;
        }
        pn.peak[0] = peakL;
        pn.peak[1] = peakR;
      }
    }

    for (const s of this.sinks) {
      const m = s.io.out.master;
      for (let i = 0; i < frames; i++) {
        outL[i] += m[0][i];
        outR[i] += m[1][i];
      }
    }

    if (this.fadeLeft > 0) {
      for (let i = 0; i < frames; i++) {
        const g = this.fadeLeft > 0 ? 1 - this.fadeLeft / this.fadeTotal : 1;
        outL[i] *= g;
        outR[i] *= g;
        if (this.fadeLeft > 0) this.fadeLeft--;
      }
    }
    // Last line of defence: never emit NaN/Infinity to the speakers.
    for (let i = 0; i < frames; i++) {
      if (!(outL[i] - outL[i] === 0)) outL[i] = 0;
      if (!(outR[i] - outR[i] === 0)) outR[i] = 0;
    }

    if (tm.playing) {
      tm.sample += frames;
      if (tm.loop && tm.duration > 0) {
        const total = Math.round(tm.duration * this.sampleRate);
        if (tm.sample >= total) tm.sample -= total;
      }
    }
  }

  private bypass(pn: PlanNode, frames: number): void {
    const io = pn.io;
    for (const [oname, o] of Object.entries(pn.def.outputs as OutputSchema)) {
      if (o.type === 'audio') {
        const inName = Object.keys(pn.def.inputs).find((k) => pn.def.inputs[k].type === 'audio');
        const src = inName ? io.in[inName] : null;
        if (src) {
          io.out[oname][0].set(src[0].subarray(0, frames));
          io.out[oname][1].set(src[1].subarray(0, frames));
        }
      } else if (o.type === 'midi') {
        const inName = Object.keys(pn.def.inputs).find((k) => pn.def.inputs[k].type === 'midi');
        if (inName) for (const ev of io.midiIn[inName]) io.midiOut[oname].push(ev);
      }
    }
    if (pn.sink) {
      const inName = Object.keys(pn.def.inputs).find((k) => pn.def.inputs[k].type === 'audio');
      const src = inName ? io.in[inName] : null;
      if (src) {
        io.out.master[0].set(src[0].subarray(0, frames));
        io.out.master[1].set(src[1].subarray(0, frames));
      }
    }
  }

  /** Latest published signals of every running node: { nodeId: { name: value } }. Allocates; call at ~60 Hz at most. */
  signalSnapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const pn of this.order) {
      const keys = Object.keys(pn.signals);
      if (keys.length) out[pn.id] = { ...pn.signals };
    }
    return out;
  }

  /** Latest published value of one signal (0 if unknown). */
  signal(nodeId: string, name: string): number {
    return this.nodes.get(nodeId)?.signals[name] ?? 0;
  }

  /** Visit every published signal without allocating. */
  forEachSignal(fn: (nodeId: string, name: string, value: number) => void): void {
    for (const pn of this.order) for (const k in pn.signals) fn(pn.id, k, pn.signals[k]);
  }

  /** Peak levels since the last call (then reset), by node id. */
  takeMeters(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const pn of this.order) {
      out[pn.id] = [pn.peak[0], pn.peak[1]];
      pn.peak[0] = 0;
      pn.peak[1] = 0;
    }
    return out;
  }
}
