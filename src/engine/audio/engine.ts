/**
 * Real-time host: one AudioWorkletNode runs the whole audio graph (see worklet.ts).
 * Main-thread duties only: AudioContext lifecycle, microphone, Web MIDI, shipping the graph, decoded
 * assets and transport to the worklet, and collecting meters. Not exercised by the headless tests.
 */
import type { Registry } from '../define';
import type { GraphDoc } from '../types';
import type { AudioAssetProvider, AudioEngine, CreateAudioEngine, TransportState } from './api';
import { toAudioAsset } from './pcm';
import type { FromWorklet, ToWorklet } from './protocol';
import { WORKLET_NAME } from './protocol';
import { audioAssetIds, hasAudioOutput } from './runner';
import type { MidiEvent } from './types';
// Vite bundles the worklet (and everything it imports) as its own module and returns its URL.
// (`new URL('./worklet.ts', import.meta.url)` would copy the file unbundled in production builds.)
import workletUrl from './worklet.ts?worker&url';

function graphUses(graph: GraphDoc, registry: Registry, typeId: string): boolean {
  return graph.nodes.some((n) => n.type === typeId && !!registry.get(n.type)?.audio);
}

class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private mic: { stream: MediaStream; source: MediaStreamAudioSourceNode } | null = null;
  private micPending = false;
  private midi: MIDIAccess | null = null;
  private midiPending = false;
  private starting: Promise<void> | null = null;

  private graph: GraphDoc | null = null;
  private registry: Registry | null = null;
  private provider: AudioAssetProvider | null = null;
  private requested = new Set<string>();
  private transport: TransportState = { playing: false, seconds: 0, duration: 0, loop: false };
  private volume = 1;
  private meters = new Map<string, [number, number]>();
  private disposed = false;

  hasAudio(graph: GraphDoc, registry: Registry): boolean {
    return hasAudioOutput(graph, registry);
  }

  setGraph(graph: GraphDoc, registry: Registry): void {
    this.graph = graph;
    this.registry = registry;
    if (!this.node) return;
    this.post({ type: 'graph', doc: graph });
    this.loadAssets();
    void this.ensureLiveInputs();
  }

  setAssets(provider: AudioAssetProvider): void {
    this.provider = provider;
    this.requested.clear();
    if (this.node) this.loadAssets();
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.starting) {
      this.starting = this.boot().catch((err) => {
        this.starting = null;
        throw err;
      });
    }
    await this.starting;
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
    void this.ensureLiveInputs();
  }

  private async boot(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      const m = e.data;
      if (m.type === 'meters') {
        for (const [id, v] of Object.entries(m.meters)) this.meters.set(id, v);
      } else if (m.type === 'error') {
        console.warn('Audio worklet error:', m.message);
      }
    };
    const master = ctx.createGain();
    master.gain.value = this.volume;
    node.connect(master).connect(ctx.destination);
    this.node = node;
    this.master = master;
    this.post({ type: 'transport', ...this.transport });
    if (this.graph) {
      this.post({ type: 'graph', doc: this.graph });
      this.loadAssets();
    }
  }

  stop(): void {
    void this.ctx?.suspend();
    this.releaseMic();
  }

  setTransport(state: TransportState): void {
    this.transport = { ...state };
    this.post({ type: 'transport', ...state });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, volume);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  meter(nodeId: string): [number, number] | null {
    return this.meters.get(nodeId) ?? null;
  }

  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void {
    this.post({ type: 'note', nodeId, note, velocity, on });
  }

  dispose(): void {
    this.disposed = true;
    this.releaseMic();
    if (this.midi) for (const input of this.midi.inputs.values()) input.onmidimessage = null;
    this.node?.disconnect();
    void this.ctx?.close();
    this.node = null;
    this.ctx = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private post(msg: ToWorklet, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(msg, transfer);
  }

  private loadAssets(): void {
    const { graph, registry, provider, ctx } = this;
    if (!graph || !registry || !provider || !ctx) return;
    for (const id of audioAssetIds(graph, registry)) {
      if (this.requested.has(id)) continue;
      this.requested.add(id);
      provider(id)
        .then((pcm) => {
          if (!pcm || this.disposed) return;
          const a = toAudioAsset(pcm, ctx.sampleRate);
          const mono = a.right === a.left;
          this.post(
            { type: 'asset', id, sampleRate: a.sampleRate, channels: mono ? [a.left] : [a.left, a.right] },
            mono ? [a.left.buffer] : [a.left.buffer, a.right.buffer],
          );
        })
        .catch((err) => console.warn('Could not load audio asset', id, err));
    }
  }

  /** Ask for the microphone / MIDI only when the graph actually has a node that needs them. */
  private async ensureLiveInputs(): Promise<void> {
    const { graph, registry, ctx, node } = this;
    if (!graph || !registry || !ctx || !node) return;
    if (graphUses(graph, registry, 'microphone')) await this.acquireMic();
    if (graphUses(graph, registry, 'midi-device')) await this.acquireMidi();
  }

  private async acquireMic(): Promise<void> {
    if (this.mic || this.micPending || !this.ctx || !this.node) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    this.micPending = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (this.disposed || !this.ctx || !this.node) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const source = this.ctx.createMediaStreamSource(stream);
      source.connect(this.node);
      this.mic = { stream, source };
    } catch (err) {
      console.warn('Microphone unavailable:', err);
    } finally {
      this.micPending = false;
    }
  }

  private releaseMic(): void {
    if (!this.mic) return;
    this.mic.source.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  private async acquireMidi(): Promise<void> {
    if (this.midi || this.midiPending || !navigator.requestMIDIAccess) return;
    this.midiPending = true;
    try {
      const access = await navigator.requestMIDIAccess();
      if (this.disposed) return;
      this.midi = access;
      const attach = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (e) => this.onMidiMessage(input.name ?? input.id, e.data);
        }
      };
      attach();
      access.onstatechange = attach;
    } catch (err) {
      console.warn('Web MIDI unavailable:', err);
    } finally {
      this.midiPending = false;
    }
  }

  private onMidiMessage(device: string, data: Uint8Array | null): void {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    let ev: MidiEvent | null = null;
    if (status === 0x90 && data[2] > 0) ev = { type: 'on', note: data[1], velocity: data[2] / 127, value: 0, offset: 0, channel, device };
    else if (status === 0x80 || status === 0x90) ev = { type: 'off', note: data[1], velocity: 0, value: 0, offset: 0, channel, device };
    else if (status === 0xb0) ev = { type: 'cc', note: data[1], velocity: 0, value: (data[2] ?? 0) / 127, offset: 0, channel, device };
    else if (status === 0xe0) {
      const v = ((data[2] << 7) | data[1]) - 8192;
      ev = { type: 'bend', note: 0, velocity: 0, value: v / 8192, offset: 0, channel, device };
    }
    if (ev) this.post({ type: 'midi', events: [ev] });
  }
}

export const createAudioEngine: CreateAudioEngine = () => new WebAudioEngine();
