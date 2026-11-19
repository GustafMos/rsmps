import { describe, expect, it } from 'vitest';
import { fastCopyName, fastCopyPlan } from './fast-copy';

describe('fast copy', () => {
  it('scales down to the longest side, never up, with even numbers', () => {
    expect(fastCopyPlan({ width: 3840, height: 2160, fps: 25 }, 1280)).toMatchObject({ width: 1280, height: 720 });
    expect(fastCopyPlan({ width: 1080, height: 1920, fps: 30 }, 1280)).toMatchObject({ width: 720, height: 1280 });
    expect(fastCopyPlan({ width: 640, height: 360, fps: 30 }, 1920)).toMatchObject({ width: 640, height: 360 });
    const odd = fastCopyPlan({ width: 1001, height: 563, fps: 30 }, 500);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });
  it('gives key-frame-only pictures enough bits, within limits', () => {
    const hd = fastCopyPlan({ width: 1920, height: 1080, fps: 25 }, 1280);
    expect(hd.bitrate).toBeGreaterThan(6e6);
    expect(hd.bitrate).toBeLessThan(12e6);
    expect(fastCopyPlan({ width: 160, height: 90, fps: 12 }, 1280).bitrate).toBe(4e6);
    expect(fastCopyPlan({ width: 3840, height: 2160, fps: 60 }, 3840).bitrate).toBe(60e6);
    expect(fastCopyPlan({ width: 1280, height: 720, fps: 0 }, 1280).bitrate).toBeGreaterThan(4e6);
  });
  it('names the copy after the clip, once', () => {
    expect(fastCopyName('A001 clip.mov', 'mp4')).toBe('A001 clip fast.mp4');
    expect(fastCopyName('A001 clip fast.mp4', 'mp4')).toBe('A001 clip fast.mp4');
    expect(fastCopyName('noext', 'webm')).toBe('noext fast.webm');
  });
});
