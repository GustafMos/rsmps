/**
 * The Recorder node's Record button. One recording at a time, made in one of two ways:
 *
 *  - "As seen": records what the viewer shows while that node is viewed, with the sound mix, into a clip in Media. Instant, but the
 *    clip is only as smooth as the preview was. The picture is taken like the Output window takes it: the viewer's canvas is
 *    captured into a <video>, which always holds the latest frame; where the browser cannot capture the canvas, the canvas is drawn.
 *  - "Smooth, effects after": records every live picture that feeds the Recorder as a raw clip (cheap, so it keeps the camera's frame
 *    rate even on a phone) with the sound as it is heard, and when the user stops, renders the same graph offline with the raw clips
 *    in place of the live inputs (src/engine/lib/take-graph.ts, the exporter's `take`). Every frame is rendered at the time it was
 *    seen at, so the clip is smooth however slow the device is; only the waiting is longer.
 *
 * The encoding is `LiveRecorder` (src/io/live-record.ts), the same one the Webcam's Record uses.
 */
import { defaultParams } from '../../engine/engine';
import { liveOrientOfNode, liveSourceOfNode, liveTakeLabel } from '../../engine/lib/live-source';
import { motionSession } from '../../engine/lib/motion-source';
import { MAX_TAKE_SOURCES, TAKE_OUTPUT_LABEL, buildTakeGraph, findLiveInputs, findMotionInputs, soundPlan, takeFrameTime, type TakeClip } from '../../engine/lib/take-graph';
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';
import { readFrameParams, resolveFrame } from '../../io/frame';
import { LiveRecorder, formatElapsed, streamFrameRate, takeFileName } from '../../io/live-record';
import type { SignalCapture } from '../../io/signals';
import { isHandheld } from '../lib/handheld';
import type { Editor } from './editor';
import { createStore, type Store } from './createStore';

export interface RecorderUi {
  /** 'rendering': a smooth take is being rendered from its raw clips (`progress`). */
  phase: 'idle' | 'recording' | 'saving' | 'rendering';
  /** The Recorder node being recorded (its path id), or null. */
  nodeId: string | null;
  seconds: number;
  /** File name of the last finished clip of this session, or null. */
  lastName: string | null;
  /** The running take records the sources and renders the effects afterwards. */
  smooth: boolean;
  /** Rendering: 0..1, and the seconds it still needs as far as can be told (null: too early to say). */
  progress: number;
  remaining: number | null;
  /** A take whose raw clips are in Media but whose clip was not rendered (cancelled, or it failed): it can be rendered again. */
  retry: boolean;
  /** Things of the running take that will not be in the clip the way they are seen now, in plain words. */
  notes: readonly string[];
}

const IDLE: RecorderUi = { phase: 'idle', nodeId: null, seconds: 0, lastName: null, smooth: false, progress: 0, remaining: null, retry: false, notes: [] };

export interface RecorderSettings {
  time: 'run' | 'loop';
  sound: boolean;
  /** Longest side of the clip. */
  maxSide: number;
  /** Also save the clip as a file on the device when the recording stops. */
  download: boolean;
  /** 'smooth': record the sources and render the effects afterwards. 'seen': record what the viewer shows. */
  quality: 'smooth' | 'seen';
  /** Smooth takes: keep the raw clips in Media after the clip was rendered. */
  keepRaw: boolean;
}

/**
 * A Recorder node's settings, with defaults for anything missing or odd. "Automatic" quality is the smooth way on a phone or tablet
 * (which cannot hold the frame rate with effects on) and the instant way on a computer.
 */
export function recorderSettings(params: Readonly<Record<string, unknown>>, handheld: boolean = isHandheld()): RecorderSettings {
  const side = Number(params.size);
  return {
    time: params.time === 'loop' ? 'loop' : 'run',
    sound: params.sound !== false,
    download: params.download !== false,
    maxSide: side === 1280 || side === 3840 ? side : 1920,
    quality: params.quality === 'smooth' || params.quality === 'seen' ? params.quality : handheld ? 'smooth' : 'seen',
    keepRaw: params.keepRaw !== false,
  };
}

