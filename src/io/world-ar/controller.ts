/**
 * `io.worldAr`: opens the World AR view (a WebXR `immersive-ar` session) and ties the pieces together: the session, the WebGL
 * painter, the node graph that renders the object's picture, the placement loop and the recorder.
 *
 * EXPERIMENTAL AND UNTESTED ON A REAL AR DEVICE. Everything except this file's few lines of browser calls runs in the tests against
 * a fake session; this file was only run in desktop Chromium, where no AR session can start.
 *
 * Rules kept here:
 *  - Nothing is asked of the browser before `open()`, which must be called straight from a button press. `support()` only asks
 *    whether AR exists, which shows nothing and needs no permission.
 *  - Every extra (surfaces, anchors, the on-screen buttons, the camera picture) is asked for as OPTIONAL, so the view still starts on
 *    a device that lacks some of them, and each is used only when the session says it was granted.
 *  - Nothing leaves the device: poses and the camera clip go into the project and its Media library, like any other recording.
 */
import type { Registry } from '../../engine/define';
import type { EvalRequest, EvalResult } from '../../engine/engine';
import type { Gpu } from '../../engine/gpu/gpu';
import type { Quat, Vec3 } from '../../engine/lib/motion-math';
import { buildWorldTake, type WorldTake } from '../../engine/lib/world-take';
import type { CardMode } from '../../engine/lib/xr-math';
import type { AssetInfo, GraphDoc } from '../../engine/types';
import { LiveRecorder } from '../live-record';
import type { ArCameraFeed } from './camera-feed';
import { EnginePictureSource, fedByWorldAr, probeCanvasCopy, type CopyRoute, type PictureTarget } from './engine-source';
import { ArLoop, type ArClipRecorder, type ArLoopState, type ArPainter } from './loop';
import { GlPainter, createXrGl, type CameraBinding } from './painter';
import type { Gesture } from './placement';
import { browserSupportEnv, checkWorldAr, startErrorMessage, type WorldArSupport } from './support';
import { OPTIONAL_FEATURES, featuresOf, type GrantedFeatures, type XrLayerLike, type XrSessionLike, type XrSystemLike } from './xr-api';

/** Longest side of the object's picture. A modest size: it is copied from WebGPU into WebGL for every picture. */
export const PICTURE_MAX_SIDE = 960;

export interface WorldArOpen {
  /** The project's graph as it is now (asked again for every picture, so edits made before opening and takes saved meanwhile count). */
  graph(): GraphDoc;
  /** The node whose picture is shown in the room. */
  node: string;
  port?: string;
  /** How a flat picture stands in the room (ignored when the picture comes through a World AR Camera). */
  card: { mode: CardMode; width: number };
  /** The element shown over the camera picture (buttons, hint). It must be in the document. */
  overlay: HTMLElement | null;
  onState(state: WorldArViewState): void;
  /** A recording was saved: the take, and the camera clip when the session handed the camera picture over. */
  onTake(take: WorldArTake): void;
}

export interface WorldArTake {
  take: WorldTake | null;
  clip: AssetInfo | null;
  seconds: number;
  /** A sentence when something went wrong (the take or the clip may still be there). */
  error: string | null;
}

export interface WorldArViewState extends ArLoopState {
  features: GrantedFeatures;
  /** 'layer' = the object through the World AR Camera; 'card' = a flat picture. */
  showing: 'layer' | 'card';
  /** How the picture gets from WebGPU into WebGL on this device, and what the last one cost in milliseconds. */
  route: CopyRoute;
  renderMs: number;
  copyMs: number;
  /** Pixel size of the newest picture of the object, or null before the first. */
  picture: { width: number; height: number } | null;
  /** Saving a recording. */
  saving: boolean;
}

export interface WorldArHandle {
  place(): void;
  reset(): void;
  gesture(g: Gesture): void;
  /** Start recording, or stop and save. */
  toggleRecord(): void;
  /** Leave the AR view (a running recording is saved first). */
  close(): Promise<void>;
  /** Resolves when the view has closed, with the sentence to show if it closed because of an error. */
  readonly closed: Promise<{ error: string | null }>;
  state(): WorldArViewState;
}

export interface WorldArApi {
  /** Can this device do it? Asks the browser only whether AR exists. */
  support(): Promise<WorldArSupport>;
  /** Open the view. Call straight from the button press. Rejects with a sentence for the user. */
  open(o: WorldArOpen): Promise<WorldArHandle>;
  readonly active: WorldArHandle | null;
}

