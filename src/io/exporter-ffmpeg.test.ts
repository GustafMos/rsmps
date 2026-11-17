import { expect, it } from 'vitest';
import { harness } from '../engine/testing';
import type { FfmpegExportClient } from './desktop';
import { ExporterImpl } from './exporter';

/** The exporter's FFmpeg routing on the real headless GPU, with a fake desktop client and a stubbed frame renderer. */
async function setup(available: boolean) {
  const t = await harness();
  const calls: string[] = [];
  const sizes: number[] = [];
  const client: FfmpegExportClient = {
    info: async () => ({ available, source: null, version: null, codecs: [], encoders: null, active: false }),
    start: async (r) => {
      calls.push(`start ${r.codec} ${r.width}x${r.height}${r.audio ? ' +audio' : ''}`);
      return { id: 'x', ext: 'mov', alpha: true, even: false, frameBytes: r.width * r.height * 4 };
    },
    audio: async () => void calls.push('audio'),
    frame: async (_id, rgba) => {
      calls.push('frame');
      sizes.push(rgba.byteLength);
      return 1;
    },
    finish: async () => (calls.push('finish'), { saved: true, path: 'C:\\clips\\take one.mov', bytes: 1, frames: 3 }),
    cancel: async () => void calls.push('cancel'),
  };
  const exporter = new ExporterImpl({ gpu: t.gpu, ffmpeg: client } as never) as unknown as {
    exportVideoRouted(job: unknown, run: unknown): Promise<{ name: string; blob: Blob; savedPath?: string }[]>;
    renderFrame: (job: unknown, run: unknown, f: number) => Promise<unknown>;
    videoAudio: () => Promise<null>;
  };
  exporter.renderFrame = async () => t.solid(3, 3, [255, 0, 0, 255]);
  exporter.videoAudio = async () => null;
  const job = (codec: string) => ({ params: { codec, scale: 1, bitrate: 12, name: '{name}' }, sourceName: 'clip', item: 0, itemCount: 1, label: 'Output' });
  const run = { req: { graph: { project: { fps: 24, duration: 0.125 } } }, warnings: [] as string[], used: new Set<string>(), progress: () => undefined };
  return { exporter, job, run, calls, sizes };
}

it('routes an FFmpeg-only codec to the desktop client: start, frames, finish, then a natively saved entry', async () => {
  const { exporter, job, run, calls, sizes } = await setup(true);
  const files = await exporter.exportVideoRouted(job('prores4444'), run);
  expect(calls).toEqual(['start prores4444 3x3', 'frame', 'frame', 'frame', 'finish']);
  expect(sizes).toEqual([36, 36, 36]);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ name: 'take one.mov', savedPath: 'C:\\clips\\take one.mov' });
  expect(files[0].blob.size).toBe(0);
});

it('pads to even for WebM with alpha', async () => {
  const { exporter, job, run, calls, sizes } = await setup(true);
  await exporter.exportVideoRouted(job('webm-alpha'), run);
  expect(calls[0]).toBe('start webm-alpha 4x4');
  expect(sizes[0]).toBe(64);
});

it('says what to do when FFmpeg is not set up, and sends nothing', async () => {
  const { exporter, job, run, calls } = await setup(false);
  await expect(exporter.exportVideoRouted(job('prores'), run)).rejects.toThrow(/needs the desktop app/);
  expect(calls).toEqual([]);
});
