// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphDoc } from '../../engine/types';
import type { ExportRequest, Io } from '../../io/api';
import type { LiveRecorder } from '../../io/live-record';
import type { Editor } from './editor';
import { RecorderController, formatRemaining, recordLabel, recorderSettings, remainingSeconds, takeOutputParams, type RecorderEnv, type RecorderSettings } from './recorder';

describe('Recorder settings and button', () => {
  it('reads the node settings with defaults', () => {
    expect(recorderSettings({}, false)).toEqual({ time: 'run', sound: true, download: true, maxSide: 1920, quality: 'seen', keepRaw: true });
    expect(recorderSettings({ time: 'loop', sound: false, download: false, size: '1280', keepRaw: false }, false)).toEqual({ time: 'loop', sound: false, download: false, maxSide: 1280, quality: 'seen', keepRaw: false });
    expect(recorderSettings({ time: 'x', size: '99999' }, false)).toEqual({ time: 'run', sound: true, download: true, maxSide: 1920, quality: 'seen', keepRaw: true });
  });
  it('"Automatic" quality is the smooth way on a phone or tablet and the instant way on a computer; a choice is kept anywhere', () => {
    expect(recorderSettings({}, true).quality).toBe('smooth');
    expect(recorderSettings({ quality: 'auto' }, true).quality).toBe('smooth');
    expect(recorderSettings({ quality: 'auto' }, false).quality).toBe('seen');
    expect(recorderSettings({ quality: 'seen' }, true).quality).toBe('seen');
    expect(recorderSettings({ quality: 'smooth' }, false).quality).toBe('smooth');
  });
  it('the button shows how far the rendering is, and the time left is said in round words', () => {
    expect(recordLabel({ phase: 'rendering', nodeId: 'a', seconds: 0, progress: 0.42 }, true)).toBe('Rendering 42%');
    expect(recordLabel({ phase: 'rendering', nodeId: 'a', seconds: 0, progress: 0.42 }, false)).toBe('Record');
    expect(remainingSeconds(1, 0.5)).toBeNull(); // too early to say
    expect(remainingSeconds(30, 0.25)).toBe(90);
    expect(formatRemaining(null)).toBe('');
    expect(formatRemaining(42)).toBe('about 45 s left');
    expect(formatRemaining(200)).toBe('about 3 min left');
  });
  it('a take is rendered in the frame of the active Output, as H.264, no larger than the clip size', () => {
    expect(takeOutputParams(null, { width: 1280, height: 720 }, 1920)).toMatchObject({ kind: 'video', codec: 'avc', scale: 1 });
    expect(takeOutputParams(null, { width: 1280, height: 720 }, 1920).frame).toBeUndefined(); // the project frame as it is
    expect(takeOutputParams(null, { width: 3840, height: 2160 }, 1920)).toMatchObject({ frame: 'custom', frameWidth: 1920, frameHeight: 1080 });
    expect(takeOutputParams({ frame: 'custom', frameWidth: 1080, frameHeight: 1920, pixelSize: 4, codec: 'prores', kind: 'sequence', name: 'x' }, { width: 1280, height: 720 }, 1280)).toMatchObject({ frame: 'custom', frameWidth: 720, frameHeight: 1280, pixelSize: 4, codec: 'avc', kind: 'video' });
  });
  it('the button shows the running time only on the node that records', () => {
    const rec = { phase: 'recording' as const, nodeId: 'a', seconds: 75, lastName: null };
    expect(recordLabel(rec, true)).toBe('Stop 1:15');
    expect(recordLabel(rec, false)).toBe('Record');
    expect(recordLabel({ phase: 'saving', nodeId: 'a', seconds: 0, lastName: null }, true)).toBe('Saving');
    expect(recordLabel({ phase: 'idle', nodeId: null, seconds: 0, lastName: null }, false)).toBe('Record');
  });
});