export interface WorldArDeps {
  gpu: Gpu;
  gate: { evaluateHeld(req: EvalRequest): Promise<EvalResult>; drop(res: EvalResult): void };
  registry: Registry;
  /** The Media library's ordinary import. */
  add(files: File[]): Promise<AssetInfo[]>;
  /** Stops the normal viewer from rendering while the AR view is open (both would compete for the same engine). */
  holdPlayer(): () => void;
  /** Release the device cameras and keep them closed (true), or let them come back (false). The AR system owns the camera meanwhile. */
  suspendCameras?(on: boolean): void;
  /** Where the World AR Camera's Picture output gets the camera frame while the view is open. */
  cameraFeed?: ArCameraFeed;
}

/** The handful of browser calls, so tests and the desktop self-check can put a fake in their place. */
export interface WorldArEnv {
  xr: XrSystemLike | null;
  /** A WebGL context the session can draw with, and what paints with it. */
  makePainter(session: XrSessionLike, features: GrantedFeatures, onLost?: () => void): Promise<{ painter: ArPainter & PictureTarget; layer: XrLayerLike; dispose(): void }>;
  makeTransform?: (p: Vec3, q: Quat) => unknown;
  /** A WebGPU canvas for the 'canvas' copy route, or null where there is none. */
  makeGpuCanvas(gpu: Gpu): { el: HTMLCanvasElement | OffscreenCanvas; ctx: GPUCanvasContext } | null;
  /**
   * Does copying that WebGPU canvas into a WebGL texture deliver the picture on this device? Tried on a throwaway WebGL context,
   * never on the session's own: where the two renderers do not share memory the attempt can cost the context (seen in headless
   * desktop Chromium), and losing the session's context would end the AR view.
   */
  canvasCopyWorks(gpu: Gpu, canvas: { el: HTMLCanvasElement | OffscreenCanvas; ctx: GPUCanvasContext }): boolean;
  makeRecorder(): LiveRecorder | null;
  now(): number;
}

type XrGlobals = {
  XRWebGLLayer?: new (session: unknown, gl: unknown) => XrLayerLike;
  XRWebGLBinding?: new (session: unknown, gl: unknown) => CameraBinding;
  XRRigidTransform?: new (p: { x: number; y: number; z: number; w: number }, q: { x: number; y: number; z: number; w: number }) => unknown;
};

/**
 * Set when the session's own WebGL context was lost while pictures went through the canvas route: the next AR view on this page
 * reads pixels back instead, whatever the probe says.
 */
let canvasCopyBroken = false;

