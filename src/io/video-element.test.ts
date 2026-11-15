import { describe, expect, it } from 'vitest';
import { DRIFT_KEEP, codecLabel, decidePlayback, ffmpegCommand, seekTarget, snapTime, unsupportedMessage, type PlaybackInput } from './video-element';

const base: PlaybackInput = { playing: false, currentTime: 0, t: 0, now: 1000, lastReqT: null, lastReqWall: null, exact: false };

describe('time snapping', () => {
  it('snaps to the start of the frame on the grid', () => {
    expect(snapTime(0, 30)).toBe(0);
    expect(snapTime(1 / 30 + 1e-9, 30)).toBeCloseTo(1 / 30);
    expect(snapTime(0.0499, 30)).toBeCloseTo(1 / 30);
    expect(snapTime(1.0, 24)).toBe(1);
    expect(snapTime(-1, 24)).toBe(0);
    expect(snapTime(5, 0)).toBe(5); // unknown fps falls back to 24
  });
  it('seeks a quarter frame into the frame and stays inside the clip', () => {
    expect(seekTarget(1, 20, 10)).toBeCloseTo(1.0125);
    expect(seekTarget(9.99, 20, 10)).toBeLessThan(10);
  });
});

describe('decidePlayback', () => {
  it('always seeks when exporting, never plays', () => {
    const d = decidePlayback({ ...base, exact: true, playing: true, lastReqT: 1, lastReqWall: 990, t: 1.03, now: 1000 });
    expect(d).toEqual({ seek: true, play: false, rate: 1 });
  });
  it('the first request and scrubbing seek without playing', () => {
    expect(decidePlayback(base).play).toBe(false);
    // user steps one frame, but a second later: not real-time playback
    expect(decidePlayback({ ...base, lastReqT: 1, lastReqWall: 0, t: 1.04, now: 1000 }).play).toBe(false);
    // backwards
    expect(decidePlayback({ ...base, lastReqT: 2, lastReqWall: 900, t: 1.5, now: 1000 }).play).toBe(false);
    // a jump far ahead (loop wrap or seek)
    expect(decidePlayback({ ...base, lastReqT: 1, lastReqWall: 900, t: 5, now: 1000 }).play).toBe(false);
  });
  it('starts playing when requests advance in real time, at the measured rate', () => {
    const d = decidePlayback({ ...base, lastReqT: 1, lastReqWall: 960, t: 1.04, now: 1000, currentTime: 1.0 });
    expect(d.play).toBe(true);
    expect(d.rate).toBeCloseTo(1, 1);
    expect(d.seek).toBe(false); // already within the keep window
    // frame-rate reinterpretation: the clip advances at double speed
    expect(decidePlayback({ ...base, lastReqT: 1, lastReqWall: 960, t: 1.08, now: 1000, currentTime: 1.04 }).rate).toBeCloseTo(2, 1);
  });
  it('keeps playing, nudges the rate for small drift and seeks for large drift', () => {
    const step = { ...base, playing: true, lastReqT: 1, lastReqWall: 960, t: 1.04, now: 1000 };
    expect(decidePlayback({ ...step, currentTime: 1.04 })).toMatchObject({ seek: false, play: true, rate: expect.closeTo(1, 1) });
    const behind = decidePlayback({ ...step, currentTime: 1.04 - (DRIFT_KEEP + 0.1) });
    expect(behind.seek).toBe(false);
    expect(behind.rate).toBeGreaterThan(1);
    const ahead = decidePlayback({ ...step, currentTime: 1.04 + (DRIFT_KEEP + 0.1) });
    expect(ahead.rate).toBeLessThan(1);
    expect(decidePlayback({ ...step, currentTime: 3 })).toMatchObject({ seek: true, play: true });
  });
  it('a stalled request stream stops playback logic (seek, no play)', () => {
    expect(decidePlayback({ ...base, playing: true, lastReqT: 1, lastReqWall: 100, t: 1.04, now: 1000, currentTime: 1.2 }).play).toBe(false);
  });
});

describe('codec description and help', () => {
  it('names the codec and bit depth', () => {
    expect(codecLabel('hevc', 'hvc1.2.4.L153.B0')).toBe('HEVC (H.265) 10-bit');
    expect(codecLabel('hevc', 'hev1.1.6.L93.B0')).toBe('HEVC (H.265)');
    expect(codecLabel('vp9', 'vp09.02.10.10')).toBe('VP9 10-bit');
    expect(codecLabel('av1', 'av01.0.08M.10')).toBe('AV1 10-bit');
    expect(codecLabel('avc', 'avc1.640028')).toBe('H.264 (AVC)');
    expect(codecLabel(null)).toBe('an unknown video codec');
  });
  it('gives a copyable ffmpeg command and a useful message', () => {
    expect(ffmpegCommand('20260630_234222.mp4')).toBe('ffmpeg -i "20260630_234222.mp4" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac "20260630_234222-h264.mp4"');
    const msg = unsupportedMessage('clip.mov', 'HEVC (H.265) 10-bit');
    expect(msg).toMatch(/HEVC \(H\.265\) 10-bit video, which this browser cannot play/);
    expect(msg).toMatch(/Chrome or Edge/);
    expect(msg).toMatch(/ffmpeg -i "clip\.mov"/);
  });
});
