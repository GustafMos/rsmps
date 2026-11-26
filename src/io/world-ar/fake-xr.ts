/**
 * A fake WebXR AR session, written to the same shapes as the real one (xr-api.ts). No AR device can run in the test environment, so
 * the World AR view is developed against this: the tests set where the phone is, what surface it sees and which features were
 * granted, then step camera frames by hand. It is also what the app's hidden self-check uses in a desktop browser
 * (`io.worldAr.selfCheck`), where the real painter and the real engine run against it.
 *
 * It only imitates what the specifications say; it cannot show how a real phone behaves (timing, tracking quality, the camera
 * picture). Passing against the fake means the logic is right, not that the feature works on hardware.
 */
import type { Quat, Vec3 } from '../../engine/lib/motion-math';
import { projectionMatrix, type Lens, type XrPose } from '../../engine/lib/xr-math';
import type { XrAnchorLike, XrFrameCallback, XrFrameLike, XrHitTestResultLike, XrLayerLike, XrRigidTransform, XrSessionLike, XrSystemLike, XrViewLike } from './xr-api';

const transformOf = (pose: XrPose): XrRigidTransform => ({
  position: { x: pose.p[0], y: pose.p[1], z: pose.p[2], w: 1 },
  orientation: { x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] },
});

export interface FakeAnchor extends XrAnchorLike {
  pose: XrPose;
  deleted: boolean;
  /** False = the device lost it for now: it is left out of `trackedAnchors`. */
  tracked: boolean;
}

export interface FakeSessionOptions {
  /** Features the "browser" grants. Default: all four. */
  features?: string[];
  /** Report the granted features through `enabledFeatures` (newer Chrome) or not at all (older). */
  reportFeatures?: boolean;
  lens?: Lens;
  width?: number;
  height?: number;
  /** What the layer hands out as its framebuffer (default: a marker object; the desktop self-check passes a real WebGL one). */
  framebuffer?: unknown;
}

export class FakeXrSession implements XrSessionLike {
  enabledFeatures?: string[];
  domOverlayState: { type: string } | null = null;
  visibilityState = 'visible';
  /** Where the phone is. null = the room is lost (no viewer pose). */
  viewer: XrPose | null = { p: [0, 1.4, 0], q: [0, 0, 0, 1] };
  /** The device only knows how it is turned. */
  emulatedPosition = false;
  lens: Lens;
  /** The surface in the middle of the screen, or null. */
  hit: XrPose | null = null;
  /** Size of the camera picture offered through camera access, or null. */
  camera: { width: number; height: number } | null = null;
  readonly anchors: FakeAnchor[] = [];
  /** Make the next anchor requests fail (a device that grants anchors and then cannot make one). */
  failAnchors = false;
  /** Throw from `getViewerPose` (to test the loop's handling of a frame that goes wrong). */
  throwInFrame: Error | null = null;
  ended = false;
  baseLayer: unknown = null;
  readonly granted: string[];
  readonly layer: XrLayerLike;
  time = 0;
  frames = 0;
  private callbacks = new Map<number, XrFrameCallback>();
  private nextHandle = 1;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(o: FakeSessionOptions = {}) {
    this.granted = o.features ?? ['hit-test', 'anchors', 'dom-overlay', 'camera-access'];
    if (o.reportFeatures !== false) this.enabledFeatures = ['viewer', 'local', ...this.granted];
    this.lens = o.lens ?? [1.9, 1.07, 0, 0];
    const width = o.width ?? 1080;
    const height = o.height ?? 1920;
    this.layer = { framebuffer: 'framebuffer' in o ? o.framebuffer : { fake: 'xr-framebuffer' }, framebufferWidth: width, framebufferHeight: height, getViewport: () => ({ x: 0, y: 0, width, height }) };
    if (this.granted.includes('dom-overlay')) this.domOverlayState = { type: 'screen' };
    if (!this.granted.includes('hit-test')) this.requestHitTestSource = undefined;
  }