function setup(opts: { audio?: boolean; canvas?: boolean; startError?: string; cameraBusy?: boolean; wired?: boolean } = {}) {
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
    state: { graph: { project: { fps: 30 }, edges: opts.wired ? [{ to: { node: 'rec1', port: 'audio' } }] : [] } },
    setViewed: (id: string) => log.push(`view ${id}`),
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor;
  const io = {
    liveRecorder: { state: opts.cameraBusy ? 'recording' : 'idle' },
    stream: { audioStream: () => (opts.audio === false ? null : { getAudioTracks: () => [{ kind: 'audio' }] }), recordStream: () => ({ getAudioTracks: () => [{ kind: 'record-bus' }] }) },
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
    makeRecorder: () => {
      throw new Error('not a smooth take');
    },
    now: () => 0,
    streamFps: () => null,
  };
  const ctl = new RecorderController(ed, io, env, rec as unknown as LiveRecorder);
  return { ctl, log, toasts, added, timers, rec, started: () => started };
}
const RUN: RecorderSettings = { time: 'run', sound: true, download: true, maxSide: 1920, quality: 'seen', keepRaw: true };
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
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', nodeId: null, seconds: 0, lastName: 'Recorder take 2026-11-18 12.00.00.mp4', retry: false });
    t.ctl.saveLast();
    expect(t.log.at(-1)).toBe('file Recorder take 2026-11-18 12.00.00.mp4');
    expect(t.timers).toHaveLength(0);
  });
  it('"Loop the project" leaves the clock alone; "Record sound" off records the picture only', async () => {
    const t = setup();
    t.ctl.toggle('rec1', { ...RUN, time: 'loop', sound: false, download: false, maxSide: 1280 });
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

describe('recorder: sound wiring and the viewer button', () => {
  it('knows when a sound is wired into a Recorder', async () => {
    const { hasSoundWired } = await import('./recorder');
    const g = { edges: [{ to: { node: 'rec1', port: 'audio' } }, { to: { node: 'rec2', port: 'image' } }] };
    expect(hasSoundWired(g, 'rec1')).toBe(true);
    expect(hasSoundWired(g, 'grp/rec1')).toBe(true);
    expect(hasSoundWired(g, 'rec2')).toBe(false);
    expect(hasSoundWired(g, 'xrec1')).toBe(false);
  });
  it('the viewer button uses the viewed Recorder, else the first one, else there is none', async () => {
    const { recorderForViewer } = await import('./recorder');
    const nodes = [
      { id: 'a', type: 'blur', params: {} },
      { id: 'r1', type: 'recorder', params: {} },
      { id: 'r2', type: 'recorder', params: {} },
    ];
    expect(recorderForViewer(nodes, 'r2')?.id).toBe('r2');
    expect(recorderForViewer(nodes, 'a')?.id).toBe('r1');
    expect(recorderForViewer(nodes, null)?.id).toBe('r1');
    expect(recorderForViewer([nodes[0]], null)).toBeNull();
  });
});

describe('recorder: which sound is recorded', () => {
  beforeEach(() => vi.stubGlobal('File', class { constructor(public parts: unknown[], public name: string, public opts: { type: string }) {} }));
  it('with a sound wired into the Recorder it records that sound; otherwise the sound that is playing', async () => {
    const wired = setup({ wired: true });
    wired.ctl.toggle('rec1', RUN);
    expect(wired.started()!.audio!()).toEqual({ kind: 'record-bus' });
    const plain = setup();
    plain.ctl.toggle('rec1', RUN);
    expect(plain.started()!.audio!()).toEqual({ kind: 'audio' });
    expect(plain.toasts.at(-1)).toMatch(/wire it into the Recorder/);
  });
});

/* ------------------------------------------ smooth: record the sources, render the effects after ------------------------------------------ */

const SMOOTH: RecorderSettings = { ...RUN, quality: 'smooth' };

interface SmoothOpts {
  /** Live picture nodes in the graph (default: one Webcam). */
  cams?: number;
  wired?: boolean;
  loop?: boolean;
  motion?: boolean;
  /** What the exporter does: 'ok', 'fail', 'notes' (only errors.txt comes back), 'wait' (hangs until it is cancelled). */
  render?: 'ok' | 'fail' | 'notes' | 'wait';
  audio?: boolean;
}

function setupSmooth(opts: SmoothOpts = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const runs: ExportRequest[] = [];
  let now = 1000;
  let playing = false;
  let render = opts.render ?? 'ok';
  const cams = Array.from({ length: opts.cams ?? 1 }, (_, i) => `cam${i + 1}`);
  const n = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params });
  const graph = {
    schema: 'rsmps/graph',
    version: 2,
    name: 'live',
    project: { width: 1280, height: 720, fps: 25, duration: 4, loop: opts.loop ?? true, lengthMode: 'relative', referenceSide: 1080 },
    nodes: [...cams.map((c) => n(c, 'camera-in', { mirror: true })), n('mix', 'blend'), n('rec1', 'recorder'), n('motion', 'phone-motion', { device: 'this' }), n('out', 'image-out', { frame: 'project' })],
    edges: [
      ...cams.map((c, i) => ({ id: `e${i}`, from: { node: c, port: 'image' }, to: { node: 'mix', port: `in${i}` } })),
      { id: 'm', from: { node: 'motion', port: 'yaw' }, to: { node: 'mix', port: 'amount' } },
      { id: 'r', from: { node: 'mix', port: 'image' }, to: { node: 'rec1', port: 'image' } },
      ...(opts.wired ? [{ id: 's', from: { node: 'synth', port: 'audio' }, to: { node: 'rec1', port: 'audio' } }] : []),
    ],
  } as unknown as GraphDoc;
  const state = { graph, viewedNodeId: 'mix' as string | null, item: 0, activeOutput: null };
  const ed = {
    state,
    setViewed: (id: string | null) => {
      state.viewedNodeId = id;
      log.push(`view ${id}`);
    },
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor & { exportBlocked?: string | null };
  const recs: { label: string; fps: number; audio?: () => unknown; orient?: () => unknown; startedAt: number; state: string; seconds: number; fail?: boolean; onAutoStop: ((r: 'limit' | 'error', e?: Error) => void) | null }[] = [];
  const session = { recording: false, startRecording: () => void log.push('motion.start'), stopRecording: () => (log.push('motion.stop'), { v: 1, fps: 25 }) };
  const io = {
    registry: { get: (type: string) => ({ params: {}, category: type === 'image-out' ? 'output' : 'fx' }) },
    liveRecorder: { state: 'idle' },
    stream: { audioStream: () => (opts.audio === false ? null : { getAudioTracks: () => [{ kind: 'mix' }] }), recordStream: () => ({ getAudioTracks: () => [{ kind: 'record-bus' }] }) },
    player: {
      getState: () => ({ playing }),
      setRunOn: (on: boolean) => log.push(`runOn ${on}`),
      seek: (s: number) => log.push(`seek ${s}`),
      play: () => ((playing = true), log.push('play')),
      pause: () => ((playing = false), log.push('pause')),
    },
    library: {
      add: async (files: File[]) => (added.push(...files.map((f) => f.name)), files.map((f) => ({ id: `asset:${f.name}`, name: f.name }))),
      remove: async (id: string) => void removed.push(id),
      assetInfo: (id: string) => (removed.includes(id) ? null : { id }),
      assetAudio: async () => ({ sampleRate: 48000, channels: [new Float32Array(4)] }),
    },
    take: {
      drawable: () => ({ videoWidth: 1280 }),
      captureSignals: () => (log.push('signals.start'), () => (log.push('signals.stop'), { value: (_id: string, _name: string, frame: number) => frame })),
    },
    phone: { motion: opts.motion ? { has: () => true, session: () => session } : undefined },
    exporter: {
      run: (req: ExportRequest) => {
        runs.push(req);
        log.push('render');
        req.onProgress?.({ fraction: 0.42, label: 'frame' });
        if (render === 'fail') return Promise.reject(new Error('the GPU ran out of memory'));
        if (render === 'wait') return new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        const video = { name: 'Recorder take.mp4', blob: { size: 9, type: 'video/mp4' } };
        const notes = { name: 'errors.txt', blob: { size: 5, type: 'text/plain', text: async () => 'Recorder take: this browser cannot encode video\n' } };
        return Promise.resolve(render === 'notes' ? [notes] : [video]);
      },
    },
  } as unknown as Io;
  const timers: { ms: number; fn: () => void }[] = [];
  const env: RecorderEnv = {
    findCanvas: () => ({ width: 640, height: 360 }) as HTMLCanvasElement,
    follow: () => ({ picture: () => null, dispose: () => log.push('dispose') }),
    every: (ms, fn) => {
      const t = { ms, fn };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
    saveFile: (f) => log.push(`file ${f.name}`),
    makeRecorder: () => {
      const r = {
        label: '',
        fps: 0,
        audio: undefined as (() => unknown) | undefined,
        orient: undefined as (() => unknown) | undefined,
        startedAt: 0,
        state: 'idle',
        seconds: 4,
        fail: false,
        onAutoStop: null as ((r: 'limit' | 'error', e?: Error) => void) | null,
        start(_get: () => unknown, o: { fps: number; label: string; audio?: () => unknown; orient?: () => unknown }) {
          Object.assign(r, { label: o.label, fps: o.fps, audio: o.audio, orient: o.orient, state: 'recording' });
          log.push(`raw.start ${o.label}`);
        },
        async stop() {
          log.push(`raw.stop ${r.label}`);
          if (r.fail) throw new Error('Nothing was recorded: no picture arrived.');
          return { hasAudio: !!r.audio && opts.audio !== false, blob: new Blob(['raw']), name: `${r.label} take 2026-11-26 10.00.00.mp4`, frames: 120, seconds: r.seconds, width: 1280, height: 720 };
        },
        async cancel() {
          log.push(`raw.cancel ${r.label}`);
        },
      };
      recs.push(r);
      return r as unknown as LiveRecorder;
    },
    now: () => now,
    streamFps: () => 30,
  };
  const asSeen = { state: 'idle', elapsed: 0, onAutoStop: null, start: () => log.push('rec.start'), stop: async () => ({ hasAudio: true, blob: new Blob(['clip']), name: 'Recorder take x.mp4', frames: 1, seconds: 1, width: 2, height: 2 }) };
  const ctl = new RecorderController(ed, io, env, asSeen as unknown as LiveRecorder);
  /** Run the timers of one period (30 = the watcher, 500 = the running time). */
  const tick = (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn());
  /** The camera gives its first picture, 30 ms pass, the watcher sees it: the clock starts. */
  const firstPicture = () => {
    recs.forEach((r, i) => (r.startedAt = now + 10 + i * 500));
    now += 40;
    tick(30);
  };
  return { ctl, ed, io, log, toasts, added, removed, runs, recs, timers, tick, firstPicture, graph, state, session, advance: (ms: number) => (now += ms), setRender: (r: SmoothOpts['render']) => (render = r ?? 'ok'), setPlaying: (p: boolean) => (playing = p) };
}

describe('smooth recording: the sources are recorded, the effects are rendered afterwards', () => {
  beforeEach(() => vi.stubGlobal('File', class { constructor(public parts: unknown[], public name: string, public opts: { type: string }) {} }));

  it('records the camera itself with the sound, starts the clock with the first picture, then renders and saves', async () => {
    const t = setupSmooth();
    const before = JSON.stringify(t.graph);
    t.ctl.toggle('rec1', SMOOTH);
    // the raw camera is recorded at its own rate, as the node shows it, and carries the sound that is playing
    expect(t.log).toEqual(['view rec1', 'raw.start Webcam raw']);
    expect(t.recs[0]).toMatchObject({ fps: 30, label: 'Webcam raw' });
    expect(t.recs[0].orient!()).toEqual({ mirror: true, turns: 0 });
    expect(t.recs[0].audio!()).toEqual({ kind: 'mix' });
    expect(t.ctl.store.get()).toMatchObject({ phase: 'recording', nodeId: 'rec1', smooth: true, seconds: 0 });
    // the clip is rendered at the project frame rate: said when the camera has another one
    expect(t.ctl.store.get().notes.join(' ')).toMatch(/camera gives 30 pictures a second and the project runs at 25.*Set the project frame rate to 30/);
    // no picture yet: the clock waits
    t.tick(30);
    expect(t.log).toHaveLength(2);
    t.firstPicture();
    expect(t.log.slice(2)).toEqual(['runOn true', 'seek 0', 'play', 'signals.start']);
    t.advance(2000);
    t.tick(500);
    expect(t.ctl.store.get().seconds).toBe(2);
    expect(recordLabel(t.ctl.store.get(), true)).toBe('Stop 0:02');

    t.ctl.toggle('rec1', SMOOTH);
    await settle();
    expect(t.log.slice(6)).toEqual(['pause', 'runOn false', 'signals.stop', 'raw.stop Webcam raw', 'render', `file ${t.added[1]}`, 'view mix']);
    // raw clip first, then the rendered clip
    expect(t.added).toHaveLength(2);
    expect(t.added[0]).toBe('Webcam raw take 2026-11-26 10.00.00.mp4');
    expect(t.added[1]).toMatch(/^Recorder take .*\.mp4$/);
    expect(t.removed).toEqual([]); // "Keep raw clips" is on
    expect(t.toasts.at(-1)).toMatch(/Saved to your downloads and to Media: Recorder take .*with sound.*raw camera clip \(with the sound\) is in Media: Webcam raw take/);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', nodeId: null, retry: false, smooth: false });
    expect(t.state.viewedNodeId).toBe('mix'); // the viewer shows what it showed before
    expect(JSON.stringify(t.graph)).toBe(before); // nothing in the project was changed
    expect(t.state.graph).toBe(t.graph);

    // the job the exporter got: the copy with a Media In for the camera, the take's length and clock, the recorded sound
    const req = t.runs[0];
    expect(req.graph).not.toBe(t.graph);
    expect(req.graph.nodes.find((n) => n.id === 'cam1')).toMatchObject({ type: 'media-in', params: { assets: ['asset:Webcam raw take 2026-11-26 10.00.00.mp4'], loopVideo: false, offset: 0.03 } });
    expect(req.graph.project).toMatchObject({ duration: 4, fps: 25, loop: false });
    expect(req.outputs).toHaveLength(1);
    expect(req.graph.nodes.find((n) => n.id === req.outputs[0])).toMatchObject({ type: 'image-out', params: { kind: 'video', codec: 'avc' } });
    expect(req.take!.frames).toBe(Math.floor((4 - 0.03) * 25)); // the clip began 30 ms before the clock
    expect(req.take!.at(50)).toEqual({ seconds: 2, graph: undefined }); // time ran on: frame 150 is 6 s although the project is 4 s long
    expect(req.take!.at(150).seconds).toBe(6);
    expect(req.take!.audio).toMatchObject({ sampleRate: 48000 });
    expect(req.take!.audioStart).toBeCloseTo(0.03, 6);
    expect(req.take!.signals!.value('n', 'level', 7)).toBe(7);
    expect(req).toMatchObject({ items: 'current', zip: false, runProcesses: true });
  });

  it('shows how far the rendering is; Cancel keeps the raw clip and the take can be rendered again', async () => {
    const t = setupSmooth({ render: 'wait' });
    t.ctl.toggle('rec1', SMOOTH);
    t.firstPicture();
    t.ctl.toggle('rec1', SMOOTH);
    await settle();
    expect(t.ctl.store.get()).toMatchObject({ phase: 'rendering', nodeId: 'rec1', progress: 0.42 });
    expect(recordLabel(t.ctl.store.get(), true)).toBe('Rendering 42%');
    expect((t.ed as { exportBlocked?: string | null }).exportBlocked).toMatch(/being rendered/); // an Export cannot start on top of it
    t.ctl.toggle('rec1', SMOOTH); // a second tap on Record does nothing while it renders
    expect(t.ctl.store.get().phase).toBe('rendering');
    t.ctl.cancelRender();
    await settle();
    expect(t.toasts.at(-1)).toMatch(/Rendering was cancelled\. The raw camera clip \(with the sound\) is in Media: Webcam raw take.*Render again/);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', retry: true });
    expect((t.ed as { exportBlocked?: string | null }).exportBlocked).toBeNull();
    expect(t.added).toEqual(['Webcam raw take 2026-11-26 10.00.00.mp4']);
    // again, now it works
    t.setRender('ok');
    t.ctl.renderAgain();
    await settle();
    expect(t.runs).toHaveLength(2);
    expect(t.added).toHaveLength(2);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', retry: false });
  });

  it('a rendering that fails says why and where the raw clip is; nothing is removed', async () => {
    const t = setupSmooth({ render: 'fail' });
    t.ctl.toggle('rec1', { ...SMOOTH, keepRaw: false });
    t.firstPicture();
    await t.ctl.stop();
    expect(t.toasts.at(-1)).toMatch(/could not be rendered: the GPU ran out of memory\. The raw camera clip \(with the sound\) is in Media: Webcam raw take/);
    expect(t.removed).toEqual([]);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', retry: true });
    const notes = setupSmooth({ render: 'notes' });
    notes.ctl.toggle('rec1', SMOOTH);
    notes.firstPicture();
    await notes.ctl.stop();
    expect(notes.toasts.at(-1)).toMatch(/could not be rendered: this browser cannot encode video\./);
  });

  it('"Keep raw clips" off removes them once the clip is made', async () => {
    const t = setupSmooth();
    t.ctl.toggle('rec1', { ...SMOOTH, keepRaw: false, download: false });
    t.firstPicture();
    await t.ctl.stop();
    expect(t.removed).toEqual(['asset:Webcam raw take 2026-11-26 10.00.00.mp4']);
    expect(t.toasts.at(-1)).toMatch(/^Saved to Media: Recorder take/);
    expect(t.toasts.at(-1)).not.toMatch(/raw/);
    expect(t.log.some((l) => l.startsWith('file '))).toBe(false);
  });

  it('several live pictures are recorded side by side; each clip is placed where it began on the clock', async () => {
    const t = setupSmooth({ cams: 2, wired: true });
    t.ctl.toggle('rec1', SMOOTH);
    expect(t.recs.map((r) => r.label)).toEqual(['Webcam raw', 'Webcam raw 2']);
    expect(t.recs[0].audio!()).toEqual({ kind: 'record-bus' }); // a sound wired into the Recorder is the sound
    expect(t.recs[1].audio).toBeUndefined(); // one clip carries the sound
    t.firstPicture(); // the second camera gives its first picture half a second later
    await t.ctl.stop();
    const g = t.runs[0].graph;
    expect(g.nodes.find((n) => n.id === 'cam1')!.params.offset).toBeCloseTo(0.03, 6);
    expect(g.nodes.find((n) => n.id === 'cam2')!.params.offset).toBeCloseTo(-0.47, 6);
    expect(t.toasts.at(-1)).toMatch(/raw camera clips \(with the sound\) are in Media: Webcam raw take.*, Webcam raw 2 take/);
  });

  it('a looping project is rendered pass by pass: the clock wraps, the clips and the recorded values go on', async () => {
    const t = setupSmooth();
    t.ctl.toggle('rec1', { ...SMOOTH, time: 'loop' });
    t.recs[0].seconds = 10;
    t.firstPicture();
    expect(t.log).not.toContain('runOn true');
    await t.ctl.stop();
    const take = t.runs[0].take!;
    expect(t.runs[0].graph.project.loop).toBe(true);
    expect(take.at(99)).toEqual({ seconds: 99 / 25, graph: undefined });
    const second = take.at(125); // 5 s into the take = 1 s into the second pass of the 4 s project
    expect(second.seconds).toBe(1);
    expect(second.graph!.nodes.find((n) => n.id === 'cam1')!.params.offset).toBeCloseTo(4.03, 6);
    expect(take.signals!.value('n', 'level', 25)).toBe(125); // project frame 25 of the second pass is take frame 125
    expect(take.at(126).graph).toBe(second.graph); // one copy per pass, not per frame
  });

  it('records the motion sensors with the picture and plays that take in the copy', async () => {
    const t = setupSmooth({ motion: true });
    t.ctl.toggle('rec1', SMOOTH);
    t.firstPicture();
    expect(t.log).toContain('motion.start');
    await t.ctl.stop();
    expect(t.runs[0].graph.nodes.find((n) => n.id === 'motion')!.params).toMatchObject({ source: 'recorded', take: { v: 1 } });
    expect(t.graph.nodes.find((n) => n.id === 'motion')!.params).toEqual({ device: 'this' }); // the project's node is untouched
    const none = setupSmooth();
    none.ctl.toggle('rec1', SMOOTH);
    none.firstPicture();
    expect(none.ctl.store.get().notes.join(' ')).toMatch(/Motion sensors are not running/);
  });

  it('with nothing live upstream it records as seen and says what Export is for', () => {
    const t = setupSmooth({ cams: 0 });
    t.ctl.toggle('rec1', SMOOTH);
    expect(t.toasts[0]).toMatch(/No live camera feeds this Recorder.*Export/);
    expect(t.log).toContain('rec.start');
    expect(t.ctl.store.get()).toMatchObject({ phase: 'recording', smooth: false });
    const many = setupSmooth({ cams: 5 });
    many.ctl.toggle('rec1', SMOOTH);
    expect(many.toasts[0]).toMatch(/At most 4/);
    expect(many.ctl.store.get().smooth).toBe(false);
  });

  it('Stop before the camera gave a picture saves nothing; a camera that never does gives up by itself', async () => {
    const t = setupSmooth();
    t.ctl.toggle('rec1', SMOOTH);
    await t.ctl.stop();
    expect(t.log).toEqual(['view rec1', 'raw.start Webcam raw', 'raw.cancel Webcam raw', 'view mix']);
    expect(t.toasts.at(-1)).toMatch(/Nothing was recorded/);
    expect(t.ctl.store.get().phase).toBe('idle');
    expect(t.timers).toHaveLength(0);
    const late = setupSmooth();
    late.ctl.toggle('rec1', SMOOTH);
    late.advance(16_000);
    late.tick(30);
    await settle();
    expect(late.toasts.at(-1)).toMatch(/Nothing was recorded: the camera gave no picture/);
  });

  it('ends the take when the clock stops (paused, or the project reached its end), and when a limit is reached', async () => {
    const t = setupSmooth();
    t.ctl.toggle('rec1', SMOOTH);
    t.firstPicture();
    t.setPlaying(false);
    t.tick(30);
    await settle();
    expect(t.runs).toHaveLength(1);
    expect(t.ctl.store.get().phase).toBe('idle');
    const lim = setupSmooth();
    lim.ctl.toggle('rec1', SMOOTH);
    lim.firstPicture();
    lim.recs[0].onAutoStop!('limit');
    await settle();
    expect(lim.toasts.some((m) => /reached its limit/.test(m))).toBe(true);
    expect(lim.added).toHaveLength(2);
  });

  it('a camera that recorded nothing leaves the other raw clips in Media and says so', async () => {
    const t = setupSmooth({ cams: 2 });
    t.ctl.toggle('rec1', SMOOTH);
    t.firstPicture();
    t.recs[0].fail = true;
    await t.ctl.stop();
    expect(t.runs).toHaveLength(0);
    expect(t.added).toEqual(['Webcam raw 2 take 2026-11-26 10.00.00.mp4']);
    expect(t.toasts.at(-1)).toMatch(/not saved: no picture was recorded\. What was recorded is in Media: Webcam raw 2 take/);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', retry: false });
  });

  it('without sound running it says the clip will be silent, and the clip has no sound track', async () => {
    const t = setupSmooth({ audio: false });
    t.ctl.toggle('rec1', SMOOTH);
    expect(t.ctl.store.get().notes[0]).toMatch(/No sound is running/);
    t.firstPicture();
    await t.ctl.stop();
    expect(t.runs[0].take!.audio).toBeNull();
    expect(t.toasts.at(-1)).toMatch(/picture only/);
  });
});
