import { describe, expect, it } from 'vitest';
import type { AssetInfo, LiveSource } from '../engine/types';
import { liveOrientOfNode, liveSourceOfNode, liveTakeLabel } from '../engine/lib/live-source';
import { sourceKey } from './live';
import {
  LiveRecordController,
  MAX_BYTES,
  MAX_SECONDS,
  clampFps,
  containRect,
  formatElapsed,
  frameIndexAt,
  limitReached,
  recordBitrate,
  recordSize,
  sourceSize,
  takeFileName,
  type LiveRecorder,
  type LiveRecording,
} from './live-record';
import type { LiveRecordFinish } from './api';

describe('live recording helpers', () => {
  it('keeps the size, rounded down to even', () => {
    expect(recordSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(recordSize(1281, 721)).toEqual({ width: 1280, height: 720 });
    expect(recordSize(641, 480)).toEqual({ width: 640, height: 480 });
    expect(recordSize(3, 3)).toEqual({ width: 2, height: 2 });
    expect(recordSize(1, 1)).toEqual({ width: 2, height: 2 }); // never 0
  });
  it('caps the long side at 1920 and keeps the aspect', () => {
    expect(recordSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(recordSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
    expect(recordSize(4000, 3000)).toEqual({ width: 1920, height: 1440 });
    expect(recordSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    const odd = recordSize(2561, 1441);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
    expect(odd.width).toBeLessThanOrEqual(1920);
  });
  it('maps elapsed time to a frame index, so late ticks keep real time', () => {
    expect(frameIndexAt(0, 30)).toBe(0);
    expect(frameIndexAt(1 / 30, 30)).toBe(1);
    expect(frameIndexAt(0.049, 30)).toBe(1); // a late tick still lands on its nearest frame
    expect(frameIndexAt(0.051, 30)).toBe(2);
    expect(frameIndexAt(10, 24)).toBe(240);
    expect(frameIndexAt(-0.01, 30)).toBe(0);
    // two ticks 5 ms apart share a frame: the recorder skips the second
    expect(frameIndexAt(1.0, 30)).toBe(frameIndexAt(1.005, 30));
  });
  it('picks a bitrate from the size, between 2 and 20 Mbps', () => {
    expect(recordBitrate(320, 240, 15)).toBe(2_000_000);
    expect(recordBitrate(1280, 720, 30)).toBe(Math.round(0.12 * 1280 * 720 * 30));
    expect(recordBitrate(1920, 1080, 60)).toBe(14_929_920);
    expect(recordBitrate(1920, 1920, 60)).toBe(20_000_000);
  });
  it('keeps the frame rate between 5 and 60', () => {
    expect(clampFps(1)).toBe(5);
    expect(clampFps(24)).toBe(24);
    expect(clampFps(120)).toBe(60);
    expect(clampFps(NaN)).toBe(30);
  });
  it('ends at 30 minutes or 1.5 GB, whichever comes first', () => {
    expect(limitReached(10, 1000)).toBe(false);
    expect(limitReached(MAX_SECONDS, 0)).toBe(true);
    expect(limitReached(5, MAX_BYTES)).toBe(true);
    expect(MAX_SECONDS).toBe(1800);
  });
  it('reads the size of whatever holds the picture', () => {
    expect(sourceSize({ videoWidth: 640, videoHeight: 360, width: 0, height: 0 })).toEqual({ width: 640, height: 360 });
    expect(sourceSize({ naturalWidth: 800, naturalHeight: 600, width: 10, height: 10 })).toEqual({ width: 800, height: 600 });
    expect(sourceSize({ displayWidth: 320, displayHeight: 200 })).toEqual({ width: 320, height: 200 });
    expect(sourceSize({ width: 64, height: 32 })).toEqual({ width: 64, height: 32 });
    expect(sourceSize({ videoWidth: 0, videoHeight: 0 })).toEqual({ width: 0, height: 0 });
    expect(sourceSize(null)).toEqual({ width: 0, height: 0 });
  });
  it('names a take with the local date and time', () => {
    expect(takeFileName('Phone', new Date(2026, 10, 17, 18, 42, 5), 'mp4')).toBe('Phone take 2026-11-17 18.42.05.mp4');
    expect(takeFileName('Webcam', new Date(2027, 0, 3, 7, 4, 9), 'webm')).toBe('Webcam take 2027-01-03 07.04.09.webm');
  });
  it('formats the running time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(12.9)).toBe('0:12');
    expect(formatElapsed(725)).toBe('12:05');
  });
  it('fits a picture inside the clip', () => {
    expect(containRect(1280, 720, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(containRect(720, 1280, 1280, 720)).toEqual({ x: 437.5, y: 0, w: 405, h: 720 });
  });
});

describe('node params to live source', () => {
  it('gives the recorder the same stream the node renders', () => {
    const cam = liveSourceOfNode('camera-in', { device: 'd1', resolution: '1280x720', freeze: true, mirror: true })!;
    expect(cam).toEqual({ kind: 'camera', deviceId: 'd1', width: 1280, height: 720, freeze: true });
    expect(sourceKey(cam)).toBe(sourceKey({ kind: 'camera', deviceId: 'd1', width: 1280, height: 720 }));
    expect(liveSourceOfNode('camera-in', { device: '', resolution: 'auto' })).toEqual({ kind: 'camera', deviceId: '', freeze: false });
    expect(liveSourceOfNode('url-in', { url: '  http://a/b.mp4 ', kind: 'auto', refresh: 2 })).toEqual({ kind: 'url', url: 'http://a/b.mp4', mode: 'auto', refresh: 2 });
    expect(liveSourceOfNode('url-in', { url: '  ' })).toBeNull();
    expect(liveSourceOfNode('phone-camera', { session: 'abc', freeze: false })).toEqual({ kind: 'phone', session: 'abc', freeze: false });
    expect(liveSourceOfNode('phone-camera', { session: '' })).toBeNull();
    expect(liveSourceOfNode('blur', {})).toBeNull();
  });
  it('reads how the node shows the picture', () => {
    expect(liveOrientOfNode('camera-in', { mirror: true })).toEqual({ mirror: true, turns: 0 });
    expect(liveOrientOfNode('phone-camera', { mirror: false, rotate: '270' })).toEqual({ mirror: false, turns: 3 });
    expect(liveOrientOfNode('phone-camera', { rotate: 'auto' })).toEqual({ mirror: false, turns: 0 });
    expect(liveOrientOfNode('url-in', { mirror: true })).toEqual({ mirror: false, turns: 0 });
    expect([liveTakeLabel('camera-in'), liveTakeLabel('phone-camera'), liveTakeLabel('url-in')]).toEqual(['Webcam', 'Phone', 'Stream']);
  });
});

/** A recorder that encodes nothing: the controller's bookkeeping is what is under test. */
function fakeRecorder(take: () => Promise<LiveRecording>) {
  const listeners = new Set<() => void>();
  const r = {
    state: 'idle' as 'idle' | 'recording' | 'saving',
    elapsed: 0,
    frames: 0,
    onAutoStop: null as LiveRecorder['onAutoStop'],
    getSource: null as (() => CanvasImageSource | null) | null,
    cancelled: 0,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start(getSource: () => CanvasImageSource | null) {
      if (r.state !== 'idle') throw new Error('A recording is already running.');
      r.getSource = getSource;
      r.state = 'recording';
    },
    async stop() {
      r.state = 'saving';
      try {
        return await take();
      } finally {
        r.state = 'idle';
        listeners.forEach((l) => l());
      }
    },
    async cancel() {
      r.cancelled++;
      r.state = 'idle';
    },
  };
  return r;
}

const TAKE: LiveRecording = { blob: new Blob(['x'], { type: 'video/mp4' }), name: 'Stream take 2026-11-17 18.42.05.mp4', frames: 30, seconds: 1, width: 640, height: 360 };
const SRC: LiveSource = { kind: 'url', url: 'http://a/b.mp4' };

function setup(take: () => Promise<LiveRecording> = async () => TAKE) {
  const rec = fakeRecorder(take);
  const added: File[] = [];
  const drawn: LiveSource[] = [];
  const picture = { width: 2, height: 2 } as unknown as CanvasImageSource;
  const ctl = new LiveRecordController({
    recorder: rec as unknown as LiveRecorder,
    live: { drawable: (s) => (drawn.push(s), picture), hasPicture: () => true },
    add: async (files) => {
      added.push(...files);
      return files.map((f, i) => ({ id: `a${i}`, name: f.name, kind: 'video' }) as AssetInfo);
    },
  });
  const finishes: LiveRecordFinish[] = [];
  ctl.onFinished((f) => finishes.push(f));
  return { rec, ctl, added, drawn, finishes, picture };
}

describe('live record controller', () => {
  it('records one node at a time and imports the clip as a file', async () => {
    const { ctl, added, finishes, rec, drawn, picture } = setup();
    ctl.start({ nodeId: 'n1', source: () => SRC, fps: 30, label: 'Stream' });
    expect(ctl.state).toBe('recording');
    expect(ctl.nodeId).toBe('n1');
    expect(() => ctl.start({ nodeId: 'n2', source: () => SRC, fps: 30, label: 'Stream' })).toThrow(/already running/);
    expect(rec.getSource!()).toBe(picture);
    expect(drawn).toEqual([SRC]);
    const res = await ctl.stop();
    expect(res?.name).toBe(TAKE.name);
    expect(res?.seconds).toBe(1);
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe(TAKE.name);
    expect(added[0].type).toBe('video/mp4');
    expect(finishes).toHaveLength(1);
    expect(finishes[0].reason).toBe('stop');
    expect(finishes[0].nodeId).toBe('n1');
    expect(ctl.state).toBe('idle');
    expect(ctl.nodeId).toBeNull();
    expect(await ctl.stop()).toBeNull(); // nothing running
    expect(finishes).toHaveLength(1);
  });
  it('skips frames while the node has no source, and stops and saves when the node is gone', async () => {
    const { ctl, rec, finishes, added } = setup();
    let source: LiveSource | null | 'gone' = null;
    ctl.start({ nodeId: 'n1', source: () => source, fps: 30, label: 'Stream' });
    expect(rec.getSource!()).toBeNull();
    expect(ctl.state).toBe('recording');
    source = 'gone';
    expect(rec.getSource!()).toBeNull();
    expect(ctl.state).toBe('saving');
    await ctl.finish('stop'); // the same save, not a second one
    expect(finishes.map((f) => f.reason)).toEqual(['gone']);
    expect(added).toHaveLength(1);
  });
  it('saves when the recorder stops itself at the limit', async () => {
    const { ctl, rec, finishes } = setup();
    ctl.start({ nodeId: 'n1', source: () => SRC, fps: 30, label: 'Stream' });
    rec.onAutoStop!('limit');
    await ctl.finish('stop');
    expect(finishes.map((f) => f.reason)).toEqual(['limit']);
    expect(finishes[0].result?.name).toBe(TAKE.name);
  });
  it('reports a recording that could not be saved and is ready for the next one', async () => {
    const { ctl, finishes, added } = setup(async () => {
      throw new Error('Nothing was recorded: no picture arrived.');
    });
    ctl.start({ nodeId: 'n1', source: () => SRC, fps: 30, label: 'Stream' });
    expect(await ctl.stop()).toBeNull();
    expect(finishes[0].result).toBeNull();
    expect(finishes[0].error).toMatch(/no picture arrived/);
    expect(added).toHaveLength(0);
    expect(ctl.state).toBe('idle');
    ctl.start({ nodeId: 'n2', source: () => SRC, fps: 30, label: 'Stream' });
    await ctl.cancel();
    expect(ctl.state).toBe('idle');
    expect(ctl.nodeId).toBeNull();
  });
});
