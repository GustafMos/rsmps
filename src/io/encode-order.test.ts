import { describe, expect, it } from 'vitest';
import { avcBaselineCodec, avcLevelFor, isReordered } from './encode-order';

describe('encoder frame order', () => {
  it('detects frames handed back out of order', () => {
    expect(isReordered([0, 1, 2, 3])).toBe(false);
    expect(isReordered([0, 2, 1, 4, 3])).toBe(true); // what Firefox's H.264 encoder emits
    expect(isReordered([1, 3, 2])).toBe(true);
    expect(isReordered([0, 0])).toBe(true); // a repeated timestamp is not a clean sequence either
    expect(isReordered([])).toBe(false);
  });

  it('picks the H.264 level a picture needs', () => {
    expect(avcLevelFor(640, 360, 25)).toBe(30);
    expect(avcLevelFor(1280, 720, 30)).toBe(31);
    expect(avcLevelFor(1920, 1080, 30)).toBe(40);
    expect(avcLevelFor(1920, 1080, 60)).toBe(42);
    expect(avcLevelFor(3840, 2160, 25)).toBe(51);
    expect(avcLevelFor(3840, 2160, 60)).toBe(52);
  });

  it('builds a Constrained Baseline codec string (no B-frames)', () => {
    expect(avcBaselineCodec(1920, 1080, 25)).toBe('avc1.42E028');
    expect(avcBaselineCodec(3840, 2160, 25)).toBe('avc1.42E033');
    expect(avcBaselineCodec(1240, 820, 25)).toBe('avc1.42E020');
  });
});

import { choosePipeline, readTimestamps, sourceOptions, type PipelineOptions, type PipelineReport } from './encode-order';

describe('measured pipeline choice', () => {
  const good: PipelineReport = { ok: true, reordered: false, offsetFrames: 0, count: 10 };
  const size = { width: 1920, height: 1080, fps: 25 };

  it('reads order, offset and count from file timestamps', () => {
    const t = (frames: number[]) => frames.map((f) => f / 25);
    expect(readTimestamps(t([0, 1, 2, 3]), 25, 4)).toEqual({ ok: true, reordered: false, offsetFrames: 0, count: 4 });
    expect(readTimestamps(t([0, 2, 1, 4, 3]), 25, 5).reordered).toBe(true);
    expect(readTimestamps(t([-1, 0, 1, 2]), 25, 4).offsetFrames).toBe(-1); // what Firefox + Baseline gives through the muxer
    expect(readTimestamps(t([1, 2, 3]), 25, 4)).toMatchObject({ offsetFrames: 1, count: 3 });
    expect(readTimestamps([], 25, 4).ok).toBe(false);
  });

  it('keeps the plain pipeline when it is in order', async () => {
    const pick = await choosePipeline({ codec: 'avc', webm: false }, size, false, async () => good);
    expect(pick).toEqual({ options: { codec: 'avc', webm: false, allKeys: false }, shiftFrames: 0, note: undefined });
  });

  it('switches H.264 to Baseline when the encoder reorders, and compensates an early start', async () => {
    const calls: PipelineOptions[] = [];
    const measure = async (o: PipelineOptions): Promise<PipelineReport> => {
      calls.push(o);
      return o.fullCodecString ? { ok: true, reordered: false, offsetFrames: -1, count: 10 } : { ok: true, reordered: true, offsetFrames: 0, count: 10 };
    };
    const pick = await choosePipeline({ codec: 'avc', webm: false }, size, false, measure);
    expect(pick.options.fullCodecString).toBe('avc1.42E028');
    expect(pick.shiftFrames).toBe(1);
    expect(pick.note).toMatch(/Baseline/);
    expect(calls).toHaveLength(2);
  });

  it('falls back to all key frames, then to a plain warning', async () => {
    const keysOnly = async (o: PipelineOptions): Promise<PipelineReport> => (o.allKeys ? good : { ...good, reordered: true });
    const a = await choosePipeline({ codec: 'avc', webm: false }, size, false, keysOnly, async () => false);
    expect(a.options.allKeys).toBe(true);
    expect(a.note).toMatch(/key frame/);
    const never = async (): Promise<PipelineReport> => ({ ...good, reordered: true });
    const b = await choosePipeline({ codec: 'hevc', webm: false }, size, false, never);
    expect(b.options).toEqual({ codec: 'hevc', webm: false, allKeys: false });
    expect(b.note).toMatch(/VP9 or AV1/);
  });

  it('treats a failed measurement as "leave it alone"', async () => {
    const pick = await choosePipeline({ codec: 'vp9', webm: true }, size, false, async () => ({ ok: false, reordered: false, offsetFrames: 0, count: 0 }));
    expect(pick.shiftFrames).toBe(0);
    expect(pick.note).toBeUndefined();
  });

  it('turns a choice into encoder options', () => {
    expect(sourceOptions({ codec: 'avc', webm: false }, 25)).toEqual({});
    expect(sourceOptions({ codec: 'avc', webm: false, allKeys: true, fullCodecString: 'avc1.42E028' }, 25)).toEqual({ fullCodecString: 'avc1.42E028', keyFrameInterval: 0.02 });
  });
});