/** "about 40 s left", "about 3 min left": how long a rendering still needs. Empty while it cannot be told. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 90 ? `about ${Math.max(5, Math.ceil(seconds / 5) * 5)} s left` : `about ${Math.round(seconds / 60)} min left`;
}

/** Seconds a job still needs when `fraction` of it took `elapsedSeconds`. Null in the first moments, when the guess would be wild. */
export function remainingSeconds(elapsedSeconds: number, fraction: number): number | null {
  if (!(fraction > 0.02) || !(elapsedSeconds > 2)) return null;
  return (elapsedSeconds * (1 - fraction)) / fraction;
}

/**
 * Params of the Output node a take is rendered through: the frame of the project's active Output (what the preview used), as an H.264
 * video, no larger than `maxSide` on its long side.
 */
export function takeOutputParams(active: Readonly<Record<string, unknown>> | null, project: { width: number; height: number }, maxSide: number): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const k of ['frame', 'orientation', 'frameWidth', 'frameHeight', 'pixelSize', 'conform', 'conformAnchor']) if (active && active[k] !== undefined) keep[k] = active[k];
  const size = resolveFrame(project, readFrameParams(keep));
  const long = Math.max(size.width, size.height);
  if (long > maxSide) {
    const k = maxSide / long;
    const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
    Object.assign(keep, { frame: 'custom', orientation: 'as-is', frameWidth: even(size.width), frameHeight: even(size.height) });
  }
  return { ...keep, name: 'Recorder take', kind: 'video', videoFor: 'general', codec: 'avc', autoBitrate: true, allKeys: false, scale: 1, exportArtSize: false };
}

/** True when something is wired into the Sound input of Recorder `nodeId` (a plain id, or the last part of a path id). */
export function hasSoundWired(graph: { edges: readonly { to: { node: string; port: string } }[] }, nodeId: string): boolean {
  return graph.edges.some((e) => e.to.port === 'audio' && (e.to.node === nodeId || nodeId.endsWith(`/${e.to.node}`)));
}

/** The Recorder the viewer's Record button works: the one being viewed if it is a Recorder, else the first one in the project. */
export function recorderForViewer(nodes: readonly { id: string; type: string; params: Readonly<Record<string, unknown>> }[], viewedId: string | null): { id: string; params: Readonly<Record<string, unknown>> } | null {
  const recs = nodes.filter((n) => n.type === 'recorder');
  return recs.find((n) => n.id === viewedId) ?? recs[0] ?? null;
}

/** What the Record button says. */
export function recordLabel(ui: Pick<RecorderUi, 'phase' | 'seconds'> & Partial<RecorderUi>, mine: boolean): string {
  if (mine && ui.phase === 'recording') return `Stop ${formatElapsed(ui.seconds)}`;
  if (mine && ui.phase === 'saving') return 'Saving';
  if (mine && ui.phase === 'rendering') return `Rendering ${Math.round(Math.min(1, Math.max(0, ui.progress ?? 0)) * 100)}%`;
  return 'Record';
}

/** The browser parts, injectable for tests. */
export interface RecorderEnv {
  findCanvas(): HTMLCanvasElement | null;
  /** A drawable that follows `canvas` (see the file header), and a way to release it. */
  follow(canvas: HTMLCanvasElement): { picture(): CanvasImageSource | null; dispose(): void };
  every(ms: number, fn: () => void): () => void;
  /** Save a finished clip as a file on the device (the browser's download). */
  saveFile(file: File): void;
  /** A recorder for one raw clip of a smooth take. */
  makeRecorder(): LiveRecorder;
  /** `performance.now()`. */
  now(): number;
  /** Frames per second a live picture delivers, when the browser says (see `streamFrameRate`). */
  streamFps(picture: unknown): number | null;
}

export const browserRecorderEnv: RecorderEnv = {
  findCanvas: () => document.querySelector<HTMLCanvasElement>('canvas.rs-viewer__canvas'),
  follow(canvas) {
    let video: HTMLVideoElement | null = null;
    try {
      const stream = (canvas as HTMLCanvasElement & { captureStream?: () => MediaStream }).captureStream?.();
      if (stream) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      }
    } catch {
      video = null;
    }
    return {
      picture: () => (video && video.videoWidth > 0 ? video : canvas.width > 0 && canvas.height > 0 ? canvas : null),
      dispose() {
        (video?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
        if (video) video.srcObject = null;
        video = null;
      },
    };
  },
  every(ms, fn) {
    const t = window.setInterval(fn, ms);
    return () => window.clearInterval(t);
  },
  saveFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  makeRecorder: () => new LiveRecorder(),
  now: () => performance.now(),
  streamFps: streamFrameRate,
};

