/**
 * AudioWorklet entry: runs the whole audio graph (AudioGraphRunner) inside one processor.
 * Bundled by Vite as a separate module (see engine.ts). Imports only audio code: no image nodes,
 * no DOM, no WebGPU.
 */
import { registerAudioNodes } from './nodes';
import type { FromWorklet, ToWorklet } from './protocol';
import { MAX_MICS, WORKLET_NAME } from './protocol';
import { AudioGraphRunner } from './runner';
import { BLOCK_SIZE } from './types';

/* AudioWorkletGlobalScope globals (not in the DOM lib). */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class RsmpsProcessor extends AudioWorkletProcessor {
  private runner: AudioGraphRunner;
  private sinceMeters = 0;
  private sinceSignals = 0;
  private sinceRec = 0;
  private reportedError = false;
  private scratch = new Float32Array(BLOCK_SIZE * 4);
  private slotBlocks: ([Float32Array, Float32Array] | null)[] = Array.from({ length: MAX_MICS }, () => null);

  constructor() {
    super();
    this.runner = new AudioGraphRunner(registerAudioNodes(), { sampleRate });
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      try {
        this.onMessage(e.data);
      } catch (err) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg);
  }

  private onMessage(m: ToWorklet): void {
    const r = this.runner;
    switch (m.type) {
      case 'graph':
        r.setGraph(m.doc);
        break;
      case 'asset':
        r.setAsset(m.id, { sampleRate: m.sampleRate, channels: m.channels, video: m.video });
        break;
      case 'transport':
        r.setTransport({ playing: m.playing, seconds: m.seconds, duration: m.duration, loop: m.loop, item: m.item });
        break;
      case 'midi':
        for (const ev of m.events) r.sendMidi(null, ev);
        break;
      case 'arm':
        r.armRecording(m.nodeId, m.target);
        break;
      case 'recStart':
        r.startRecording(m.latency);
        break;
      case 'recStop': {
        const take = r.stopRecording();
        const transfer: ArrayBuffer[] = [];
        if (take?.pcm) for (const ch of take.pcm.channels) if (!transfer.includes(ch.buffer as ArrayBuffer)) transfer.push(ch.buffer as ArrayBuffer);
        this.port.postMessage({ type: 'take', take } satisfies FromWorklet, transfer);
        break;
      }
      case 'micSlots':
        r.setMicSlots(m.slots);
        break;
      case 'note':
        r.sendMidi(m.nodeId, { type: m.on ? 'on' : 'off', note: m.note, velocity: m.on ? m.velocity : 0, value: 0, offset: 0, channel: 0 });
        break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out[1];
    const inp = inputs[0];
    const micL = inp && inp.length > 0 ? inp[0] : undefined;
    const micR = inp && inp.length > 1 ? inp[1] : micL;
    const total = outL.length;
    // One worklet input per microphone node: build [L, R] pairs for slots that carry audio.
    const slots = this.slotBlocks;
    for (let k = 0; k < MAX_MICS; k++) {
      const ch = inputs[k];
      slots[k] = ch && ch.length > 0 ? [ch[0], ch.length > 1 ? ch[1] : ch[0]] : null;
    }
    try {
      for (let p = 0; p < total; p += BLOCK_SIZE) {
        const n = Math.min(BLOCK_SIZE, total - p);
        const l = outL.subarray(p, p + n);
        if (outR) {
          this.runner.process(l, outR.subarray(p, p + n), n, micL?.subarray(p, p + n), micR?.subarray(p, p + n), total <= BLOCK_SIZE ? slots : undefined);
        } else {
          const tmpR = this.scratch.subarray(0, n);
          this.runner.process(l, tmpR, n, micL?.subarray(p, p + n), micR?.subarray(p, p + n), total <= BLOCK_SIZE ? slots : undefined);
          for (let i = 0; i < n; i++) l[i] = (l[i] + tmpR[i]) * 0.5;
        }
      }
    } catch (err) {
      outL.fill(0);
      outR?.fill(0);
      if (!this.reportedError) {
        this.reportedError = true;
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
    this.sinceMeters += total;
    if (this.sinceMeters >= sampleRate / 30) {
      this.sinceMeters = 0;
      this.post({ type: 'meters', meters: this.runner.takeMeters() });
    }
    this.sinceRec += total;
    if (this.sinceRec >= sampleRate / 30) {
      this.sinceRec = 0;
      const state = this.runner.recordingState();
      if (state.armed) this.post({ type: 'recState', state });
    }
    this.sinceSignals += total;
    if (this.sinceSignals >= sampleRate / 60) {
      this.sinceSignals = 0;
      const signals = this.runner.signalSnapshot();
      if (Object.keys(signals).length) this.post({ type: 'signals', signals });
    }
    return true;
  }
}

registerProcessor(WORKLET_NAME, RsmpsProcessor);
