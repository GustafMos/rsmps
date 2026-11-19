// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../../io/api';
import type { LiveRecorder } from '../../io/live-record';
import type { Editor } from './editor';
import { RecorderController, recordLabel, recorderSettings, type RecorderEnv } from './recorder';

describe('Recorder settings and button', () => {
  it('reads the node settings with defaults', () => {
    expect(recorderSettings({})).toEqual({ time: 'run', sound: true, download: true, maxSide: 1920 });
    expect(recorderSettings({ time: 'loop', sound: false, download: false, size: '1280' })).toEqual({ time: 'loop', sound: false, download: false, maxSide: 1280 });
    expect(recorderSettings({ time: 'x', size: '99999' })).toEqual({ time: 'run', sound: true, download: true, maxSide: 1920 });
  });
  it('the button shows the running time only on the node that records', () => {
    const rec = { phase: 'recording' as const, nodeId: 'a', seconds: 75, lastName: null };
    expect(recordLabel(rec, true)).toBe('Stop 1:15');
    expect(recordLabel(rec, false)).toBe('Record');
    expect(recordLabel({ phase: 'saving', nodeId: 'a', seconds: 0, lastName: null }, true)).toBe('Saving');
    expect(recordLabel({ phase: 'idle', nodeId: null, seconds: 0, lastName: null }, false)).toBe('Record');
  });
});

