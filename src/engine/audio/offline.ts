import type { RenderAudioOffline } from './api';
import { AudioGraphRunner, audioAssetIds, hasAudioOutput } from './runner';
import { BLOCK_SIZE } from './types';

/**
 * Export-time render: the same runner as live playback, driven by a plain loop, faster than real time.
 * Live-only sources (microphone, MIDI devices) are silent. Returns null when there is no audio output.
 */
export const renderAudioOffline: RenderAudioOffline = async (graph, registry, assets, options) => {
  if (!hasAudioOutput(graph, registry)) return null;
  const sampleRate = options.sampleRate ?? 48000;
  const runner = new AudioGraphRunner(registry, { sampleRate, fadeOnRebuild: false });
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
