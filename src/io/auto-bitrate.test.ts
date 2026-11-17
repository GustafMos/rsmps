import { describe, expect, it } from 'vitest';
import { bitrateFromSizes, overshoots, probeCodecString } from './auto-bitrate';

describe('auto bitrate: arithmetic', () => {
  it('turns frame sizes into megabits per second: one key frame every two seconds, the rest delta frames, plus head room', () => {
    // 25 fps: 0.5 key frames/s of 1 MB and 24.5 delta frames/s of 100 kB = 2.95 MB/s = 23.6 Mbps, x1.15 = 27.14 -> 27.5
    expect(bitrateFromSizes({ key: [1_000_000], delta: [100_000, 100_000] }, 25, false)).toBe(27.5);
  });
  it('counts every frame as a key frame when asked', () => {
    // 25 x 200 kB = 5 MB/s = 40 Mbps, x1.15 = 46
    expect(bitrateFromSizes({ key: [200_000, 200_000], delta: [] }, 25, true)).toBe(46);
  });
  it('stays inside the range of the Bitrate field', () => {
    expect(bitrateFromSizes({ key: [100], delta: [10] }, 25, false)).toBe(1);
    expect(bitrateFromSizes({ key: [9e7], delta: [9e7] }, 60, false)).toBe(200);
  });
  it('has no answer without a key frame', () => {
    expect(bitrateFromSizes({ key: [], delta: [5] }, 25, false)).toBeNull();
  });
});

describe('auto bitrate: does the encoder keep to its budget', () => {
  const given = 4_000_000; // 20 kB per frame at 25 fps
  it('an encoder whose later frames ignore the budget overshoots (Firefox H.264: 160 kB frames whatever it is given)', () => {
    expect(overshoots({ key: [1_300_000], delta: [146_000, 154_000, 159_000] }, 25, false, given)).toBe(true);
  });
  it('a big opening key frame alone is not overshoot (Chromium: later frames fit the budget)', () => {
    expect(overshoots({ key: [860_000], delta: [18_000, 18_000, 20_000] }, 25, false, given)).toBe(false);
  });
  it('with every frame a key frame the frames after the first are judged', () => {
    expect(overshoots({ key: [900_000, 150_000, 150_000], delta: [] }, 25, true, given)).toBe(true);
    expect(overshoots({ key: [900_000, 20_000, 20_000], delta: [] }, 25, true, given)).toBe(false);
    expect(overshoots({ key: [900_000], delta: [] }, 25, true, given)).toBe(false);
  });
});

describe('auto bitrate: codec strings for the probe', () => {
  it('uses the exact H.264 string of the export when there is one, else High at the level the picture needs', () => {
    expect(probeCodecString('avc', 1920, 1080, 25, 'avc1.42E028')).toBe('avc1.42E028');
    expect(probeCodecString('avc', 1920, 1080, 25)).toBe('avc1.640028');
    expect(probeCodecString('avc', 3840, 2160, 25)).toBe('avc1.640033');
  });
  it('knows the other built-in codecs and nothing else', () => {
    expect(probeCodecString('vp9', 1920, 1080, 25)).toMatch(/^vp09\./);
    expect(probeCodecString('av1', 1920, 1080, 25)).toMatch(/^av01\./);
    expect(probeCodecString('hevc', 1920, 1080, 25)).toMatch(/^hev1\./);
    expect(probeCodecString('vp8', 1920, 1080, 25)).toBeNull();
  });
});
