import { describe, expect, it } from 'vitest';
import { harness } from '../engine/testing';
import type { ExportTake } from './api';
import type { FfmpegExportClient } from './desktop';
import { ExporterImpl } from './exporter';
import { streamFrameRate } from './live-record';
import { SignalCapture, SignalRouter } from './signals';

describe('live values remembered during a take', () => {
  it('answers with the latest value at or before a frame, and 0 for a signal it never saw', () => {
    const c = new SignalCapture();
    const key = SignalCapture.key('n', 'level');
    c.add(key, 2, 0.2);
    c.add(key, 5, 0.5);
    c.add(key, 5, 0.9); // the first value of a frame wins
    c.add(key, 4, 0.4); // never backwards
    expect(c.size).toBe(1);
    expect(c.value('n', 'level', 0)).toBe(0.2); // before the first sample: the first
    expect(c.value('n', 'level', 2)).toBe(0.2);
    expect(c.value('n', 'level', 4)).toBe(0.2); // a frame nobody sampled holds the one before
    expect(c.value('n', 'level', 5)).toBe(0.5);
    expect(c.value('n', 'level', 999)).toBe(0.5);
    expect(c.value('n', 'other', 3)).toBe(0);
  });
  it('the router remembers what the live preview read, by take frame, and plays it back as export tracks', () => {
    const r = new SignalRouter();
    r.fps = 10;
    let live = 0.1;
    let takeFrame = 0;
    r.live = () => live;
    const cap = r.startCapture(() => takeFrame);
    expect(r.signal('n', 'level', 0)).toBe(0.1); // rendered frame 0
    takeFrame = 3; // the preview stutters: frames 1 and 2 were never rendered, the tick still samples
    live = 0.6;
    r.recordFrame(3);
    takeFrame = 7;
    live = 0.9;
    expect(r.signal('n', 'level', 0.7)).toBe(0.9);
    r.stopCapture();
    live = 0.3;
    r.recordFrame(9); // after the take: not remembered
    expect([0, 2, 3, 6, 7, 20].map((f) => cap.value('n', 'level', f))).toEqual([0.1, 0.1, 0.6, 0.6, 0.9, 0.9]);
    // the render of the take reads the remembered values, never the microphone of that later moment
    r.beginExport({ fps: 10, value: (id, name, f) => cap.value(id, name, f) });
    expect(r.signal('n', 'level', 0.3)).toBe(0.6);
    r.endExport();
  });
});

describe('the frame rate of a live picture', () => {
  it('is what the stream says, and unknown for anything else', () => {
    expect(streamFrameRate({ srcObject: { getVideoTracks: () => [{ getSettings: () => ({ frameRate: 25 }) }] } })).toBe(25);
    expect(streamFrameRate({ srcObject: { getVideoTracks: () => [{ getSettings: () => ({}) }] } })).toBeNull();
    expect(streamFrameRate({ width: 4 })).toBeNull();
    expect(streamFrameRate(null)).toBeNull();
  });
});

/** The exporter rendering a take, on the real headless GPU with a fake FFmpeg client as the video sink and a stubbed frame renderer. */
async function setup(take: ExportTake) {
  const t = await harness();
  const calls: string[] = [];
  let sound: { sampleRate: number; samples: Float32Array } | null = null;
  const client: FfmpegExportClient = {
    info: async () => ({ available: true, source: null, version: null, codecs: [], encoders: null, active: false }),
    start: async (r) => {
      calls.push(`start ${r.fps}fps`);
      if (r.audio) sound = { sampleRate: r.audio.sampleRate, samples: new Float32Array(0) };
      return { id: 'x', ext: 'mov', alpha: true, even: false, frameBytes: r.width * r.height * 4 };
    },
    audio: async (_id, data) => {
      sound = { sampleRate: sound?.sampleRate ?? 0, samples: new Float32Array(data as Float32Array) };
    },
    frame: async () => (calls.push('frame'), 1),
    finish: async () => ({ saved: true, path: 'take.mov', bytes: 1, frames: 0 }),
    cancel: async () => undefined,
  };
  const exporter = new ExporterImpl({ gpu: t.gpu, ffmpeg: client, audio: { hasExportAudio: () => true, renderOffline: async () => (calls.push('graph sound'), null) } } as never) as unknown as {
    exportVideoRouted(job: unknown, run: unknown): Promise<unknown[]>;
    renderFrame: (job: unknown, run: unknown, f: number) => Promise<unknown>;
  };
  const rendered: number[] = [];
  exporter.renderFrame = async (_job, _run, f) => (rendered.push(f), t.solid(4, 4, [255, 0, 0, 255]));
  const job = { params: { codec: 'prores4444', scale: 1, bitrate: 12, name: '{name}' }, out: { id: 'out', params: {} }, sourceName: 'clip', item: 0, itemCount: 1, label: 'Output' };
  // the project is 3 frames long; the take is longer
  const run = { req: { graph: { project: { fps: 24, duration: 0.125, loop: true }, nodes: [], edges: [] }, take }, warnings: [] as string[], used: new Set<string>(), progress: () => undefined };
  await exporter.exportVideoRouted(job, run);
  return { calls, rendered, sound: () => sound };
}