/** A smooth take gives up waiting for the camera's first picture after this long. */
export const FIRST_PICTURE_MS = 15_000;

interface MotionRec {
  id: string;
  session: { recording: boolean; startRecording(): void; stopRecording(o: { fps: number; loop?: boolean }): unknown };
}

/** A smooth take while it is being recorded. */
interface SmoothTake {
  nodeId: string;
  settings: RecorderSettings;
  inputs: { id: string; rec: LiveRecorder }[];
  /** Project frame rate. */
  fps: number;
  /** Project length in frames when the clock wraps there, else null. */
  loopFrames: number | null;
  askedAt: number;
  /** `env.now()` when the clock started (0 = still waiting for the first picture). */
  playAt: number;
  date: Date;
  stopSignals: (() => SignalCapture | null) | null;
  motion: MotionRec[];
  /** What the viewer showed and whether the project was playing before the take: put back when it is over. */
  prevViewed: string | null;
  wasPlaying: boolean;
}

/** A recorded smooth take: everything needed to render it (again). */
interface PendingRender {
  nodeId: string;
  settings: RecorderSettings;
  clips: TakeClip[];
  rawNames: string[];
  frames: number;
  fps: number;
  loopFrames: number | null;
  /** The raw clip that carries the recorded sound, or null. */
  soundAsset: string | null;
  /** Seconds into that sound at which frame 0 of the take is. */
  soundStart: number;
  signals: SignalCapture | null;
  motion: Map<string, unknown>;
  date: Date;
  prevViewed: string | null;
  wasPlaying: boolean;
}

export class RecorderController {
  readonly store: Store<RecorderUi> = createStore<RecorderUi>({ ...IDLE });
  private rec: LiveRecorder;
  private stops: (() => void)[] = [];
  private ranOn = false;
  private finishing: Promise<void> | null = null;
  private download = true;
  /** The last finished clip, kept so it can be saved as a file again (or for the first time). */
  private last: File | null = null;
  private smooth: SmoothTake | null = null;
  /** The last smooth take whose clip is not rendered yet (its raw clips are in Media). */
  private pending: PendingRender | null = null;
  private renderAbort: AbortController | null = null;

  constructor(
    private ed: Editor,
    private io: Io,
    private env: RecorderEnv = browserRecorderEnv,
    rec: LiveRecorder = new LiveRecorder(),
  ) {
    this.rec = rec;
    this.rec.onAutoStop = (reason, error) => void this.finish(reason === 'limit' ? 'The recording reached its limit (30 minutes or 1.5 GB) and was saved.' : null, error);
  }

  toggle(nodeId: string, settings: RecorderSettings): void {
    const ui = this.store.get();
    if (ui.phase === 'saving' || ui.phase === 'rendering') return; // rendering is ended with Cancel, never by a second tap on Record
    if (ui.phase === 'recording') {
      if (ui.nodeId === nodeId) void this.finish(null);
      else this.ed.toast('Another Recorder is recording. Stop that one first.', 'info');
      return;
    }
    if (settings.quality === 'smooth' && this.startSmooth(nodeId, settings)) return;
    this.start(nodeId, settings);
  }

  /* --------------------------------------------- as seen --------------------------------------------- */