function setup(opts: { audio?: boolean; canvas?: boolean; startError?: string; cameraBusy?: boolean } = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const added: File[] = [];
  let started: { fps: number; label?: string; maxSide?: number; audio?: () => MediaStreamTrack | null } | null = null;
  const rec = {
    state: 'idle',
    elapsed: 3,
    onAutoStop: null as ((reason: 'limit' | 'error', error?: Error) => void) | null,
    start: (_get: () => unknown, o: typeof started) => {
      if (opts.startError) throw new Error(opts.startError);
      started = o;
      log.push('rec.start');
    },
    stop: async () => {
      log.push('rec.stop');
      return { hasAudio: opts.audio !== false, blob: new Blob(['clip'], { type: 'video/mp4' }), name: 'Recorder take 2026-11-18 12.00.00.mp4', frames: 90, seconds: 3, width: 1280, height: 720 };
    },
  };
  const ed = {
    state: { graph: { project: { fps: 30 } } },
    setViewed: (id: string) => log.push(`view ${id}`),
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor;
  const io = {
    liveRecorder: { state: opts.cameraBusy ? 'recording' : 'idle' },
    stream: { audioStream: () => (opts.audio === false ? null : { getAudioTracks: () => [{ kind: 'audio' }] }) },
    player: { setRunOn: (on: boolean) => log.push(`runOn ${on}`), seek: (s: number) => log.push(`seek ${s}`), play: () => log.push('play'), pause: () => log.push('pause') },
    library: { add: async (files: File[]) => (added.push(...files), files.map((f) => ({ id: 'asset', name: f.name }))) },
  } as unknown as Io;
  const timers: (() => void)[] = [];
  const env: RecorderEnv = {
    findCanvas: () => (opts.canvas === false ? null : ({ width: 640, height: 360 } as HTMLCanvasElement)),
    follow: () => ({ picture: () => null, dispose: () => log.push('dispose') }),
    every: (_ms, fn) => {
      timers.push(fn);
      return () => void timers.splice(timers.indexOf(fn), 1);
    },
    saveFile: (f) => log.push(`file ${f.name}`),
  };
  const ctl = new RecorderController(ed, io, env, rec as unknown as LiveRecorder);
  return { ctl, log, toasts, added, timers, rec, started: () => started };
}
const RUN = { time: 'run' as const, sound: true, download: true, maxSide: 1920 };
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('recording a Recorder node', () => {
  beforeEach(() => vi.stubGlobal('File', class { constructor(public parts: unknown[], public name: string, public opts: { type: string }) {} }));
  it('Record shows the node, lets time run on from the start and records picture and sound; Stop saves the clip to Media', async () => {
    const t = setup();
    t.ctl.toggle('rec1', RUN);
    expect(t.log).toEqual(['view rec1', 'rec.start', 'runOn true', 'seek 0', 'play']);
    expect(t.started()).toMatchObject({ fps: 30, label: 'Recorder', maxSide: 1920 });
    expect(t.started()!.audio!()).toEqual({ kind: 'audio' });
    expect(t.ctl.store.get()).toMatchObject({ phase: 'recording', nodeId: 'rec1' });
    t.timers.forEach((fn) => fn());
    expect(t.ctl.store.get().seconds).toBe(3);
    t.ctl.toggle('rec1', RUN);
    await settle();
    expect(t.log.slice(5)).toEqual(['pause', 'runOn false', 'rec.stop', 'file Recorder take 2026-11-18 12.00.00.mp4', 'dispose']);
    expect(t.added.map((f) => f.name)).toEqual(['Recorder take 2026-11-18 12.00.00.mp4']);
    expect(t.toasts.at(-1)).toMatch(/Saved to your downloads and to Media.*0:03, with sound/);
    expect(t.ctl.store.get()).toEqual({ phase: 'idle', nodeId: null, seconds: 0, lastName: 'Recorder take 2026-11-18 12.00.00.mp4' });
    t.ctl.saveLast();
    expect(t.log.at(-1)).toBe('file Recorder take 2026-11-18 12.00.00.mp4');
    expect(t.timers).toHaveLength(0);
  });
  it('"Loop the project" leaves the clock alone; "Record sound" off records the picture only', async () => {
    const t = setup();
    t.ctl.toggle('rec1', { time: 'loop', sound: false, download: false, maxSide: 1280 });
    expect(t.log).toEqual(['view rec1', 'rec.start', 'seek 0', 'play']);
    expect(t.started()!.audio).toBeUndefined();
    expect(t.started()!.maxSide).toBe(1280);
    await t.ctl.stop();
    expect(t.log).not.toContain('runOn false');
    expect(t.log.some((l) => l.startsWith('file '))).toBe(false); // Save as a file is off
    expect(t.toasts.at(-1)).toMatch(/^Saved to Media/);
  });
  it('one recording at a time, and it says what is in the way', async () => {
    const t = setup();
    t.ctl.toggle('rec1', RUN);
    t.ctl.toggle('rec2', RUN);
    expect(t.toasts.at(-1)).toMatch(/Another Recorder/);
    expect(t.ctl.store.get().nodeId).toBe('rec1');
    const busy = setup({ cameraBusy: true });
    busy.ctl.toggle('rec1', RUN);
    expect(busy.toasts.at(-1)).toMatch(/camera recording/);
    expect(busy.log).toEqual([]);
    const noViewer = setup({ canvas: false });
    noViewer.ctl.toggle('rec1', RUN);
    expect(noViewer.ctl.store.get().phase).toBe('idle');
    const broken = setup({ startError: 'This browser cannot record video (it has no WebCodecs video encoder).' });
    broken.ctl.toggle('rec1', RUN);
    expect(broken.toasts.at(-1)).toMatch(/cannot record video/);
    expect(broken.log).toEqual(['view rec1', 'dispose']);
    expect(broken.ctl.store.get().phase).toBe('idle');
  });
  it('without sound running it records the picture and says so; a limit ends and saves it by itself', async () => {
    const t = setup({ audio: false });
    t.ctl.toggle('rec1', RUN);
    expect(t.toasts.at(-1)).toMatch(/without sound/);
    t.rec.onAutoStop!('limit');
    await settle();
    expect(t.added).toHaveLength(1);
    expect(t.toasts.at(-1)).toMatch(/reached its limit/);
    expect(t.ctl.store.get().phase).toBe('idle');
  });
});
