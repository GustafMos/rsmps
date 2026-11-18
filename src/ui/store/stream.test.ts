// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamApi } from '../../io/api';
import { DEFAULT_STREAM_SETTINGS, StreamController, fitInside, loadStreamSettings, qualityOf, recorderType, saveStreamSettings, streamClock, type StreamEnv, type StreamSettings } from './stream';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
};

describe('stream settings', () => {
  it('the stream key is stored only with "remember"', () => {
    const store = memory();
    saveStreamSettings({ ...DEFAULT_STREAM_SETTINGS, key: 'live_secret_key', quality: '1080p60', kbps: 6000 }, store);
    expect([...store.raw.values()].join('')).not.toContain('live_secret_key');
    expect(loadStreamSettings(store)).toMatchObject({ key: '', quality: '1080p60', kbps: 6000, remember: false });
    saveStreamSettings({ ...DEFAULT_STREAM_SETTINGS, key: 'live_secret_key', remember: true }, store);
    expect(loadStreamSettings(store)).toMatchObject({ key: 'live_secret_key', remember: true });
  });
  it('damaged or missing settings fall back to the defaults', () => {
    expect(loadStreamSettings(memory())).toEqual(DEFAULT_STREAM_SETTINGS);
    const store = memory();
    store.setItem('rsmps.stream.settings', '{"service":"x","quality":"8k","kbps":-5,"key":"k","remember":"yes"}');
    expect(loadStreamSettings(store)).toEqual(DEFAULT_STREAM_SETTINGS);
    store.setItem('rsmps.stream.settings', 'not json');
    expect(loadStreamSettings(store)).toEqual(DEFAULT_STREAM_SETTINGS);
  });
  it('helpers: quality, clock, fitting a picture into the stream frame, recorder format', () => {
    expect(qualityOf('1080p30')).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(qualityOf('nope').id).toBe('720p30');
    expect([streamClock(0), streamClock(65), streamClock(3725)]).toEqual(['0:00', '1:05', '1:02:05']);
    expect(fitInside(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(fitInside(1080, 1920, 1280, 720)).toEqual({ x: 438, y: 0, w: 405, h: 720 }); // a vertical picture: bars left and right
    expect(fitInside(0, 0, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(recorderType((t) => t.includes('vp8'))).toBe('video/webm;codecs=vp8,opus');
    expect(recorderType((t) => t.includes('avc1'))).toBe('video/x-matroska;codecs=avc1,opus');
    expect(recorderType(() => false)).toBeNull();
  });
});

/* ---- the controller, with stand-ins for the browser and the main process ---- */
class FakeRecorder {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public options: MediaRecorderOptions) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
}
function setup(opts: { audio?: boolean; startError?: string; canvas?: boolean; type?: boolean } = {}) {
  const sent: string[] = [];
  const toasts: string[] = [];
  const recorders: FakeRecorder[] = [];
  const stopped: string[] = [];
  let chunkError: string | null = null;
  let status: { current: unknown; last: unknown } = { current: { id: 'S1', live: true, seconds: 12, wallSeconds: 12, fps: 30, kbps: 2900, speed: 1, error: null }, last: null };
  const api: StreamApi = {
    supported: true,
    info: async () => ({ available: true, services: [], ...(status as { current: null; last: null }) }),
    start: vi.fn(async () => {
      if (opts.startError) throw new Error(opts.startError);
      return { id: 'S1', encoder: 'libx264', secure: true };
    }),
    chunk: async (_id, bytes) => {
      if (chunkError) throw new Error(chunkError);
      await new Promise((r) => setTimeout(r, 2));
      sent.push(new TextDecoder().decode(bytes as ArrayBuffer));
    },
    stop: async (id) => {
      stopped.push(String(id));
      return { available: true, services: [], current: null, last: null };
    },
    audioStream: () => (opts.audio === false ? null : ({ getAudioTracks: () => [{ kind: 'audio', stop: () => stopped.push('AUDIO TRACK STOPPED') }] } as unknown as MediaStream)),
  };
  const timers: (() => void)[] = [];
  const videoTrack = { kind: 'video', stop: vi.fn() };
  const env: StreamEnv = {
    findCanvas: () => (opts.canvas === false ? null : ({ width: 640, height: 360 } as HTMLCanvasElement)),
    createStage: () => ({ canvas: {} as HTMLCanvasElement, attach: () => undefined, draw: () => undefined, dispose: () => stopped.push('STAGE DISPOSED') }),
    capture: () => ({ getVideoTracks: () => [videoTrack] }) as unknown as MediaStream,
    recorder: (_s, options) => {
      const r = new FakeRecorder(options);
      recorders.push(r);
      return r as unknown as MediaRecorder;
    },
    isTypeSupported: (t) => opts.type !== false && t.includes('vp8'),
    mediaStream: (tracks) => ({ tracks }) as unknown as MediaStream,
    every: (_ms, fn) => {
      timers.push(fn);
      return () => void timers.splice(timers.indexOf(fn), 1);
    },
  };
  const ctl = new StreamController(api, (m) => toasts.push(m), env);
  return { ctl, api, sent, toasts, recorders, stopped, timers, videoTrack, failChunks: (m: string) => (chunkError = m), setStatus: (s: typeof status) => (status = s) };
}
const SETTINGS: StreamSettings = { ...DEFAULT_STREAM_SETTINGS, key: ' live_key_12345 ' };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('going live', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  });
  it('starts FFmpeg with the settings, then sends the recorded pieces in order', async () => {
    const t = setup();
    expect(await t.ctl.start(SETTINGS)).toBe(true);
    expect(t.api.start).toHaveBeenCalledWith({ service: 'twitch', key: 'live_key_12345', url: '', width: 1280, height: 720, fps: 30, videoKbps: 3000, hasAudio: true });
    expect(t.ctl.store.get()).toMatchObject({ phase: 'live', service: 'twitch', error: null });
    expect(t.recorders[0].options.mimeType).toBe('video/webm;codecs=vp8,opus');
    for (const p of ['a', 'b', 'c', 'd']) t.recorders[0].emit(p);
    await tick(40);
    expect(t.sent).toEqual(['a', 'b', 'c', 'd']);
    await Promise.all(t.timers.map((fn) => fn())); // the status poll
    await tick();
    expect(t.ctl.store.get()).toMatchObject({ seconds: 12, kbps: 2900, fps: 30 });
  });
  it('End stream flushes what is recorded, stops FFmpeg and releases only the picture capture', async () => {
    const t = setup();
    await t.ctl.start(SETTINGS);
    t.recorders[0].emit('last');
    await t.ctl.stop();
    expect(t.sent).toEqual(['last']);
    expect(t.stopped).toEqual(['S1', 'STAGE DISPOSED']); // and never 'AUDIO TRACK STOPPED': the sound stream belongs to the audio engine
    expect(t.videoTrack.stop).toHaveBeenCalled();
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', error: null });
    expect(t.timers).toHaveLength(0);
    expect(t.toasts.at(-1)).toMatch(/ended/);
    expect(await t.ctl.start(SETTINGS)).toBe(true); // and it can go live again
  });
  it('says why it cannot start: no picture, no recorder, a refused key', async () => {
    const noCanvas = setup({ canvas: false });
    expect(await noCanvas.ctl.start(SETTINGS)).toBe(false);
    expect(noCanvas.ctl.store.get()).toMatchObject({ phase: 'idle' });
    expect(noCanvas.ctl.store.get().error).toMatch(/no picture/);
    expect(noCanvas.api.start).not.toHaveBeenCalled();
    expect((await setup({ type: false }).ctl.start(SETTINGS))).toBe(false);
    const refused = setup({ startError: 'Paste your Twitch stream key (from the Twitch creator dashboard).' });
    expect(await refused.ctl.start(SETTINGS)).toBe(false);
    expect(refused.ctl.store.get().error).toMatch(/stream key/);
    expect(refused.recorders).toHaveLength(0);
    expect(refused.videoTrack.stop).toHaveBeenCalled();
  });
  it('without sound it still goes live and says so', async () => {
    const t = setup({ audio: false });
    expect(await t.ctl.start(SETTINGS)).toBe(true);
    expect(t.api.start).toHaveBeenCalledWith(expect.objectContaining({ hasAudio: false }));
    expect(t.toasts.join(' ')).toMatch(/without sound/);
  });
  it('when FFmpeg or the connection dies the stream ends with the reason', async () => {
    const t = setup();
    await t.ctl.start(SETTINGS);
    t.failChunks('The streaming server closed the connection. The stream key may be wrong or expired, or another stream is already live on it.');
    t.recorders[0].emit('x');
    await tick(60);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle' });
    expect(t.ctl.store.get().error).toMatch(/stream key may be wrong/);
    expect(t.toasts.at(-1)).toMatch(/stream stopped/);
    // and when the status says the stream is gone
    const u = setup();
    await u.ctl.start(SETTINGS);
    u.setStatus({ current: null, last: { id: 'S1', live: false, seconds: 3, wallSeconds: 3, fps: 0, kbps: 0, speed: 0, error: 'Could not reach the streaming server. Check the internet connection and the address.' } });
    await Promise.all(u.timers.map((fn) => fn()));
    await tick(60);
    expect(u.ctl.store.get().error).toMatch(/reach the streaming server/);
  });
});