  private start(nodeId: string, settings: RecorderSettings): void {
    const { ed, io } = this;
    if (io.liveRecorder.state !== 'idle') return ed.toast('A camera recording is running. Stop that one first.', 'info');
    // Show this node, so the viewer (which is what gets recorded) carries exactly what flows through it.
    ed.setViewed(nodeId);
    const canvas = this.env.findCanvas();
    if (!canvas) return ed.toast('There is no viewer to record from.', 'error');
    const follow = this.env.follow(canvas);
    const fps = ed.state.graph.project.fps;
    const plan = soundPlan(settings.sound, hasSoundWired(ed.state.graph, nodeId));
    try {
      this.rec.start(() => follow.picture(), {
        fps,
        label: 'Recorder',
        maxSide: settings.maxSide,
        // A Recorder with sound wired into it records exactly that sound (the record bus); otherwise the sound that is playing.
        audio: plan !== 'none' ? () => (plan === 'wired' ? io.stream.recordStream() : io.stream.audioStream())?.getAudioTracks()[0] ?? null : undefined,
      });
    } catch (err) {
      follow.dispose();
      return ed.toast(err instanceof Error ? err.message : String(err), 'error');
    }
    this.download = settings.download;
    this.ranOn = settings.time === 'run';
    if (this.ranOn) io.player.setRunOn(true);
    io.player.seek(0);
    io.player.play();
    this.stops.push(
      () => follow.dispose(),
      this.env.every(500, () => this.store.set((s) => (s.phase === 'recording' ? { ...s, seconds: this.rec.elapsed } : s))),
    );
    this.store.set((s) => ({ ...IDLE, phase: 'recording', nodeId, lastName: s.lastName, retry: s.retry }));
    if (plan !== 'none' && !io.stream.audioStream()) ed.toast('Recording without sound: no sound is running. Press Enable audio and record again to include it.', 'info');
    else if (plan === 'mix') ed.toast('Recording the sound that is playing. To record one particular sound, wire it into the Recorder\'s Sound input.', 'info');
  }