export function browserWorldArEnv(): WorldArEnv {
  const g = (typeof window === 'undefined' ? {} : window) as unknown as XrGlobals;
  return {
    xr: browserSupportEnv().xr,
    async makePainter(session, features, onLost) {
      const canvas = document.createElement('canvas');
      const gl = createXrGl(canvas);
      if (!gl || !g.XRWebGLLayer) throw new Error('This browser could not make a WebGL view for AR.');
      // already asked for at creation; older browsers want it said again, and it is harmless where it is not needed
      await (gl as unknown as { makeXRCompatible?: () => Promise<void> }).makeXRCompatible?.();
      const layer = new g.XRWebGLLayer(session, gl);
      await session.updateRenderState({ baseLayer: layer });
      const painter = new GlPainter(gl);
      // a lost context cannot be drawn into again: the view closes with the reason instead of showing a frozen or empty picture
      canvas.addEventListener('webglcontextlost', () => onLost?.());
      if (features.cameraAccess && g.XRWebGLBinding) {
        try {
          painter.binding = new g.XRWebGLBinding(session, gl);
        } catch {
          painter.binding = null; // granted on paper only: the take is motion only
        }
      }
      return { painter, layer, dispose: () => painter.dispose() };
    },
    makeTransform: g.XRRigidTransform ? (p, q) => new g.XRRigidTransform!({ x: p[0], y: p[1], z: p[2], w: 1 }, { x: q[0], y: q[1], z: q[2], w: q[3] }) : undefined,
    makeGpuCanvas(gpu) {
      try {
        const el = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
        const ctx = el.getContext('webgpu') as unknown as GPUCanvasContext | null;
        if (!ctx) return null;
        ctx.configure({ device: gpu.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
        return { el, ctx };
      } catch {
        return null;
      }
    },
    canvasCopyWorks(gpu, canvas) {
      if (canvasCopyBroken) return false;
      let painter: GlPainter | null = null;
      try {
        const gl = document.createElement('canvas').getContext('webgl2', { alpha: true, premultipliedAlpha: true }) ?? null;
        if (!gl) return false;
        painter = new GlPainter(gl);
        const ok = probeCanvasCopy(gpu, canvas, painter) && !gl.isContextLost();
        painter.dispose();
        gl.getExtension('WEBGL_lose_context')?.loseContext(); // give the throwaway context back right away
        return ok;
      } catch {
        return false;
      }
    },
    makeRecorder: () => (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' ? null : new LiveRecorder()),
    now: () => performance.now(),
  };
}

export class WorldArController implements WorldArApi {
  private current: WorldArHandle | null = null;

  constructor(
    private d: WorldArDeps,
    private env: WorldArEnv = browserWorldArEnv(),
  ) {}

  get active(): WorldArHandle | null {
    return this.current;
  }

  support(): Promise<WorldArSupport> {
    return checkWorldAr({ ...browserSupportEnv(), xr: this.env.xr });
  }

  /** Developer check for a browser without AR (see self-check.ts). Loaded only when called. */
  async selfCheck(graph: GraphDoc, node: string): Promise<unknown> {
    return (await import('./self-check')).runSelfCheck(this.d, graph, node);
  }

  async open(o: WorldArOpen): Promise<WorldArHandle> {
    if (this.current) throw new Error('The AR view is already open.');
    const env = this.env;
    if (!env.xr) throw new Error(startErrorMessage({ name: 'NotSupportedError' }));
    // FIRST thing after the press: browsers only start a session while the press still counts. Letting go of the app's own camera
    // is synchronous, so the press still counts; an open camera stream can make the AR session fail or stutter.
    const cams = this.d.suspendCameras?.bind(this.d);
    cams?.(true);
    let session: XrSessionLike;
    const asked = OPTIONAL_FEATURES.filter((f) => f !== 'dom-overlay' || !!o.overlay);
    try {
      session = await env.xr.requestSession('immersive-ar', { optionalFeatures: [...asked], ...(o.overlay ? { domOverlay: { root: o.overlay } } : {}) });
    } catch (err) {
      cams?.(false);
      throw new Error(startErrorMessage(err));
    }
    let release: (() => void) | null = null;
    let disposePainter: (() => void) | null = null;
    try {
      const features = featuresOf(session, asked);
      let lost: () => void = () => undefined;
      const made = await env.makePainter(session, features, () => lost());
      disposePainter = made.dispose;
      this.d.cameraFeed?.begin(features.cameraAccess);
      const referenceSpace = await session.requestReferenceSpace('local');
      let hitTestSource: unknown = null;
      if (features.hitTest && session.requestHitTestSource) {
        try {
          hitTestSource = (await session.requestHitTestSource({ space: await session.requestReferenceSpace('viewer') })) ?? null;
        } catch {
          hitTestSource = null; // no surfaces: nothing can be placed; the hint keeps asking to find one, see `noSurfaces` below
        }
      }
      const graph0 = o.graph();
      const layerMode = fedByWorldAr(graph0, o.node);
      const gpuCanvas = env.makeGpuCanvas(this.d.gpu);
      const route: CopyRoute = gpuCanvas && env.canvasCopyWorks(this.d.gpu, gpuCanvas) ? 'canvas' : 'pixels';
      const fps = graph0.project.fps;
      const startedAt = env.now();
      const source = new EnginePictureSource({
        gate: this.d.gate,
        gpu: this.d.gpu,
        registry: this.d.registry,
        graph: o.graph,
        node: o.node,
        port: o.port,
        target: made.painter,
        route,
        canvas: gpuCanvas ?? undefined,
        viewSized: layerMode,
        maxSide: PICTURE_MAX_SIDE,
        now: env.now,
        // a flat picture does not depend on the pose: one picture per project frame is all there is to show
        minInterval: layerMode ? 0 : 1000 / Math.max(1, fps),
      });
      let saving = false;
      let recorder: LiveRecorder | null = null;
      let lastLoop: ArLoopState | null = null;
      const view = (s: ArLoopState): WorldArViewState => ({
        ...s,
        hint: !hitTestSource && s.phase !== 'placed' ? 'This device does not tell the page where surfaces are, so nothing can be placed here.' : s.hint,
        features,
        showing: layerMode ? 'layer' : 'card',
        route: source.route,
        renderMs: Math.round(source.timing.render),
        copyMs: Math.round(source.timing.copy),
        picture: source.latest() ? { width: source.latest()!.width, height: source.latest()!.height } : null,
        saving,
      });
      const emit = () => {
        if (lastLoop) o.onState(view(lastLoop));
      };
      const loop = new ArLoop({
        session,
        referenceSpace,
        hitTestSource,
        layer: made.layer,
        features,
        painter: made.painter,
        cameraFeed: this.d.cameraFeed,
        source,
        show: layerMode ? { kind: 'layer' } : { kind: 'card', mode: o.card.mode, width: o.card.width },
        maxSide: PICTURE_MAX_SIDE,
        seconds: () => {
          const dur = Math.max(1 / fps, o.graph().project.duration);
          return ((env.now() - startedAt) / 1000) % dur;
        },
        now: env.now,
        makeTransform: env.makeTransform,
        screen: () => ({ width: o.overlay?.clientWidth || made.layer.framebufferWidth, height: o.overlay?.clientHeight || made.layer.framebufferHeight }),
        onState: (s) => {
          const was = lastLoop;
          lastLoop = s;
          o.onState(view(s));
          if (s.ended && !was?.ended) void ended(s.error);
        },
      });

      const stopAndSave = async (): Promise<void> => {
        const rec = loop.stopRecording();
        if (!rec) return;
        saving = true;
        emit();
        const out: WorldArTake = { take: null, clip: null, seconds: 0, error: null };
        try {
          out.take = buildWorldTake(rec.samples, { fps });
          if (!out.take) out.error = 'Nothing was recorded: the recording was too short.';
          else out.seconds = out.take.frames / out.take.fps;
          if (recorder && recorder.state === 'recording') {
            if (rec.withClip && out.take) {
              const clip = await recorder.stop();
              const [asset] = await this.d.add([new File([clip.blob], clip.name, { type: clip.blob.type })]);
              out.clip = asset ?? null;
              if (!asset) out.error = 'The camera clip could not be added to Media. The movement was kept.';
            } else await recorder.cancel();
          }
        } catch (err) {
          out.error = `The camera clip could not be saved (${err instanceof Error ? err.message : String(err)}). The movement was kept.`;
        }
        recorder = null;
        saving = false;
        emit();
        o.onTake(out);
      };

      let resolveClosed: (v: { error: string | null }) => void = () => undefined;
      const closed = new Promise<{ error: string | null }>((r) => (resolveClosed = r));
      let finished = false;
      const ended = async (error: string | null): Promise<void> => {
        if (finished) return;
        finished = true;
        // the session is gone (Exit, the Back button, or the system took it): keep what was being recorded
        await stopAndSave().catch(() => undefined);
        source.dispose();
        disposePainter?.();
        this.d.cameraFeed?.end();
        release?.();
        cams?.(false);
        this.current = null;
        resolveClosed({ error });
      };

      const handle: WorldArHandle = {
        place: () => loop.placeHere(),
        reset: () => loop.reset(),
        gesture: (g) => loop.gesture(g),
        toggleRecord: () => {
          if (saving) return;
          if (loop.isRecording) {
            void stopAndSave();
            return;
          }
          let clip: ArClipRecorder | null = null;
          if (features.cameraAccess && made.painter.camera) {
            recorder = env.makeRecorder();
            try {
              recorder?.start(() => null, { fps, label: 'AR', manual: true, maxSide: 1280 });
            } catch {
              recorder = null; // no video encoder here: the take is motion only
            }
            const r = recorder;
            if (r) {
              // a limit or an encoder error ends the take the way Stop does: what was recorded is saved
              r.onAutoStop = () => void stopAndSave();
              clip = { push: (picture) => r.push(picture as CanvasImageSource) };
            }
          }
          loop.startRecording(clip);
        },
        close: async () => {
          await stopAndSave().catch(() => undefined);
          loop.stop();
          try {
            await session.end();
          } catch {
            /* already ended */
          }
          await ended(null);
        },
        closed,
        state: () => view(lastLoop ?? loop.state()),
      };
      lost = () => {
        if (source.route === 'canvas') canvasCopyBroken = true;
        loop.stop();
        void session.end().catch(() => undefined);
        void ended('The AR view lost its drawing surface and had to close. Open it again: it will use a slower but safer way to show the picture.');
      };
      release = this.d.holdPlayer();
      this.current = handle;
      loop.start();
      return handle;
    } catch (err) {
      disposePainter?.();
      this.d.cameraFeed?.end();
      release?.();
      cams?.(false);
      this.current = null;
      try {
        await session.end();
      } catch {
        /* already ended */
      }
      throw new Error(startErrorMessage(err));
    }
  }
}
