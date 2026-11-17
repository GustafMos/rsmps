import { describe, expect, it } from 'vitest';
import type { ExportFinishReply, FfmpegExportClient } from './desktop';
import { ffmpegOnlyCodec } from './export-codecs';
import { interleaveF32, packFrames, streamToFfmpeg } from './export-ffmpeg';

function fake(finish: ExportFinishReply = { saved: true, path: 'C:\\out\\clip.mov', bytes: 9, frames: 3 }) {
  const calls: string[] = [];
  const bodies: ArrayBufferView[] = [];
  const client: FfmpegExportClient = {
    info: async () => ({ available: true, source: 'download', version: '9', codecs: [], encoders: null, active: false }),
    start: async (req) => {
      calls.push(`start ${req.codec} ${req.width}x${req.height}@${req.fps}${req.audio ? ` audio ${req.audio.sampleRate}/${req.audio.channels}` : ''}`);
      return { id: 'e1', ext: 'mov', alpha: true, even: false, frameBytes: req.width * req.height * 4 };
    },
    audio: async (_id, pcm) => {
      calls.push('audio');
      bodies.push(pcm);
    },
    frame: async (_id, rgba) => {
      calls.push('frame');
      bodies.push(rgba);
      return calls.filter((c) => c === 'frame').length;
    },
    finish: async () => {
      calls.push('finish');
      return finish;
    },
    cancel: async () => {
      calls.push('cancel');
    },
  };
  return { client, calls, bodies };
}

const frame = (w: number, h: number, v: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });

describe('frame and audio packing', () => {
  it('interleaves planar channels to stereo, keeping two at most', () => {
    const r = interleaveF32([Float32Array.of(1, 2, 3), Float32Array.of(-1, -2, -3), Float32Array.of(9, 9, 9)]);
    expect(r.channels).toBe(2);
    expect(Array.from(r.data)).toEqual([1, -1, 2, -2, 3, -3]);
    const m = interleaveF32([Float32Array.of(0.5, 0.25)]);
    expect(m.channels).toBe(1);
    expect(Array.from(m.data)).toEqual([0.5, 0.25]);
  });
  it('packs whole frames back to back', () => {
    const a = Uint8ClampedArray.of(1, 2, 3, 4);
    const b = Uint8ClampedArray.of(5, 6, 7, 8);
    expect(Array.from(packFrames([a, b]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(packFrames([a])).toBe(a);
  });
});

describe('streamToFfmpeg', () => {
  const base = { fps: 24, bitrateMbps: 12, name: () => 'clip', codec: ffmpegOnlyCodec('prores4444')! };
  it('start, audio, N frames, finish, in that order', async () => {
    const { client, calls, bodies } = fake();
    const progress: number[] = [];
    const r = await streamToFfmpeg({
      ...base,
      client,
      frames: 3,
      render: async (f) => frame(2, 2, f),
      audio: async () => ({ sampleRate: 48000, channels: [Float32Array.of(0, 1), Float32Array.of(1, 0)] }),
      onProgress: (p) => progress.push(p),
    });
    expect(calls).toEqual(['start prores4444 2x2@24 audio 48000/2', 'audio', 'frame', 'frame', 'frame', 'finish']);
    expect(Array.from(bodies[0] as Float32Array)).toEqual([0, 1, 1, 0]);
    expect(bodies.slice(1).map((b) => (b as Uint8ClampedArray)[0])).toEqual([0, 1, 2]);
    expect(r).toMatchObject({ saved: true, path: 'C:\\out\\clip.mov', width: 2, height: 2 });
    expect(Math.max(...progress)).toBeLessThan(1);
  });
  it('sends no audio call when the graph has none', async () => {
    const { client, calls } = fake();
    await streamToFfmpeg({ ...base, client, frames: 2, render: async () => frame(2, 2, 0), audio: async () => null });
    expect(calls).toEqual(['start prores4444 2x2@24', 'frame', 'frame', 'finish']);
  });
  it('cancels the desktop export when aborted mid-way', async () => {
    const { client, calls } = fake();
    const ac = new AbortController();
    await expect(
      streamToFfmpeg({
        ...base,
        client,
        frames: 5,
        signal: ac.signal,
        render: async (f) => {
          if (f === 2) ac.abort();
          return frame(2, 2, f);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.at(-1)).toBe('cancel');
    expect(calls).not.toContain('finish');
    expect(calls.filter((c) => c === 'frame').length).toBeLessThan(5);
  });
  it('cancels when a frame is refused and keeps the readable message', async () => {
    const { client, calls } = fake();
    client.frame = async () => {
      throw new Error('ffmpeg: Unknown encoder');
    };
    await expect(streamToFfmpeg({ ...base, client, frames: 2, render: async () => frame(2, 2, 0) })).rejects.toThrow('ffmpeg: Unknown encoder');
    expect(calls.at(-1)).toBe('cancel');
  });
  it('does not cancel after a save dialog was closed (the desktop already cleaned up)', async () => {
    const { client, calls } = fake({ saved: false, canceled: true });
    const r = await streamToFfmpeg({ ...base, client, frames: 1, render: async () => frame(2, 2, 0) });
    expect(r.saved).toBe(false);
    expect(calls).not.toContain('cancel');
  });
  it('never starts when aborted before the first frame', async () => {
    const { client, calls } = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(streamToFfmpeg({ ...base, client, frames: 1, signal: ac.signal, render: async () => frame(2, 2, 0) })).rejects.toBeTruthy();
    expect(calls).toEqual([]);
  });
});