describe('the exporter renders a recorded take', () => {
  it('renders as many frames as the take has, whatever the project length, each exactly once and in order', async () => {
    const r = await setup({ frames: 7, at: (f) => ({ seconds: f / 24 }), audio: null });
    expect(r.rendered).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.calls.filter((c) => c === 'frame')).toHaveLength(7);
    expect(r.calls[0]).toBe('start 24fps');
  });
  it('muxes the recorded sound from where frame 0 is, cut to the take, and never renders the graph sound', async () => {
    const pcm = { sampleRate: 48, channels: [Float32Array.from({ length: 48 }, (_, i) => i)] };
    const r = await setup({ frames: 12, at: (f) => ({ seconds: f / 24 }), audio: pcm, audioStart: 0.25 });
    const s = r.sound()!;
    expect(s.sampleRate).toBe(48);
    expect(s.samples).toHaveLength(24); // 12 frames at 24 fps = half a second at 48 Hz
    expect(s.samples[0]).toBe(12); // a quarter second in
    expect(r.calls).not.toContain('graph sound');
    const silent = await setup({ frames: 2, at: (f) => ({ seconds: f / 24 }), audio: null });
    expect(silent.sound()).toBeNull();
    expect(silent.calls).not.toContain('graph sound');
  });
});

describe('a frame of a take is evaluated at the project time it was seen at', () => {
  it('asks the engine for the take\'s time and, in a later pass of a looping project, for that pass\'s copy of the graph', async () => {
    const t = await harness();
    const asked: { seconds: number; graph: unknown }[] = [];
    const gate = {
      evaluateHeld: async (r: { seconds: number; graph: unknown }) => {
        asked.push({ seconds: r.seconds, graph: r.graph });
        const img = t.solid(4, 4, [0, 255, 0, 255]);
        t.gpu.retain(img.texture);
        return { value: img, errors: new Map() };
      },
      drop: () => undefined,
    };
    const exporter = new ExporterImpl({ gpu: t.gpu, gate } as never) as unknown as { renderFrame: (job: unknown, run: unknown, f: number) => Promise<unknown> };
    const first = { project: { fps: 25, duration: 4, loop: true, width: 4, height: 4 } };
    const second = { ...first };
    const job = { out: { id: 'out', params: {} }, item: 0, itemCount: 1, params: {} };
    // a 4 second project that looped: frame 150 of the take is 2 s into the second pass
    const take: ExportTake = { frames: 200, at: (f) => ({ seconds: (f % 100) / 25, graph: f >= 100 ? (second as never) : undefined }), audio: null };
    const run = { req: { graph: first, take }, warnings: [] };
    await exporter.renderFrame(job, run, 30);
    await exporter.renderFrame(job, run, 150);
    expect(asked).toEqual([{ seconds: 1.2, graph: first }, { seconds: 2, graph: second }]);
    expect(asked[1].graph).toBe(second);
    // an ordinary export is unchanged: frame / fps of the one graph
    await exporter.renderFrame(job, { req: { graph: first }, warnings: [] }, 150);
    expect(asked[2]).toEqual({ seconds: 6, graph: first });
  });
});
