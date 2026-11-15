/**
 * Real-time host: one AudioWorkletNode runs the whole audio graph (see worklet.ts).
 * Main-thread duties only: AudioContext lifecycle, microphone, Web MIDI, shipping the graph, decoded
 * assets and transport to the worklet, and collecting meters. Not exercised by the headless tests.
 */
import type { Registry } from '../define';
import type { GraphDoc } from '../types';
import type { AudioAssetProvider, AudioDevice, AudioEngine, CreateAudioEngine, RecordedTake, RecordingState, TransportState } from './api';
import { toAudioAsset } from './pcm';
import type { FromWorklet, ToWorklet } from './protocol';
import { MAX_MICS, WORKLET_NAME } from './protocol';
import { audioAssetIds, hasAudioOutput, hasSignalTap } from './runner';
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
  /**
   * One live microphone per microphone node (up to MAX_MICS): node i's source feeds worklet INPUT i, and the runner is
   * told which node reads which input ('micSlots'). Each node has its own MediaStream, so nodes can use different
   * devices. A stream is reopened whenever its device or browser-processing options change.
   */
  private mics = new Map<string, { slot: number; key: string; stream: MediaStream; source: MediaStreamAudioSourceNode }>();
  private micBusy = false;
  private micAgain = false;
  private deviceListeners = new Set<() => void>();
  private devicePlumbing = false;
  private midiProbe: MIDIAccess | null = null;
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
  private signals = new Map<string, number>();
  private recState: RecordingState = { armed: false, recording: false, phase: 'idle', seconds: 0, countIn: 0, level: [0, 0], nodeId: null, error: null };
  private pendingTake: ((take: RecordedTake | null) => void) | null = null;
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
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: MAX_MICS, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      const m = e.data;
      if (m.type === 'meters') {
        for (const [id, v] of Object.entries(m.meters)) this.meters.set(id, v);
      } else if (m.type === 'signals') {
        for (const [id, values] of Object.entries(m.signals)) for (const [name, v] of Object.entries(values)) this.signals.set(id + '\u0000' + name, v);
      } else if (m.type === 'recState') {
        this.recState = m.state;
      } else if (m.type === 'take') {
        this.pendingTake?.(m.take);
        this.pendingTake = null;
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
    this.releaseAllMics();
  }

  setTransport(state: TransportState): void {
    this.transport = { ...state };
    this.post({ type: 'transport', ...state });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, volume);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  armRecording(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void {
    this.post({ type: 'arm', nodeId, target });
    this.recState = target
      ? { ...this.recState, armed: true, phase: 'armed', nodeId, error: null }
      : { armed: false, recording: false, phase: 'idle', seconds: 0, countIn: 0, level: [0, 0], nodeId: null, error: null };
  }

  startRecording(): void {
    const latency = this.ctx ? this.ctx.baseLatency + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) : 0;
    this.post({ type: 'recStart', latency: Number.isFinite(latency) ? latency : 0 });
    this.recState = { ...this.recState, recording: true, phase: 'recording', seconds: 0 };
  }

  stopRecording(): Promise<RecordedTake | null> {
    if (!this.node) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTake = null;
        resolve(null);
      }, 10000);
      this.pendingTake = (take) => {
        clearTimeout(timer);
        resolve(take);
      };
      this.post({ type: 'recStop' });
      this.recState = { ...this.recState, recording: false, phase: this.recState.armed ? 'armed' : 'idle' };
    });
  }

  recordingState(): RecordingState {
    return this.recState;
  }

  hasSignals(graph: GraphDoc, registry: Registry): boolean {
    return hasSignalTap(graph, registry);
  }

  signal(nodeId: string, name: string): number {
    return this.signals.get(nodeId + '\u0000' + name) ?? 0;
  }

  meter(nodeId: string): [number, number] | null {
    return this.meters.get(nodeId) ?? null;
  }

  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void {
    this.post({ type: 'note', nodeId, note, velocity, on });
  }

  dispose(): void {
    this.disposed = true;
    this.releaseAllMics();
    this.deviceListeners.clear();
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
    if (graphUses(graph, registry, 'microphone') || this.mics.size) await this.acquireMic(); // also closes streams of removed nodes
    if (graphUses(graph, registry, 'midi-device')) await this.acquireMidi();
  }

  /** Open, reopen or close microphone streams so they match the microphone nodes in the graph. Serialised. */
  private async acquireMic(): Promise<void> {
    if (this.micBusy) {
      this.micAgain = true;
      return;
    }
    this.micBusy = true;
    try {
      do {
        this.micAgain = false;
        await this.reconcileMics();
      } while (this.micAgain && !this.disposed);
    } finally {
      this.micBusy = false;
    }
  }

  private async reconcileMics(): Promise<void> {
    const { graph, registry, ctx, node } = this;
    if (!graph || !registry || !ctx || !node || !navigator.mediaDevices?.getUserMedia) return;
    const wanted = graph.nodes.filter((n) => n.type === 'microphone' && registry.get(n.type)?.audio).slice(0, MAX_MICS);
    // close streams of removed nodes or whose settings changed
    const want = new Map<string, { slot: number; key: string; device: string; opts: MediaTrackConstraints }>();
    wanted.forEach((n, slot) => {
      const p = n.params as Record<string, unknown>;
      const device = typeof p.device === 'string' ? p.device : '';
      const opts = {
        echoCancellation: p.echoCancellation === true,
        noiseSuppression: p.noiseSuppression === true,
        autoGainControl: p.autoGainControl === true,
      };
      want.set(n.id, { slot, key: JSON.stringify([device, opts]), device, opts });
    });
    for (const [id, m] of [...this.mics]) {
      const w = want.get(id);
      if (!w || w.key !== m.key || w.slot !== m.slot) {
        m.source.disconnect();
        m.stream.getTracks().forEach((t) => t.stop());
        this.mics.delete(id);
      }
    }
    for (const [id, w] of want) {
      if (this.mics.has(id)) continue;
      const stream = await this.openMic(w.device, w.opts);
      if (!stream) continue;
      if (this.disposed || !this.ctx || !this.node) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const source = this.ctx.createMediaStreamSource(stream);
      source.connect(this.node, 0, w.slot);
      this.mics.set(id, { slot: w.slot, key: w.key, stream, source });
      void this.refreshDeviceLabels();
    }
    const slots: Record<string, number> = {};
    for (const [id, m] of this.mics) slots[id] = m.slot;
    this.post({ type: 'micSlots', slots });
  }

  /** getUserMedia with an exact device; falls back to the system default (with a warning) if that device is gone. */
  private async openMic(device: string, opts: MediaTrackConstraints): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: device ? { ...opts, deviceId: { exact: device } } : { ...opts } });
    } catch (err) {
      if (device) {
        console.warn('Chosen microphone is not available, using the system default instead:', err);
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: { ...opts } });
        } catch (err2) {
          console.warn('Microphone unavailable:', err2);
          return null;
        }
      }
      console.warn('Microphone unavailable:', err);
      return null;
    }
  }

  private releaseAllMics(): void {
    for (const m of this.mics.values()) {
      m.source.disconnect();
      m.stream.getTracks().forEach((t) => t.stop());
    }
    this.mics.clear();
  }

  /* ------------------------------ devices ------------------------------ */

  async listDevices(kind: 'audio-input' | 'midi-input'): Promise<AudioDevice[]> {
    try {
      if (kind === 'audio-input') {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
        return inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      }
      const access = this.midi ?? this.midiProbe ?? (await this.probeMidi());
      if (!access) return [];
      return [...access.inputs.values()].map((i) => ({ id: i.id, label: i.name || i.id }));
    } catch {
      return [];
    }
  }

  onDevicesChanged(listener: () => void): () => void {
    this.deviceListeners.add(listener);
    this.plumbDeviceEvents();
    return () => this.deviceListeners.delete(listener);
  }

  private fireDevicesChanged = (): void => {
    for (const l of [...this.deviceListeners]) {
      try {
        l();
      } catch (err) {
        console.warn('Device listener failed:', err);
      }
    }
    // a vanished microphone should fall back, a returning one should be picked up again
    if (this.node) void this.acquireMic();
  };

  private plumbDeviceEvents(): void {
    if (this.devicePlumbing) return;
    this.devicePlumbing = true;
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', this.fireDevicesChanged);
    } catch {
      /* unsupported */
    }
    void this.probeMidi().then((access) => {
      if (access) access.addEventListener('statechange', this.fireDevicesChanged);
    });
  }

  /** Web MIDI access for listing only (does not attach message handlers). null if unsupported or denied. */
  private async probeMidi(): Promise<MIDIAccess | null> {
    if (this.midiProbe) return this.midiProbe;
    if (!navigator.requestMIDIAccess) return null;
    try {
      this.midiProbe = await navigator.requestMIDIAccess();
      return this.midiProbe;
    } catch {
      return null;
    }
  }

  /** Once a microphone is open the browser reveals device names: tell dropdowns to refresh. */
  private async refreshDeviceLabels(): Promise<void> {
    for (const l of [...this.deviceListeners]) l();
  }

  private async acquireMidi(): Promise<void> {
    if (this.midi || this.midiPending || !navigator.requestMIDIAccess) return;
    this.midiPending = true;
    try {
      const access = this.midiProbe ?? (await navigator.requestMIDIAccess());
      if (this.disposed) return;
      this.midi = access;
      const attach = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (e) => this.onMidiMessage(input.id, input.name ?? input.id, e.data);
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

  private onMidiMessage(device: string, deviceName: string, data: Uint8Array | null): void {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    let ev: MidiEvent | null = null;
    if (status === 0x90 && data[2] > 0) ev = { type: 'on', note: data[1], velocity: data[2] / 127, value: 0, offset: 0, channel, device, deviceName };
    else if (status === 0x80 || status === 0x90) ev = { type: 'off', note: data[1], velocity: 0, value: 0, offset: 0, channel, device, deviceName };
    else if (status === 0xb0) ev = { type: 'cc', note: data[1], velocity: 0, value: (data[2] ?? 0) / 127, offset: 0, channel, device, deviceName };
    else if (status === 0xe0) {
      const v = ((data[2] << 7) | data[1]) - 8192;
      ev = { type: 'bend', note: 0, velocity: 0, value: v / 8192, offset: 0, channel, device, deviceName };
    }
    if (ev) this.post({ type: 'midi', events: [ev] });
  }
}

export const createAudioEngine: CreateAudioEngine = () => new WebAudioEngine();