  /** Stop and save. `note` is shown instead of the usual message (a limit was reached); `error` when the recording broke. */
  private finish(note: string | null, error?: Error): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.store.get().phase !== 'recording') return Promise.resolve();
    const smooth = this.smooth;
    const run = async () => {
      if (smooth) {
        try {
          await this.finishSmooth(smooth, note, error);
        } finally {
          this.finishing = null;
        }
        return;
      }
      this.store.set((s) => ({ ...s, phase: 'saving' }));
      this.io.player.pause();
      if (this.ranOn) this.io.player.setRunOn(false);
      try {
        const take = await this.rec.stop();
        const file = new File([take.blob], take.name, { type: take.blob.type });
        this.last = file;
        this.store.set((s) => ({ ...s, lastName: file.name }));
        // the file first: it does not depend on the library, so the clip is on the device even if Media refuses it
        if (this.download) this.env.saveFile(file);
        const [asset] = await this.io.library.add([file]);
        if (!asset) throw new Error('The clip could not be added to Media.');
        const where = this.download ? 'Saved to your downloads and to Media' : 'Saved to Media';
        this.ed.toast(note ?? `${where}: ${take.name} (${formatElapsed(take.seconds)}${take.hasAudio ? ', with sound' : ', picture only'}).`, 'ok');
      } catch (err) {
        this.ed.toast(`The recording was not saved: ${(error ?? (err instanceof Error ? err : new Error(String(err)))).message}`, 'error');
      }
      for (const off of this.stops.splice(0)) off();
      this.store.set((s) => ({ ...IDLE, lastName: s.lastName, retry: s.retry }));
      this.finishing = null;
    };
    this.finishing = run();
    return this.finishing;
  }

  /* ------------------------------------- smooth: record the sources ------------------------------------- */

  /**
   * Start a smooth take. False when this Recorder cannot be recorded that way (nothing live feeds it, or too much does): the caller
   * then records as seen. True when the take started, or a toast said why nothing was started.
   */
  private startSmooth(nodeId: string, settings: RecorderSettings): boolean {
    const { ed, io, env } = this;
    const graph = ed.state.graph;
    const found = findLiveInputs(graph, nodeId);
    const inputs = found
      .map((n) => {
        const def = io.registry.get(n.type);
        const params = { ...(def ? defaultParams(def) : {}), ...n.params };
        return { id: n.id, type: n.type, source: liveSourceOfNode(n.type, params), orient: liveOrientOfNode(n.type, params) };
      })
      .filter((n) => n.source !== null);
    if (!inputs.length) {
      ed.toast('No live camera feeds this Recorder, so it records what the viewer shows. For a smooth file of a clip with effects use Export: it renders every frame.', 'info');
      return false;
    }
    if (inputs.length > MAX_TAKE_SOURCES) {
      ed.toast(`${inputs.length} live pictures feed this Recorder. At most ${MAX_TAKE_SOURCES} can be recorded side by side, so it records what the viewer shows.`, 'info');
      return false;
    }
    if (io.liveRecorder.state !== 'idle') {
      ed.toast('A camera recording is running. Stop that one first.', 'info');
      return true;
    }
    if ((ed.state as { exportJob?: unknown }).exportJob) {
      ed.toast('An export is running. Record when it has finished.', 'info');
      return true;
    }
    const prevViewed = (ed.state as { viewedNodeId?: string | null }).viewedNodeId ?? null;
    const wasPlaying = io.player.getState().playing;
    ed.setViewed(nodeId); // the preview shows the effect while the sources are recorded
    const fps = graph.project.fps;
    const plan = soundPlan(settings.sound, hasSoundWired(graph, nodeId));
    const made: { id: string; rec: LiveRecorder }[] = [];
    let cameraFps: number | null = null;
    try {
      inputs.forEach((n, i) => {
        const rec = env.makeRecorder();
        const picture = () => io.take.drawable(n.source!);
        const own = env.streamFps(picture());
        if (i === 0) cameraFps = own;
        rec.onAutoStop = (reason, error) => void this.finish(reason === 'limit' ? 'The recording reached its limit (30 minutes or 1.5 GB).' : null, error);
        rec.start(picture, {
          // the camera's own rate when the browser tells it, so no frame it delivers is lost; the project's otherwise
          fps: own ?? fps,
          label: `${liveTakeLabel(n.type)} raw${i ? ` ${i + 1}` : ''}`,
          // the clip holds the picture the way the node shows it (mirrored, turned), so the Media In that replaces it needs no Flip
          orient: () => n.orient,
          // the first clip carries the sound as it is heard: that track is final, only the picture is made again
          audio: i === 0 && plan !== 'none' ? () => (plan === 'wired' ? io.stream.recordStream() : io.stream.audioStream())?.getAudioTracks()[0] ?? null : undefined,
        });
        made.push({ id: n.id, rec });
      });
    } catch (err) {
      for (const m of made) void m.rec.cancel().catch(() => undefined);
      ed.setViewed(prevViewed);
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
      return true;
    }
    const loopFrames = settings.time === 'loop' && graph.project.loop ? Math.max(1, Math.round(graph.project.duration * fps)) : null;
    const take: SmoothTake = { nodeId, settings, inputs: made, fps, loopFrames, askedAt: env.now(), playAt: 0, date: new Date(), stopSignals: null, motion: [], prevViewed, wasPlaying };
    this.smooth = take;
    this.download = settings.download;
    this.ranOn = settings.time === 'run';
    const notes: string[] = [];
    if (plan !== 'none' && !io.stream.audioStream()) notes.push('No sound is running, so the clip will have the picture only. Press Enable audio and record again to include it.');
    if (found.length > inputs.length) notes.push('A live input that is not set up yet is not recorded.');
    // The clip is rendered at the project frame rate, like an export, so effects that count frames look as designed. Say so when the
    // camera runs at another rate: matching the project to it is one setting, and then every camera picture is one frame of the clip.
    const camera = cameraFps as number | null;
    if (camera !== null && Math.abs(camera - fps) > 0.5) notes.push(`The camera gives ${Math.round(camera * 100) / 100} pictures a second and the project runs at ${fps}, so the clip has ${fps}. Set the project frame rate to ${Math.round(camera)} to keep every camera picture.`);
    this.stops.push(
      env.every(30, () => {
        if (this.smooth !== take || this.store.get().phase !== 'recording') return;
        if (!take.playAt) {
          // The clock starts with the first recorded picture, so the raw clip and the project time line up from frame 0.
          if (take.inputs[0].rec.startedAt > 0) this.beginSmooth(take);
          else if (env.now() - take.askedAt > FIRST_PICTURE_MS) void this.finish(null, new Error('the camera gave no picture'));
          return;
        }
        // Paused, or the project reached its end: the clock stopped, so the take ends here (the raw clips would run on without it).
        if (!io.player.getState().playing) void this.finish(null);
      }),
      env.every(500, () => this.store.set((s) => (s.phase === 'recording' && take.playAt ? { ...s, seconds: Math.max(0, (env.now() - take.playAt) / 1000) } : s))),
    );
    this.store.set((s) => ({ ...IDLE, phase: 'recording', nodeId, lastName: s.lastName, smooth: true, notes }));
    return true;
  }

  /** The first picture is recorded: start the clock, and with it everything else that is recorded along. */
  private beginSmooth(take: SmoothTake): void {
    const { ed, io, env } = this;
    if (this.ranOn) io.player.setRunOn(true);
    io.player.seek(0);
    io.player.play();
    take.playAt = env.now();
    // live sound-to-picture values (a microphone cannot be played again), remembered per frame of the take
    take.stopSignals = io.take.captureSignals(take.fps);
    // motion sensors: the motion nodes' own take recording; the takes go into the copy that is rendered, not into the project
    const notes: string[] = [];
    for (const m of findMotionInputs(ed.state.graph, take.nodeId)) {
      const token = motionSession(m.params);
      const session = token && io.phone?.motion?.has(token) ? io.phone.motion.session(token) : null;
      if (!session || session.recording) {
        notes.push(session ? 'A motion take is already being recorded, so the motion is not recorded with this clip.' : 'Motion sensors are not running, so effects that follow them stay still in the clip.');
        continue;
      }
      session.startRecording();
      take.motion.push({ id: m.id, session });
    }
    if (take.motion.length && take.loopFrames) notes.push('The motion is recorded for the first pass of the loop; later passes repeat it.');
    if (notes.length) this.store.set((s) => ({ ...s, notes: [...s.notes, ...notes] }));
  }

  /** Stop a smooth take: the raw clips go to Media, then the clip is rendered from them. */
  private async finishSmooth(take: SmoothTake, note: string | null, error?: Error): Promise<void> {
    const { ed, io } = this;
    this.smooth = null;
    this.store.set((s) => ({ ...s, phase: 'saving' }));
    for (const off of this.stops.splice(0)) off();
    const started = take.playAt > 0;
    if (started) {
      io.player.pause();
      if (this.ranOn) io.player.setRunOn(false);
    }
    const signals = take.stopSignals?.() ?? null;
    const motion = new Map<string, unknown>();
    for (const m of take.motion) {
      const t = m.session.stopRecording({ fps: take.fps, loop: false });
      if (t) motion.set(m.id, t);
    }
    const idle = () => {
      ed.setViewed(take.prevViewed);
      if (take.wasPlaying) io.player.play();
      this.store.set((s) => ({ ...IDLE, lastName: s.lastName, retry: !!this.pending }));
    };
    if (!started) {
      for (const i of take.inputs) await i.rec.cancel().catch(() => undefined);
      ed.toast(`Nothing was recorded: ${error?.message ?? 'the camera had not given a picture yet'}.`, 'error');
      return idle();
    }
    // Where each clip's first frame sits on the take's clock. Read before stopping: a stopped recorder forgets it.
    const starts = take.inputs.map((i) => (i.rec.startedAt > 0 ? (i.rec.startedAt - take.playAt) / 1000 : 0));
    const stopped = await Promise.all(take.inputs.map((i) => i.rec.stop().then((t) => t, () => null)));
    const clips: TakeClip[] = [];
    const rawNames: string[] = [];
    let soundAsset: string | null = null;
    let seconds = 0;
    try {
      const kept = stopped.filter((t): t is NonNullable<typeof t> => !!t).map((t) => new File([t.blob], t.name, { type: t.blob.type }));
      const assets = kept.length ? await io.library.add(kept) : [];
      let k = 0;
      stopped.forEach((t, i) => {
        if (!t) return;
        const asset = assets[k++];
        if (!asset) return;
        clips.push({ id: take.inputs[i].id, assetId: asset.id, startsAt: starts[i] });
        rawNames.push(t.name);
        if (i === 0) {
          seconds = t.seconds + starts[0]; // the clip began a moment before the clock did
          if (t.hasAudio) soundAsset = asset.id;
        }
      });
      if (!clips.some((c) => c.id === take.inputs[0].id)) throw new Error(error?.message ?? 'no picture was recorded');
    } catch (err) {
      const where = rawNames.length ? ` What was recorded is in Media: ${rawNames.join(', ')}.` : '';
      ed.toast(`The recording was not saved: ${err instanceof Error ? err.message : String(err)}.${where}`, 'error');
      return idle();
    }
    this.pending = {
      nodeId: take.nodeId,
      settings: take.settings,
      clips,
      rawNames,
      frames: Math.max(1, Math.floor(seconds * take.fps)),
      fps: take.fps,
      loopFrames: take.loopFrames,
      soundAsset,
      soundStart: -starts[0],
      signals,
      motion,
      date: take.date,
      prevViewed: take.prevViewed,
      wasPlaying: take.wasPlaying,
    };
    if (note) ed.toast(note, 'info');
    else if (error) ed.toast(`The recording stopped early: ${error.message}. What was recorded is rendered now.`, 'info');
    await this.render(this.pending);
  }

  /* ------------------------------------- smooth: render the effects ------------------------------------- */

  /**
   * Render the clip of a recorded take: the graph as it is NOW (so a take can be rendered again with other effects) with the raw
   * clips in place of the live inputs, every frame at the project time it was seen at, with the recorded sound. The project itself
   * is not touched: the copy lives only for this rendering.
   */
  private async render(p: PendingRender): Promise<void> {
    const { ed, io, env } = this;
    const elsewhere = (ed as unknown as { exportBusy?: string | null }).exportBusy;
    if (elsewhere) {
      // another rendering (an export, a World AR video) holds the GPU: the raw clips are kept and this take waits for "Render again"
      ed.toast(`${elsewhere} The raw camera clips are in Media: ${p.rawNames.join(', ')}. Press "Render again" on the Recorder when it has finished.`, 'info');
      ed.setViewed(p.prevViewed);
      if (p.wasPlaying) io.player.play();
      this.store.set((s) => ({ ...IDLE, lastName: s.lastName, retry: !!this.pending }));
      return;
    }
    const began = env.now();
    const ac = new AbortController();
    this.renderAbort = ac;
    // an Export started now would render at the same time on the same GPU: it is refused with this message until the clip is done
    const blocked = ed as unknown as { exportBlocked: string | null };
    blocked.exportBlocked = 'A recording is being rendered. Export when it has finished.';
    this.store.set((s) => ({ ...IDLE, phase: 'rendering', nodeId: p.nodeId, lastName: s.lastName, smooth: true }));
    const many = p.rawNames.length > 1;
    const rawWhere = `The raw camera ${many ? 'clips' : 'clip'}${p.soundAsset ? ' (with the sound)' : ''} ${many ? 'are' : 'is'} in Media: ${p.rawNames.join(', ')}.`;
    try {
      const source: GraphDoc = ed.state.graph;
      const isOut = (n: { type: string }) => io.registry.get(n.type)?.category === 'output';
      const activeId = (ed.state as { activeOutput?: string | null }).activeOutput;
      const active = source.nodes.find((n) => n.id === activeId && isOut(n)) ?? source.nodes.find((n) => isOut(n) && n.type === 'image-out');
      const output = takeOutputParams(active?.params ?? null, source.project, p.settings.maxSide);
      const build = (passStart: number) => buildTakeGraph(source, p.nodeId, p.clips, { time: p.loopFrames ? 'loop' : 'run', passStart, output, motion: p.motion });
      const first = build(0);
      if (!first) throw new Error('the Recorder node is no longer in the project');
      const sound = p.soundAsset ? ((await io.library.assetAudio?.(p.soundAsset)) ?? null) : null;
      // A looping project: the clock wraps but the clips go on, so each pass is rendered from a copy whose clips start further in.
      const loop = p.loopFrames ?? 0;
      let pass = 0;
      let passGraph: GraphDoc | undefined;
      const signals = p.signals;
      const files = await io.exporter.run({
        graph: first.graph,
        outputs: [first.outputId],
        items: 'current',
        item: (ed.state as { item?: number }).item ?? 0,
        zip: false,
        signal: ac.signal,
        // an analysis the live preview could only show a stand-in for can run on the recorded clip
        runProcesses: true,
        onProgress: (pr) => this.store.set((s) => (s.phase === 'rendering' ? { ...s, progress: pr.fraction, remaining: remainingSeconds((env.now() - began) / 1000, pr.fraction) } : s)),
        take: {
          frames: p.frames,
          at: (frame) => {
            const t = takeFrameTime(frame, p.fps, p.loopFrames);
            if (t.pass !== pass) {
              pass = t.pass;
              passGraph = pass ? build((pass * loop) / p.fps)?.graph : undefined;
            }
            return { seconds: t.seconds, graph: passGraph };
          },
          audio: sound,
          audioStart: p.soundStart,
          // nodes ask by project frame; the recorded values are kept by take frame, which is further on in a later pass
          ...(signals ? { signals: { fps: p.fps, value: (id: string, name: string, frame: number) => signals.value(id, name, frame + pass * loop) } } : {}),
        },
      });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const video = files.find((f) => /\.(mp4|webm|mov|mkv)$/i.test(f.name) && f.blob.size > 0);
      const report = files.find((f) => /^errors.*\.txt$/i.test(f.name));
      // the exporter's note starts with the name of the output it rendered; here there is only the one
      if (!video) throw new Error(report ? (await report.blob.text()).trim().split('\n')[0].replace(`${TAKE_OUTPUT_LABEL}: `, '') : 'no video was made');
      const ext = /\.([a-z0-9]+)$/i.exec(video.name)?.[1].toLowerCase() ?? 'mp4';
      const file = new File([video.blob], takeFileName('Recorder', p.date, ext), { type: video.blob.type });
      this.last = file;
      this.pending = null;
      this.store.set((s) => ({ ...s, phase: 'saving', lastName: file.name }));
      // the file first: it does not depend on the library, so the clip is on the device even if Media refuses it
      if (p.settings.download) env.saveFile(file);
      const [asset] = await io.library.add([file]);
      if (!asset) throw new Error('the clip could not be added to Media');
      let rawNote = ` ${rawWhere}`;
      if (!p.settings.keepRaw) {
        for (const c of p.clips) await io.library.remove(c.assetId).catch(() => undefined);
        rawNote = '';
      }
      const where = p.settings.download ? 'Saved to your downloads and to Media' : 'Saved to Media';
      ed.toast(`${where}: ${file.name} (${formatElapsed(p.frames / p.fps)}${sound ? ', with sound' : ', picture only'}).${rawNote}`, 'ok');
    } catch (err) {
      const again = this.pending ? ' Press "Render again" on the Recorder to make the clip from it.' : '';
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) ed.toast(`Rendering was cancelled. ${rawWhere}${again}`, 'info');
      else ed.toast(`The clip could not be rendered: ${err instanceof Error ? err.message : String(err)}. ${rawWhere}${again}`, 'error');
    } finally {
      this.renderAbort = null;
      blocked.exportBlocked = null;
      ed.setViewed(p.prevViewed);
      if (p.wasPlaying) io.player.play();
      this.store.set((s) => ({ ...IDLE, lastName: s.lastName, retry: !!this.pending }));
    }
  }

  /** Stop the rendering of a smooth take. Its raw clips stay in Media and it can be rendered again. */
  cancelRender(): void {
    this.renderAbort?.abort();
  }

  /** Render the last smooth take again from its raw clips, with the effects as they are now. */
  renderAgain(): void {
    const p = this.pending;
    if (!p || this.store.get().phase !== 'idle') return;
    if (p.clips.some((c) => !this.io.library.assetInfo(c.assetId))) {
      this.pending = null;
      this.store.set((s) => ({ ...s, retry: false }));
      return this.ed.toast('The raw clips of that take are no longer in Media.', 'error');
    }
    p.prevViewed = (this.ed.state as { viewedNodeId?: string | null }).viewedNodeId ?? null;
    p.wasPlaying = this.io.player.getState().playing;
    void this.render(p);
  }

  /** Save the last finished clip as a file on the device (again, or for the first time). */
  saveLast(): void {
    if (this.last) this.env.saveFile(this.last);
  }

  /** Stop from outside (the node was deleted, the project closed). */
  stop(): Promise<void> {
    return this.finish(null);
  }
}
