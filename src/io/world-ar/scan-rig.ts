/**
 * The 3D scan view WITHOUT the rest of the app: the same AR session, loop, painter and scan session as the World AR view's scan mode
 * (controller.ts), but with nothing that renders the node graph. This is what the phone page loads for "3D scan with a linked phone":
 * the phone does not run the editor, so the controller (which pulls in the engine, the GPU code and the recorder) must not be imported
 * there. Types come from controller.ts (erased at build time); every value import below is light.
 *
 * It differs from the controller's scan path in three ways only: no picture source (the scan view never had one), the photos are handed
 * on one by one as they are kept (`onKeep`, with optional `hold` for back-pressure) instead of being added to Media at the end, and the
 * end-of-scan result goes to `onEnd` (no Media on the phone).
 */
import type { Quat, Vec3 } from '../../engine/lib/motion-math';
import type { QualitySummary } from '../../engine/lib/scan-coverage';
import type { ScanData, ScanShot } from '../../engine/lib/scan-data';
import type { ScanControls, WorldArHandle, WorldArViewState } from './controller';
import { ArLoop, type ArLoopState, type ArPainter, type ArPictureSource } from './loop';
import { browserScanEnv } from './scan-grab';
import { ScanSession, type ScanEnv } from './scan-session';
import { browserSupportEnv, checkWorldAr, noCameraPictureMessage, startErrorMessage, type WorldArSupport } from './support';
import { DEPTH_INIT, SCAN_FEATURES, depthGranted, featuresOf, type GrantedFeatures, type XrLayerLike, type XrSessionLike, type XrSystemLike } from './xr-api';

/** The browser calls the scan view needs; tests put a fake in their place (see fake-xr.ts). */
export interface ScanRigEnv {
  xr: XrSystemLike | null;
  makePainter(session: XrSessionLike, features: GrantedFeatures, onLost?: () => void): Promise<{ painter: ArPainter; layer: XrLayerLike; dispose(): void }>;
  makeTransform?: (p: Vec3, q: Quat) => unknown;
  makeScanEnv?: () => ScanEnv;
  now(): number;
  /** Is this page a secure context, and the rest of what support.ts asks; absent = the browser's. */
  support?: () => Promise<WorldArSupport>;
}

export interface ScanRigOpen {
  /** The element shown over the camera picture (buttons, hint). It must be in the document. */
  overlay: HTMLElement | null;
  auto?: boolean;
  onState(state: WorldArViewState): void;
  /** A photo was kept (in order). With `keepBlobs: false` the session does not hold on to it. */
  onKeep?(shot: ScanShot, blob: Blob, index: number): void;
  keepBlobs?: boolean;
  /** True = take no new photo now (back-pressure from the link). */
  hold?(encoding: number): boolean;
  /** The view closed (Done, the Back button, or the system took the session). */
  onEnd(r: ScanRigResult): void;
}

/** The view's handle plus the dome's header once the walk has started (the phone page sends it on). */
export type ScanRigHandle = WorldArHandle & { header(): Pick<ScanData, 'v' | 'units' | 'target' | 'grid'> | null };

export interface ScanRigResult {
  scan: ScanData | null;
  summary: QualitySummary | null;
  rejected: number;
  depth: boolean;
  /** The photos still held by the session (empty when `keepBlobs` was false). */
  blobs: Blob[];
  error: string | null;
}

/** A picture source that never has a picture: the scan view renders nothing of the graph. */
const noPictures: ArPictureSource = { request: () => false, latest: () => null, error: () => null };

export function browserScanRigEnv(makePainter: ScanRigEnv['makePainter']): ScanRigEnv {
  const g = (typeof window === 'undefined' ? {} : window) as unknown as { XRRigidTransform?: new (p: { x: number; y: number; z: number; w: number }, q: { x: number; y: number; z: number; w: number }) => unknown };
  return {
    xr: browserSupportEnv().xr,
    makePainter,
    makeTransform: g.XRRigidTransform ? (p, q) => new g.XRRigidTransform!({ x: p[0], y: p[1], z: p[2], w: 1 }, { x: q[0], y: q[1], z: q[2], w: q[3] }) : undefined,
    now: () => performance.now(),
  };
}

export class ScanRig {
  private current: ScanRigHandle | null = null;

  constructor(private env: ScanRigEnv) {}

  get active(): ScanRigHandle | null {
    return this.current;
  }

  /** Can this device do AR? Never throws, asks for no permission. The words are support.ts's. */
  support(): Promise<WorldArSupport> {
    return this.env.support ? this.env.support() : checkWorldAr({ ...browserSupportEnv(), xr: this.env.xr });
  }

