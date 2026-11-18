/**
 * The Recorder node's Record button: records what the viewer shows while that node is viewed, with the sound mix, into a clip in
 * Media. One recording at a time. The encoding is `LiveRecorder` (src/io/live-record.ts), the same one the Webcam's Record uses.
 *
 * The picture is taken like the Output window takes it: the viewer's canvas is captured into a <video>, which always holds the
 * latest frame; where the browser cannot capture the canvas, the canvas itself is drawn.
 */
import type { Io } from '../../io/api';
import { LiveRecorder, formatElapsed } from '../../io/live-record';
import type { Editor } from './editor';
import { createStore, type Store } from './createStore';

export interface RecorderUi {
  phase: 'idle' | 'recording' | 'saving';
  /** The Recorder node being recorded (its path id), or null. */
  nodeId: string | null;
  seconds: number;
}

export interface RecorderSettings {
  time: 'run' | 'loop';
  sound: boolean;
  /** Longest side of the clip. */
  maxSide: number;
}

/** A Recorder node's settings, with defaults for anything missing or odd. */
export function recorderSettings(params: Readonly<Record<string, unknown>>): RecorderSettings {
  const side = Number(params.size);
  return { time: params.time === 'loop' ? 'loop' : 'run', sound: params.sound !== false, maxSide: side === 1280 || side === 3840 ? side : 1920 };
}

/** What the Record button says. */
export function recordLabel(ui: RecorderUi, mine: boolean): string {
  if (mine && ui.phase === 'recording') return `Stop ${formatElapsed(ui.seconds)}`;
  if (mine && ui.phase === 'saving') return 'Saving';
  return 'Record';
}

/** The browser parts, injectable for tests. */
export interface RecorderEnv {
  findCanvas(): HTMLCanvasElement | null;
  /** A drawable that follows `canvas` (see the file header), and a way to release it. */
  follow(canvas: HTMLCanvasElement): { picture(): CanvasImageSource | null; dispose(): void };
  every(ms: number, fn: () => void): () => void;
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
};

export class RecorderController {
  readonly store: Store<RecorderUi> = createStore<RecorderUi>({ phase: 'idle', nodeId: null, seconds: 0 });
  private rec: LiveRecorder;
  private stops: (() => void)[] = [];
  private ranOn = false;
  private finishing: Promise<void> | null = null;

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
    if (ui.phase === 'saving') return;
    if (ui.phase === 'recording') {
      if (ui.nodeId === nodeId) void this.finish(null);
      else this.ed.toast('Another Recorder is recording. Stop that one first.', 'info');
      return;
    }
    this.start(nodeId, settings);
  }

  private start(nodeId: string, settings: RecorderSettings): void {
    const { ed, io } = this;
    if (io.liveRecorder.state !== 'idle') return ed.toast('A camera recording is running. Stop that one first.', 'info');
    // Show this node, so the viewer (which is what gets recorded) carries exactly what flows through it.
    ed.setViewed(nodeId);
    const canvas = this.env.findCanvas();
    if (!canvas) return ed.toast('There is no viewer to record from.', 'error');
    const follow = this.env.follow(canvas);
    const fps = ed.state.graph.project.fps;
    try {
      this.rec.start(() => follow.picture(), {
        fps,
        label: 'Recorder',
        maxSide: settings.maxSide,
        audio: settings.sound ? () => io.stream.audioStream()?.getAudioTracks()[0] ?? null : undefined,
      });
    } catch (err) {
      follow.dispose();
      return ed.toast(err instanceof Error ? err.message : String(err), 'error');
    }
    this.ranOn = settings.time === 'run';
    if (this.ranOn) io.player.setRunOn(true);
    io.player.seek(0);
    io.player.play();
    this.stops.push(
      () => follow.dispose(),
      this.env.every(500, () => this.store.set((s) => (s.phase === 'recording' ? { ...s, seconds: this.rec.elapsed } : s))),
    );
    this.store.set(() => ({ phase: 'recording', nodeId, seconds: 0 }));
    if (settings.sound && !io.stream.audioStream()) ed.toast('Recording without sound: no sound is running. Press Enable audio and record again to include it.', 'info');
  }

  /** Stop and save. `note` is shown instead of the usual message (a limit was reached); `error` when the recording broke. */
  private finish(note: string | null, error?: Error): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.store.get().phase !== 'recording') return Promise.resolve();
    const run = async () => {
      this.store.set((s) => ({ ...s, phase: 'saving' }));
      this.io.player.pause();
      if (this.ranOn) this.io.player.setRunOn(false);
      try {
        const take = await this.rec.stop();
        const [asset] = await this.io.library.add([new File([take.blob], take.name, { type: take.blob.type })]);
        if (!asset) throw new Error('The clip could not be added to Media.');
        this.ed.toast(note ?? `Saved to Media: ${take.name} (${formatElapsed(take.seconds)}${take.hasAudio ? ', with sound' : ', picture only'}).`, 'ok');
      } catch (err) {
        this.ed.toast(`The recording was not saved: ${(error ?? (err instanceof Error ? err : new Error(String(err)))).message}`, 'error');
      }
      for (const off of this.stops.splice(0)) off();
      this.store.set(() => ({ phase: 'idle', nodeId: null, seconds: 0 }));
      this.finishing = null;
    };
    this.finishing = run();
    return this.finishing;
  }

  /** Stop from outside (the node was deleted, the project closed). */
  stop(): Promise<void> {
    return this.finish(null);
  }
}