  requestReferenceSpace(type: string): Promise<unknown> {
    return Promise.resolve({ space: type });
  }
  requestAnimationFrame(cb: XrFrameCallback): number {
    const h = this.nextHandle++;
    this.callbacks.set(h, cb);
    return h;
  }
  cancelAnimationFrame(handle: number): void {
    this.callbacks.delete(handle);
  }
  updateRenderState(state: { baseLayer?: unknown }): void {
    this.baseLayer = state.baseLayer ?? null;
  }
  requestHitTestSource?: (options: { space: unknown }) => Promise<{ cancel(): void }> = () => Promise.resolve({ cancel: () => undefined });
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  /** Fire a session event (`select`, `visibilitychange`, ...). */
  emit(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb({ type });
  }
  end(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.callbacks.clear();
      this.emit('end');
    }
    return Promise.resolve();
  }
  /** The system ended the session (the user pressed Back). */
  systemEnd(): void {
    void this.end();
  }

  private makeAnchor(pose: XrPose): Promise<XrAnchorLike> {
    if (this.failAnchors) return Promise.reject(new Error('anchor failed'));
    const a: FakeAnchor = {
      pose,
      deleted: false,
      tracked: true,
      anchorSpace: null,
      delete: () => {
        a.deleted = true;
      },
    };
    a.anchorSpace = { anchor: a };
    this.anchors.push(a);
    return Promise.resolve(a);
  }

  private frameNow(): XrFrameLike {
    const view: XrViewLike | null = this.viewer ? { transform: transformOf(this.viewer), projectionMatrix: projectionMatrix(this.lens), camera: this.granted.includes('camera-access') ? this.camera : undefined } : null;
    const anchorsOn = this.granted.includes('anchors');
    const hitResult: XrHitTestResultLike | null = this.hit
      ? { getPose: () => ({ transform: transformOf(this.hit!) }), ...(anchorsOn ? { createAnchor: () => this.makeAnchor(this.hit!) } : {}) }
      : null;
    return {
      getViewerPose: () => {
        if (this.throwInFrame) throw this.throwInFrame;
        return view ? { transform: view.transform, views: [view], emulatedPosition: this.emulatedPosition } : null;
      },
      getPose: (space) => {
        const a = (space as { anchor?: FakeAnchor } | null)?.anchor;
        if (!a) return null;
        if (a.deleted) throw new Error('InvalidStateError: the anchor was deleted');
        return { transform: transformOf(a.pose) };
      },
      getHitTestResults: () => (hitResult ? [hitResult] : []),
      ...(anchorsOn
        ? {
            trackedAnchors: { has: (x: XrAnchorLike) => this.anchors.includes(x as FakeAnchor) && (x as FakeAnchor).tracked && !(x as FakeAnchor).deleted },
            createAnchor: (pose: unknown) => this.makeAnchor(pose as XrPose),
          }
        : {}),
    };
  }

  /** Run one camera frame: every callback asked for since the last one. Returns how many ran. */
  step(ms = 33): number {
    if (this.ended) return 0;
    this.time += ms;
    this.frames++;
    const run = [...this.callbacks.values()];
    this.callbacks.clear();
    const frame = this.frameNow();
    for (const cb of run) cb(this.time, frame);
    return run.length;
  }
}

/** `new XRRigidTransform(...)` for the fake: the pose itself. */
export const fakeTransform = (p: Vec3, q: Quat): unknown => ({ p, q });

export class FakeXrSystem implements XrSystemLike {
  supported = true;
  /** Make `requestSession` fail with this (a DOMException-like object with a `name`). */
  failWith: unknown = null;
  /** Make `isSessionSupported` throw. */
  throwOnAsk = false;
  session: FakeXrSession | null = null;
  lastInit: { requiredFeatures?: string[]; optionalFeatures?: string[]; domOverlay?: { root: unknown } } | null = null;
  asked = 0;
  /** Called with every session made (to set where the phone is before its first frame). */
  onSession: ((s: FakeXrSession) => void) | null = null;
  constructor(private options: FakeSessionOptions = {}) {}
  isSessionSupported(mode: string): Promise<boolean> {
    this.asked++;
    if (this.throwOnAsk) return Promise.reject(new Error('blocked'));
    return Promise.resolve(this.supported && mode === 'immersive-ar');
  }
  requestSession(_mode: string, init?: { requiredFeatures?: string[]; optionalFeatures?: string[]; domOverlay?: { root: unknown } }): Promise<XrSessionLike> {
    this.lastInit = init ?? null;
    if (this.failWith) return Promise.reject(this.failWith);
    // the browser grants what was asked for AND what it has
    const wanted = init?.optionalFeatures ?? [];
    const has = this.options.features ?? ['hit-test', 'anchors', 'dom-overlay', 'camera-access'];
    this.session = new FakeXrSession({ ...this.options, features: has.filter((f) => wanted.includes(f) && (f !== 'dom-overlay' || !!init?.domOverlay)) });
    this.onSession?.(this.session);
    return Promise.resolve(this.session);
  }
}
