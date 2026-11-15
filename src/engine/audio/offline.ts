import type { AnalyzeSignalsOffline, RenderAudioOffline, SignalTracks } from './api';
import { AudioGraphRunner, audioAssetIds, hasExportAudio } from './runner';
import { BLOCK_SIZE } from './types';

/**
 * Export-time render: the same runner as live playback, driven by a plain loop, faster than real time.
 * Live-only sources (microphone, MIDI devices) are silent. Returns null when there is no audio output.
 */
export const renderAudioOffline: RenderAudioOffline = async (graph, registry, assets, options) => {
  if (!hasExportAudio(graph, registry)) return null; // nothing enabled to export: the video gets no audio track
  const sampleRate = options.sampleRate ?? 48000;
  const runner = new AudioGraphRunner(registry, { sampleRate, fadeOnRebuild: false, exportOnly: true });
  runner.setGraph(graph);
  for (const id of audioAssetIds(graph, registry)) {
    const pcm = await assets(id);
    if (pcm) runner.setAsset(id, pcm);
  }
  runner.setTransport({ playing: true, seconds: 0, duration: options.duration, loop: options.loop });
  const total = Math.max(0, Math.round(options.duration * sampleRate));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const bl = new Float32Array(BLOCK_SIZE);
  const br = new Float32Array(BLOCK_SIZE);
  let sinceYield = 0;
  for (let p = 0; p < total; p += BLOCK_SIZE) {
    const n = Math.min(BLOCK_SIZE, total - p);
    runner.process(bl, br, n);
    left.set(bl.subarray(0, n), p);
    right.set(br.subarray(0, n), p);
    sinceYield += n;
    if (sinceYield >= sampleRate * 2) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); // keep the UI alive on long exports
    }
  }
  return { sampleRate, channels: [left, right] };
};

/** Per-frame signal tracks. See `AnalyzeSignalsOffline` for the sampling rule. */
export const analyzeSignalsOffline: AnalyzeSignalsOffline = async (graph, registry, assets, options) => {
  const sampleRate = options.sampleRate ?? 48000;
  const fps = options.fps;
  const frames = Math.max(0, Math.ceil(options.duration * fps - 1e-9));
  const tracks = new Map<string, Float32Array>();
  const runner = new AudioGraphRunner(registry, { sampleRate, fadeOnRebuild: false });
  runner.setGraph(graph);
  for (const id of audioAssetIds(graph, registry)) {
    const pcm = await assets(id);
    if (pcm) runner.setAsset(id, pcm);
  }
  runner.setTransport({ playing: true, seconds: 0, duration: options.duration, loop: options.loop });
  const bl = new Float32Array(BLOCK_SIZE);
  const br = new Float32Array(BLOCK_SIZE);
  let done = 0;
  let sinceYield = 0;
  for (let f = 0; f < frames; f++) {
    const end = Math.round(((f + 1) * sampleRate) / fps);
    while (done < end) {
      const n = Math.min(BLOCK_SIZE, end - done);
      runner.process(bl, br, n);
      done += n;
      sinceYield += n;
    }
    runner.forEachSignal((nodeId, name, value) => {
      const key = nodeId + '\u0000' + name;
      let t = tracks.get(key);
      if (!t) {
        t = new Float32Array(frames);
        tracks.set(key, t);
      }
      t[f] = value;
    });
    if (sinceYield >= sampleRate * 2) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const result: SignalTracks = {
    frames,
    fps,
    value(nodeId, name, frameIndex) {
      const t = tracks.get(nodeId + '\u0000' + name);
      if (!t || frames === 0) return 0;
      return t[Math.min(frames - 1, Math.max(0, Math.floor(frameIndex)))];
    },
    keys: () =>
      [...tracks.keys()].map((k) => {
        const [nodeId, name] = k.split('\u0000');
        return { nodeId, name };
      }),
  };
  return result;
};