  /** Open the scan view. Call straight from a button press. Rejects with a sentence for the user. */
  async open(o: ScanRigOpen): Promise<ScanRigHandle> {
    if (this.current) throw new Error('The AR view is already open.');
    const env = this.env;
    if (!env.xr) throw new Error(startErrorMessage({ name: 'NotSupportedError' }));
    const asked = SCAN_FEATURES.filter((f) => f !== 'dom-overlay' || !!o.overlay);
    let session: XrSessionLike;
    try {
      session = await env.xr.requestSession('immersive-ar', { optionalFeatures: [...asked], ...(o.overlay ? { domOverlay: { root: o.overlay } } : {}), depthSensing: DEPTH_INIT });
    } catch (err) {
      throw new Error(startErrorMessage(err));
    }
    let disposePainter: (() => void) | null = null;
    try {
      const features = featuresOf(session, asked);
      if (!features.cameraAccess) throw new Error(noCameraPictureMessage);
      let lost: () => void = () => undefined;
      const made = await env.makePainter(session, features, () => lost());
      disposePainter = made.dispose;
      const referenceSpace = await session.requestReferenceSpace('local');
      let hitTestSource: unknown = null;
      if (features.hitTest && session.requestHitTestSource) {
        try {
          hitTestSource = (await session.requestHitTestSource({ space: await session.requestReferenceSpace('viewer') })) ?? null;
        } catch {
          hitTestSource = null; // no surfaces: nothing can be placed
        }
      }
      let saving = false;
      let lastLoop: ArLoopState | null = null;
      const scanSession = new ScanSession({ env: env.makeScanEnv?.() ?? browserScanEnv(), depth: depthGranted(session), auto: o.auto, onKeep: o.onKeep, keepBlobs: o.keepBlobs, hold: o.hold });
      const view = (s: ArLoopState): WorldArViewState => ({
        ...s,
        hint: !hitTestSource && s.phase !== 'placed' ? 'This device does not tell the page where surfaces are, so nothing can be placed here.' : s.hint,
        features,
        showing: 'card',
        route: 'pixels',
        renderMs: 0,
        copyMs: 0,
        picture: null,
        saving,
      });
      const emit = () => {
        if (lastLoop) o.onState(view(lastLoop));
      };
      const loop = new ArLoop({
        scan: scanSession,
        session,
        referenceSpace,
        hitTestSource,
        layer: made.layer,
        features,
        painter: made.painter,
        source: noPictures,
        show: { kind: 'card', mode: 'upright', width: 0.5 },
        maxSide: 960,
        seconds: () => 0,
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

      let resolveClosed: (v: { error: string | null }) => void = () => undefined;
      const closed = new Promise<{ error: string | null }>((r) => (resolveClosed = r));
      let saved: Promise<void> | null = null;
      // waits for the photos still being encoded, so nothing taken just before Done or the Back button is lost
      const save = (): Promise<void> =>
        (saved ??= (async () => {
          saving = true;
          emit();
          const out: ScanRigResult = { scan: null, summary: null, rejected: 0, depth: scanSession.state().depth, blobs: [], error: null };
          try {
            const res = await scanSession.finish();
            out.scan = res.scan.shots.length ? res.scan : null;
            out.summary = res.summary;
            out.rejected = res.rejected;
            out.blobs = res.blobs;
            if (!res.scan.shots.length) out.error = 'No photos were taken, so nothing was saved.';
          } catch (err) {
            out.error = `The scan could not be finished (${err instanceof Error ? err.message : String(err)}).`;
          }
          saving = false;
          emit();
          o.onEnd(out);
        })());
      let endedOnce: Promise<void> | null = null;
      const ended = (error: string | null): Promise<void> => (endedOnce ??= finishEnded(error));
      const finishEnded = async (error: string | null): Promise<void> => {
        await save().catch(() => undefined);
        disposePainter?.();
        this.current = null;
        resolveClosed({ error });
      };
      const controls: ScanControls = { begin: () => loop.scanBegin(), shutter: () => scanSession.shutter(), setAuto: (on) => scanSession.setAuto(on) };
      const handle: ScanRigHandle = {
        scan: controls,
        header: () => scanSession.header(),
        place: () => loop.placeHere(),
        restartPhysics: () => undefined,
        setMoveMode: () => undefined,
        reset: () => loop.reset(),
        gesture: (g) => loop.gesture(g),
        toggleRecord: () => undefined, // no recording in the scan view
        close: async () => {
          await save().catch(() => undefined);
          loop.stop();
          try {
            await session.end();
          } catch {
            /* already ended */
          }
          await ended(null);
        },
        closed,
        state: () => view(loop.state()),
      };
      lost = () => {
        loop.stop();
        void session.end().catch(() => undefined);
        void ended('The AR view lost its drawing surface and had to close. Open it again.');
      };
      this.current = handle;
      loop.start();
      return handle;
    } catch (err) {
      disposePainter?.();
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
