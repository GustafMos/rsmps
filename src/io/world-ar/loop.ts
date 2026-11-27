/**
 * The World AR view's frame loop: everything that happens once per camera frame of an AR session, with every outside thing passed
 * in (the WebXR session, the WebGL painter, the engine that renders the picture, the recorder). So the tests run all of it against a
 * fake session (fake-xr.ts) with plain numbers; only painter.ts and controller.ts touch a real browser.
 *
 * Per frame, in this order:
 *  1. where is the phone (the viewer pose); none = the room is lost, nothing is drawn;
 *  2. what surface is in the middle of the screen (hit test) and where has the browser moved the anchor to;
 *  3. what did the user do since the last frame (taps, drags, twists, buttons);
 *  4. draw: the ring while aiming; once placed, the newest picture of the object, hung in the room where it belongs;
 *  5. ask the engine for the next picture, for THIS frame's pose;
 *  6. while recording: note this frame's pose (and hand the camera picture to the clip recorder).
 *
 * The picture of the object is rendered by the node graph (WebGPU) and takes a frame or two to arrive, by which time the phone has
 * moved. It is therefore not glued to the screen but hung in the room as a rectangle that fills the lens it was rendered for, at the
 * object's distance (xr-math `layerCorners`): turning the phone keeps the object exactly in place, and walking keeps its middle in
 * place while its perspective is a frame or two old.
 */
import { qConj, qExp, qLog, qMul, qNorm, type Quat, type Vec3 } from '../../engine/lib/motion-math';
import { FEED_MAX_SIDE } from './camera-feed';
import type { WorldMoment, WorldSample } from '../../engine/lib/world-take';
import { readLightEstimate, smoothLight, type WorldLight } from '../../engine/lib/xr-light';
import { cardCorners, clampZoom, depthOf, layerCorners, lensAspect, lensOf, mat4Mul, placementQuat, poseInv, poseMul, rayPlane, reticleCorners, viewMatrix, viewRay, zoomLens, zoomProjection, type CardMode, type Corners, type Lens, type Placement, type XrPose } from '../../engine/lib/xr-math';
import { rotate } from '../../engine/lib/motion-math';
import { hintFor, initialPlaceState, liftedPlacement, placeStep, type Gesture, type PlaceState } from './placement';
import { SCAN_MAX_SIDE, type DepthMap } from '../../engine/lib/scan-data';
import { DEFAULT_RADIUS } from '../../engine/lib/scan-data';
import { RADIUS_PER_PIXEL, type ScanGrab, type ScanSession, type ScanViewState } from './scan-session';
import type { GrantedFeatures, XrAnchorLike, XrCpuDepthLike, XrFrameLike, XrHitTestResultLike, XrLayerLike, XrRigidTransform, XrSessionLike, XrViewLike, XrViewportLike } from './xr-api';

/** What draws into the AR view (WebGL in the app, a recorder of calls in the tests). */
export interface ArPainter {
  /** Start a camera frame: bind the layer's framebuffer, set the viewport, clear to fully transparent (the camera shows through). */
  begin(framebuffer: unknown, viewport: XrViewportLike): void;
  /** Draw the object's picture on a rectangle in the room. */
  picture(corners: Corners, viewProjection: Float32Array, opacity: number): void;
  /** Draw the ring that marks a surface. */
  ring(corners: Corners, viewProjection: Float32Array): void;
  /** The camera picture of this frame as something a recorder can read right now, or null (no camera access, or no picture yet). */
  camera?(view: XrViewLike, maxSide?: number): unknown | null;
  /**
   * Digital zoom: draw the camera picture of this frame into the XR layer (right after `begin`), its centre scaled up by `zoom`, so it
   * covers the system's own passthrough. Returns false when the camera picture is not there (then nothing zoomed may be drawn).
   */
  backdrop?(view: XrViewLike, zoom: number): boolean;
  /** Scan view: coloured triangles and lines in the room (the coverage dome). Vertices are x y z r g b a, premultiplied. */
  mesh?(m: { tris: Float32Array; lines: Float32Array }, viewProjection: Float32Array): void;
  /** Scan view: this frame's camera picture as a photo, at most `maxSide` on the longer side, copied now. Null = no picture. */
  still?(view: XrViewLike, maxSide: number): ScanGrab | null;
}

/** A finished picture of the object, already in the painter's texture. */
export interface ArPicture {
  /** The moment it was rendered for. */
  moment: WorldMoment;
  /** Metres from that view to the object, along the view. */
  depth: number;
  width: number;
  height: number;
  seq: number;
}

/** What renders the object's picture (the node graph in the app). */
export interface ArPictureSource {
  /** Start rendering for this moment unless the last request is still running. Returns whether it started. */
  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number }; seconds: number }): boolean;
  latest(): ArPicture | null;
  /** A sentence when the graph cannot be rendered, else null. */
  error(): string | null;
}

/** The clip recorder for the camera picture: returns the clip frame the picture became, or -1 when it took none. */
export interface ArClipRecorder {
  push(picture: unknown): number;
}

export type ArShow =
  /** The picture is the object seen through the World AR Camera: it covers the view and is rendered per pose. */
  | { kind: 'layer' }
  /** The picture is a flat card standing or lying in the room. */
  | { kind: 'card'; mode: CardMode; width: number };

export interface ArLoopState {
  phase: PlaceState['phase'];
  tracking: boolean;
  hint: string;
  recording: boolean;
  /** Seconds recorded so far. */
  recSeconds: number;
  /** Camera frames per second, and finished pictures of the object per second. */
  fps: number;
  pictureFps: number;
  /** How old the pose of the object's picture is when it is drawn, in milliseconds (averaged). 0 = no picture yet. */
  pictureBehindMs: number;
  /** How far the object is raised above its surface, metres (0 = on it). */
  height: number;
  /** The object is held by a browser anchor (false = a fixed pose in the room). */
  anchored: boolean;
  /** The recording has the camera picture with it. */
  clip: boolean;
  /** The zoom the user asked for (1 = none), and whether this phone can zoom (it needs the camera picture). */
  zoom: number;
  zoomAvailable: boolean;
  /** The recording rate the take is using (frames per second), what was asked for, and the measured rate of the AR camera. */
  recordFps: number;
  askedFps: number;
  cameraFps: number;
  /** The phone gives an estimate of the room's light (the 3D nodes can match it). */
  light: boolean;
  error: string | null;
  ended: boolean;
  /** The scan view's numbers (only in the scan view). */
  scan?: ScanViewState;
  /** Physics runs live in this view (the graph has a Physics node): the overlay offers Restart physics. */
  physics: boolean;
}

export interface ArLoopDeps {
  /** The scan view's brain. Present = this loop is the 3D Scan view: no picture of an object, a coverage dome instead. */
  scan?: ScanSession;
  session: XrSessionLike;
  referenceSpace: unknown;
  /** The `viewer` space for the hit test in the middle of the screen; null when hit testing is not available. */
  hitTestSource: unknown | null;
  /** The light probe of the session, when light estimation was granted (World AR view only). */
  lightProbe?: unknown | null;
  layer: XrLayerLike;
  features: GrantedFeatures;
  painter: ArPainter;
  source: ArPictureSource;
  show: ArShow;
  /** Longest side of the object's picture in pixels. */
  maxSide: number;
  /** Where the World AR Camera's Picture output gets the camera frame (see camera-feed.ts). Absent in tests that do not need it. */
  cameraFeed?: { readonly wanted: boolean; push(canvas: unknown): boolean };
  /** The project's clock for animated graphs, seconds. */
  seconds(): number;
  /**
   * The graph has a Physics node. The view then gives the World AR Camera a live physics clock: seconds since the object was placed,
   * raised, resized or "Restart physics" was pressed. Physics that gets the camera follows it, so a fall runs on in real time while you
   * walk and never starts over at the project's loop. The clock is part of the take.
   */
  physics?: boolean;
  /** Render the object's picture for where the phone will be when it arrives (default true). False only to measure what that gains. */
  predictPose?: boolean;
  now(): number;
  /** `new XRRigidTransform(position, orientation)`; absent in browsers without it (then a moved object is not re-anchored). */
  makeTransform?: (p: Vec3, q: Quat) => unknown;
  /** Size of the screen in CSS pixels, to turn a finger position into a point of the view. */
  screen(): { width: number; height: number };
  onState(state: ArLoopState): void;
}

const pt = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
/** The depth API's CPU depth picture as 16-bit values: luminance-alpha is that already, float32 (metres) becomes millimetres. */
export function depthMapOf(info: XrCpuDepthLike | null): DepthMap | null {
  if (!info || !(info.width > 0) || !(info.height > 0)) return null;
  const n = info.width * info.height;
  const matrix = Array.from(info.normDepthBufferFromNormView.matrix);
  if (info.data.byteLength === n * 2) return { width: info.width, height: info.height, rawValueToMeters: info.rawValueToMeters, normDepthBufferFromNormView: matrix, data: new Uint16Array(info.data.slice(0)) };
  if (info.data.byteLength === n * 4) {
    const f = new Float32Array(info.data);
    const data = new Uint16Array(n);
    for (let i = 0; i < n; i++) data[i] = Number.isFinite(f[i]) ? Math.min(65535, Math.max(0, Math.round(f[i] * info.rawValueToMeters * 1000))) : 0;
    return { width: info.width, height: info.height, rawValueToMeters: 0.001, normDepthBufferFromNormView: matrix, data };
  }
  return null;
}

export const poseOf =(t: XrRigidTransform): XrPose => ({ p: pt(t.position), q: [t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w] });

/** The hint for a picture that cannot be made: the reason in plain words, and what to do about it. */
export function renderFailHint(reason: string): string {
  const r = reason.replace(/[.…\s]+$/, '');
  if (/camera|webcam/i.test(r)) return `The picture could not be rendered: ${r}. The phone's camera is in use by the AR view, so a node that needs it cannot work. View the 3D Object itself, or remove the node that needs the camera.`;
  return `The picture could not be rendered: ${r}. View the 3D Object itself, or remove the node that fails.`;
}

/** Pixel size of the object's picture for a lens: the lens's shape, long side `maxSide`, both even. */
export function pictureSize(lens: Lens, maxSide: number): { width: number; height: number } {
  const a = lensAspect(lens);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return a >= 1 ? { width: even(maxSide), height: even(maxSide / a) } : { width: even(maxSide * a), height: even(maxSide) };
}

/** After this many frames in a row that threw, the view closes itself with the error instead of failing 60 times a second. */
export const MAX_FRAME_ERRORS = 30;
const RING_RADIUS = 0.09;
const STATE_EVERY_MS = 200;

/** How far one pixel of finger travel on the Zoom strip changes the zoom (exponential, so it feels even from 1x to 4x). */
export const ZOOM_PER_PIXEL = 0.006;

/** The recording rates the settings offer. */
export const RECORD_RATES = [60, 30, 25, 24] as const;

/**
 * The rate a take is recorded at. `asked` null = the project's rate (kept as it is: the take follows the project, the old behaviour).
 * An asked rate the AR camera cannot deliver is lowered to the nearest usual rate it can (a 60 on a 30 per second session records 30),
 * because a take with more frames than pictures would repeat pictures unevenly. `measured` 0 = not known yet: nothing is lowered.
 */
export function effectiveRecordRate(asked: number | null, project: number, measured: number): { fps: number; asked: number; clamped: boolean } {
  const want = asked ?? project;
  if (asked === null || !(measured > 0)) return { fps: want, asked: want, clamped: false };
  const can = measured * 1.08; // a 30 Hz session measures 29..31
  if (want <= can) return { fps: want, asked: want, clamped: false };
  const fit = RECORD_RATES.find((r) => r <= can);
  return { fps: fit ?? Math.max(1, Math.round(measured)), asked: want, clamped: true };
}

type Action = { type: 'place' } | { type: 'reset' } | { type: 'gesture'; g: Gesture } | { type: 'scan-begin' };

export class ArLoop {
  private place: PlaceState = initialPlaceState();
  private actions: Action[] = [];
  private raf = 0;
  private running = false;
  private ended = false;
  private paused = false;
  private error: string | null = null;
  private frameErrors = 0;
  private lastHit: XrHitTestResultLike | null = null;
  private anchor: XrAnchorLike | null = null;
  /** The placement's pose inside the anchor's frame: the browser moves the anchor, the object rides along. */
  private anchorLocal: XrPose | null = null;
  private anchorPose: XrPose | null = null;
  private anchorGen = 0;
  private reanchor = false;
  private drag: { h0: Vec3; p0: Vec3 } | null = null;
  /** When the live physics clock was last zeroed (null = no object placed), what it was zeroed for, and a restart that was asked for. */
  private physT0: number | null = null;
  private physKey = '';
  private physRestart = false;
  private lastView: { pose: XrPose; lens: Lens } | null = null;
  /** The room's light, smoothed over time; holds its last value while the phone has no estimate. */
  private light: WorldLight | null = null;
  private lightAt = -1;
  /** The zoom the user chose; and the zoom actually on the screen in the last frame (1 when the camera picture was not there to zoom). */
  private zoom = 1;
  private zoomShown = 1;
  /** The recording rate asked for (null = the project's) and what the recording uses. */
  private rateAsked: number | null = null;
  private rateUsed: { fps: number; asked: number; clamped: boolean } | null = null;
  private recording: { t0: number; samples: WorldSample[]; clip: ArClipRecorder | null; withClip: boolean | null } | null = null;
  private frameTimes: number[] = [];
  private pictureTimes: number[] = [];
  private lastSeq = -1;
  /** When each picture's moment was asked for, how fast the phone is moving, and how old pictures are when drawn (averaged). */
  private requestedAt = new WeakMap<WorldMoment, number>();
  private motion: { t: number; pose: XrPose; v: Vec3; w: Vec3 } | null = null;
  private behindMs = 0;
  private lastStateAt = -1e9;
  private readonly onEnd = () => this.finish(null);
  private readonly onVisibility = () => {
    this.paused = this.d.session.visibilityState === 'hidden';
    this.emit(true);
  };
  private readonly onSelect = () => {
    // Without the DOM overlay the page sees no fingers, only the session's own "select" (a tap on the screen): it places the object,
    // and a tap when it is already placed moves it to the ring. With the overlay the same tap arrives as a pointer event instead.
    if (!this.d.features.domOverlay) this.actions.push({ type: 'place' });
  };

  constructor(private d: ArLoopDeps) {}

  /** The project's frame rate, for 'Match project' (set by whoever opens the loop; 30 until then). */
  projectFps = 30;

  start(): void {
    if (this.running || this.ended) return;
    this.running = true;
    const s = this.d.session;
    s.addEventListener('end', this.onEnd);
    s.addEventListener('visibilitychange', this.onVisibility);
    s.addEventListener('select', this.onSelect);
    this.raf = s.requestAnimationFrame(this.frame);
    this.emit(true);
  }

  /** "Restart physics": the objects go back to where they start and fall again. */
  restartPhysics(): void {
    this.physRestart = true;
  }

  /** The Place button (or a tap while aiming). */
  placeHere(): void {
    this.actions.push({ type: 'place' });
  }
  /** Scan view: the Start button, once the dome is sized and lifted. */
  scanBegin(): void {
    this.actions.push({ type: 'scan-begin' });
  }
  /** The Reset button: pick the object up again. */
  reset(): void {
    this.actions.push({ type: 'reset' });
  }
  /** A finger gesture on the overlay (positions in CSS pixels). */
  gesture(g: Gesture): void {
    this.actions.push({ type: 'gesture', g });
  }

  /** The recording rate to use from the next recording on: frames per second, or null for the project's. */
  setRecordRate(fps: number | null): void {
    this.rateAsked = fps;
  }
  /** The camera's own rate right now, frames per second (0 = not known yet). */
  get cameraFps(): number {
    return this.frameTimes.length < 10 ? 0 : this.rate(this.frameTimes); // too few frames to know
  }
  /** The rate a recording started now would use. */
  recordRateFor(project: number): { fps: number; asked: number; clamped: boolean } {
    return effectiveRecordRate(this.rateAsked, project, this.cameraFps);
  }
  /** The zoom the user chose (1 to 4). */
  get zoomFactor(): number {
    return this.zoom;
  }
  /** Whether this session can zoom: the page needs the camera picture to draw it larger. */
  get canZoom(): boolean {
    return !this.d.scan && this.d.features.cameraAccess && !!this.d.painter.backdrop; // the scan's photos are never zoomed
  }

  get isRecording(): boolean {
    return !!this.recording;
  }
  get placeState(): PlaceState {
    return this.place;
  }

  /** Start noting poses. `clip` records the camera picture alongside when the session hands it over; null = motion only. */
  startRecording(clip: ArClipRecorder | null, rate?: { fps: number; asked: number; clamped: boolean }): void {
    if (this.recording || this.ended) return;
    this.recording = { t0: -1, samples: [], clip, withClip: null };
    this.rateUsed = rate ?? this.recordRateFor(this.projectFps);
    this.emit(true);
  }

  /** Stop noting poses. `withClip` tells whether the samples are matched to clip frames. */
  stopRecording(): { samples: WorldSample[]; withClip: boolean } | null {
    const r = this.recording;
    if (!r) return null;
    this.recording = null;
    this.emit(true);
    return { samples: r.samples, withClip: r.withClip === true };
  }

  /** Stop the loop (the session itself is ended by the controller). Safe to call twice. */
  stop(): void {
    this.finish(null);
  }

  private finish(error: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    if (error) this.error = error;
    const s = this.d.session;
    try {
      s.cancelAnimationFrame(this.raf);
    } catch {
      /* the session is already gone */
    }
    s.removeEventListener('end', this.onEnd);
    s.removeEventListener('visibilitychange', this.onVisibility);
    s.removeEventListener('select', this.onSelect);
    try {
      this.anchor?.delete();
    } catch {
      /* gone with the session */
    }
    this.anchor = null;
    this.emit(true);
  }

  private readonly frame = (time: number, frame: XrFrameLike): void => {
    if (!this.running) return;
    this.raf = this.d.session.requestAnimationFrame(this.frame);
    try {
      this.step(time, frame);
      this.frameErrors = 0;
    } catch (err) {
      // one bad frame (a pose the browser took back, a texture that is not ready) must not end the view; a view that only fails must
      if (++this.frameErrors >= MAX_FRAME_ERRORS) this.finish(`The AR view stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  private step(_time: number, frame: XrFrameLike): void {
    const d = this.d;
    const now = d.now();
    this.tick(this.frameTimes, now);
    const vp = frame.getViewerPose(d.referenceSpace);
    const view = vp && vp.views.length ? vp.views[0] : null;
    const viewport = view ? d.layer.getViewport(view) : null;
    if (!vp || !view || !viewport) {
      // the room is lost (or the frame has no picture): draw nothing, keep what was placed, say so
      this.place = placeStep(this.place, { type: 'frame', hit: null, tracking: false });
      this.actions = this.actions.filter((a) => a.type !== 'place'); // a tap on a lost room places nothing later
      this.drag = null;
      this.motion = null;
      this.emit(false);
      return;
    }
    const pose = poseOf(view.transform);
    const lens = lensOf(view.projectionMatrix);
    this.lastView = { pose, lens };
    this.trackMotion(now, pose);
    const tracking = vp.emulatedPosition !== true;

    // 1b. the room's light (jitters from frame to frame: smoothed over about a third of a second)
    if (d.lightProbe && frame.getLightEstimate) {
      let est: WorldLight | null = null;
      try {
        est = readLightEstimate(frame.getLightEstimate(d.lightProbe as never));
      } catch {
        est = null; // the estimate is optional: a frame that fails to give one keeps the last
      }
      this.light = smoothLight(this.light, est, this.lightAt < 0 ? 0 : (now - this.lightAt) / 1000);
      this.lightAt = now;
    }

    // 2. the surface in the middle of the screen, and the anchor
    let hit: XrPose | null = null;
    this.lastHit = null;
    if (d.hitTestSource && frame.getHitTestResults) {
      const results = frame.getHitTestResults(d.hitTestSource);
      if (results.length) {
        const p = results[0].getPose(d.referenceSpace);
        if (p) {
          hit = poseOf(p.transform);
          this.lastHit = results[0];
        }
      }
    }
    this.place = placeStep(this.place, { type: 'frame', hit, tracking });
    this.followAnchor(frame);

    // 3. what the user did
    const actions = this.actions;
    this.actions = [];
    for (const a of actions) this.act(a, frame, pose, lens);
    if (this.reanchor && !this.drag) this.makeAnchor(frame, null);

    // 4. draw
    d.painter.begin(d.layer.framebuffer, viewport);
    // digital zoom: the camera picture is drawn into the layer by the page, its centre scaled up, and everything else (the object, the
    // ring) is projected with the same factor. Where the camera picture is not there this frame, nothing is zoomed this frame.
    const zoom = this.zoom > 1 && this.canZoom && d.painter.backdrop?.(view, this.zoom) ? this.zoom : 1;
    this.zoomShown = zoom;
    const viewProjection = mat4Mul(zoomProjection(view.projectionMatrix, zoom), viewMatrix(pose));
    const base = this.place.placement;
    const pl = base ? liftedPlacement(base) : null; // where the object really stands: the surface point plus its height
    if (this.place.phase !== 'placed' && this.place.reticle) d.painter.ring(reticleCorners(this.place.reticle, RING_RADIUS), viewProjection);
    // the scan view: the coverage dome around the target instead of a picture of an object
    const scanTarget = d.scan && pl ? { center: pl.p, up: rotate(pl.q, [0, 1, 0]) as Vec3, h: base?.h ?? 0 } : null;
    if (d.scan && d.painter.mesh) {
      const m = d.scan.mesh(scanTarget);
      if (m) d.painter.mesh(m, viewProjection);
    }
    // the lens of the zoomed picture: the engine renders the object through it, so it stays locked to the room while the camera is zoomed
    const zlens = zoomLens(lens, zoom);
    // the live physics clock: starts when the object is placed and starts over when it is raised or resized (the fall begins from there)
    // or when the user asks. Without an object it does not run.
    let physics: number | undefined;
    if (d.physics && pl && base && !d.scan) {
      const key = `${(base.h ?? 0).toFixed(4)}|${base.scale.toFixed(4)}`;
      if (this.physT0 === null || key !== this.physKey || this.physRestart) {
        this.physT0 = now;
        this.physKey = key;
        this.physRestart = false;
      }
      physics = Math.max(0, (now - this.physT0) / 1000);
    } else {
      this.physT0 = null;
      this.physKey = '';
    }
    const moment: WorldMoment = { view: pose, lens: zlens, ...(physics !== undefined ? { physics } : {}), ...(zoom !== 1 ? { zoom } : {}), object: pl ? { p: pl.p, q: placementQuat(pl), scale: pl.scale, ...(base?.h ? { h: base.h } : {}) } : null, ...(this.light ? { light: this.light } : {}) };
    const pic = d.source.latest();
    if (pic && pic.seq !== this.lastSeq) {
      this.lastSeq = pic.seq;
      this.tick(this.pictureTimes, now);
    }
    if (pl && pic && !d.scan) {
      if (d.show.kind === 'layer') {
        // only a picture rendered WITH a placement shows the object; one from before the tap is empty
        const asked = this.requestedAt.get(pic.moment);
        if (asked !== undefined) this.behindMs = this.behindMs ? this.behindMs * 0.9 + (now - asked) * 0.1 : now - asked;
        if (pic.moment.object) d.painter.picture(layerCorners(pic.moment.view, pic.moment.lens, pic.depth), viewProjection, 1);
      } else d.painter.picture(cardCorners(pl, d.show.mode, d.show.width, pic.width / Math.max(1, pic.height), pose.p), viewProjection, 1);
    }

    // 4b. the camera picture for the Picture output, copied now: the browser's camera texture only lives inside this callback, and the
    // copy goes in before the engine is asked for this frame's picture. One draw serves the clip recorder too.
    const clipping = !!this.recording?.clip && !this.paused;
    let cam: unknown | null | undefined;
    const camera = (): unknown | null => (cam === undefined ? (cam = d.painter.camera ? d.painter.camera(view, clipping ? undefined : FEED_MAX_SIDE) : null) : cam);
    if (d.cameraFeed?.wanted && !this.paused) {
      const c = camera();
      if (c) d.cameraFeed.push(c);
    }

    // 5. the next picture, for this pose
    if (!this.paused && !d.scan && (pl || d.show.kind === 'card')) {
      const depth = pl ? Math.max(0.05, depthOf(pose, pl.p)) : 1;
      // The picture arrives about `behindMs` late, so it is rendered for where the phone (and the falling objects) will be by then:
      // the phone's speed carried on for that long. What is drawn then needs hardly any correction, whatever the depth of the content.
      const ahead = this.predict(pose, d.predictPose === false ? 0 : this.behindMs);
      const asked: WorldMoment = { ...moment, view: ahead.pose, ...(physics !== undefined ? { physics: physics + ahead.seconds } : {}) };
      if (d.source.request({ moment: asked, depth: pl ? Math.max(0.05, depthOf(ahead.pose, pl.p)) : depth, size: pictureSize(zlens, d.maxSide), seconds: d.seconds() })) this.requestedAt.set(asked, now);
    }

    // 6. the take
    const r = this.recording;
    if (r && !this.paused) {
      if (r.t0 < 0) r.t0 = now;
      const t = (now - r.t0) / 1000;
      const cam = r.clip ? camera() : null;
      if (r.withClip === null) r.withClip = !!cam; // decided by the first frame: either every sample has a clip frame or none has
      if (r.withClip) {
        const n = cam && r.clip ? r.clip.push(cam) : -1;
        if (n >= 0) r.samples.push({ t, frame: n, ...moment });
      } else r.samples.push({ t, ...moment });
    }

    // 7. the scan: a photo of this frame when one is due (the camera texture is only valid inside this callback)
    if (d.scan) {
      d.scan.frame({
        now,
        pose,
        lens,
        tracking,
        paused: this.paused,
        viewport: { width: d.layer.framebufferWidth, height: d.layer.framebufferHeight },
        placed: scanTarget,
        grab: () => d.painter.still?.(view, SCAN_MAX_SIDE) ?? null,
        depth: () => {
          try {
            return depthMapOf(frame.getDepthInformation?.(view) ?? null);
          } catch {
            return null; // depth was granted on paper only, or this frame has none
          }
        },
      });
    }
    this.emit(false);
  }

  private act(a: Action, frame: XrFrameLike, pose: XrPose, lens: Lens): void {
    const scan = this.d.scan;
    if (a.type === 'scan-begin') {
      const b = this.place.placement;
      const l = b ? liftedPlacement(b) : null;
      scan?.begin(l && b ? { center: l.p, up: rotate(l.q, [0, 1, 0]) as Vec3, h: b.h ?? 0 } : null);
      return;
    }
    if (scan?.phase === 'capture' && (a.type === 'reset' || a.type === 'place')) return; // the dome is fixed once the walk has begun
    if (a.type === 'reset') {
      this.dropAnchor();
      this.drag = null;
      this.place = placeStep(this.place, { type: 'reset' });
      return;
    }
    if (a.type === 'place') return this.placeNow(frame, pose);
    const g = a.g;
    const base = this.place.placement;
    const pl = base ? liftedPlacement(base) : null;
    if (scan) {
      // in the scan view the Size strip and the pinch change the dome's radius, and nothing moves the target once the walk began
      if (g.type === 'zoom') return void (scan.radius *= Math.exp(g.dy * RADIUS_PER_PIXEL));
      if (g.type === 'zoom-reset') return void (scan.radius = DEFAULT_RADIUS);
      if (g.type === 'pinch') return void (g.factor > 0 && (scan.radius *= g.factor));
      if (g.type === 'twist' || g.type === 'drag-start' || g.type === 'drag' || g.type === 'drag-end') return;
      if (scan.phase === 'capture' && g.type !== 'tap') return;
    }
    if (g.type === 'zoom') {
      if (this.canZoom) this.zoom = clampZoom(this.zoom * Math.exp(g.dy * ZOOM_PER_PIXEL));
      return;
    }
    if (g.type === 'zoom-reset') {
      this.zoom = 1;
      return;
    }
    if (g.type === 'tap') {
      if (this.place.phase !== 'placed' && scan?.phase !== 'capture') this.placeNow(frame, pose);
      return;
    }
    if (!pl || !base) return;
    if (g.type === 'lift') {
      // finger travel up the screen maps to metres at the object's distance, so the object follows the fingers 1 to 1 on screen
      const scr = this.d.screen();
      const dist = Math.max(0.2, depthOf(pose, pl.p));
      this.place = placeStep(this.place, { type: 'lift', dh: (g.dy * 2 * dist) / (Math.max(1e-6, lens[1] * this.zoomShown) * Math.max(1, scr.height)) });
      return;
    }
    if (g.type === 'lift-reset') {
      this.place = placeStep(this.place, { type: 'height', to: 0 });
      return;
    }
    if (g.type === 'twist' || g.type === 'pinch') {
      this.place = placeStep(this.place, g.type === 'twist' ? { type: 'twist', deg: g.deg } : { type: 'pinch', factor: g.factor });
      return;
    }
    if (g.type === 'drag-end') {
      if (this.drag) this.reanchor = true; // the object stands somewhere new: ask the browser to hold that point from now on
      this.drag = null;
      return;
    }
    // drag-start / drag: where the finger's ray meets the object's own surface
    const scr = this.d.screen();
    // the screen shows the middle of the camera picture scaled up by the zoom: a finger at screen point n is on the point n / zoom of the
    // real view, so un-zoom about the centre before casting the ray
    const zs = this.zoomShown;
    const ray = viewRay(pose, lens, ((g.x / Math.max(1, scr.width)) * 2 - 1) / zs, (1 - (g.y / Math.max(1, scr.height)) * 2) / zs);
    const h = rayPlane(ray.origin, ray.dir, pl.p, rotate(pl.q, [0, 1, 0]));
    if (!h) return; // the finger points above the horizon of the surface: the object stays
    if (g.type === 'drag-start' || !this.drag) {
      this.drag = { h0: h, p0: base.p }; // the surface point moves; the height above it stays
      return;
    }
    const to: Vec3 = [this.drag.p0[0] + h[0] - this.drag.h0[0], this.drag.p0[1] + h[1] - this.drag.h0[1], this.drag.p0[2] + h[2] - this.drag.h0[2]];
    this.place = placeStep(this.place, { type: 'move', to });
    this.relocal();
  }

  private placeNow(frame: XrFrameLike, pose: XrPose): void {
    if (!this.place.reticle) return;
    this.dropAnchor();
    this.place = placeStep(this.place, { type: 'place', viewer: pose.p });
    this.makeAnchor(frame, this.lastHit);
  }

  /** Ask the browser to hold the placement's point. From the hit result when there is one (the browser then ties it to that surface). */
  private makeAnchor(frame: XrFrameLike, hit: XrHitTestResultLike | null): void {
    this.reanchor = false;
    const pl = this.place.placement;
    if (!pl || !this.d.features.anchors) return;
    let made: Promise<XrAnchorLike> | null = null;
    try {
      if (hit?.createAnchor) made = hit.createAnchor();
      else if (frame.createAnchor && this.d.makeTransform) made = frame.createAnchor(this.d.makeTransform(pl.p, pl.q), this.d.referenceSpace);
    } catch {
      made = null; // anchors were granted but this device cannot make one here: the object keeps its fixed pose
    }
    if (!made) return;
    const gen = ++this.anchorGen;
    made.then(
      (anchor) => {
        // the user placed it again, reset it or left while the browser was making the anchor: this one is not wanted any more
        if (gen !== this.anchorGen || this.ended || !this.place.placement) {
          try {
            anchor.delete();
          } catch {
            /* already gone */
          }
          return;
        }
        const old = this.anchor;
        this.anchor = anchor;
        this.anchorLocal = null; // measured against the anchor's pose in the next frame
        this.anchorPose = null;
        try {
          old?.delete();
        } catch {
          /* already gone */
        }
      },
      () => undefined, // no anchor: the fixed pose is the fallback, nothing to tell the user
    );
  }

  private dropAnchor(): void {
    this.anchorGen++;
    this.reanchor = false;
    try {
      this.anchor?.delete();
    } catch {
      /* already gone */
    }
    this.anchor = null;
    this.anchorLocal = null;
    this.anchorPose = null;
  }

  private followAnchor(frame: XrFrameLike): void {
    const pl = this.place.placement;
    if (!this.anchor || !pl) return;
    if (frame.trackedAnchors && !frame.trackedAnchors.has(this.anchor)) return; // not tracked right now: the object keeps its last pose
    let a: XrPose | null = null;
    try {
      const p = frame.getPose(this.anchor.anchorSpace, this.d.referenceSpace);
      a = p ? poseOf(p.transform) : null;
    } catch {
      a = null; // the browser deleted the anchor
    }
    if (!a) return;
    this.anchorPose = a;
    if (!this.anchorLocal) {
      this.anchorLocal = poseMul(poseInv(a), { p: pl.p, q: pl.q });
      return;
    }
    this.place = placeStep(this.place, { type: 'anchor', pose: poseMul(a, this.anchorLocal) });
  }

  /** The user moved the object: remember where it now is inside the anchor's frame. */
  private relocal(): void {
    const pl = this.place.placement;
    if (pl && this.anchorPose) this.anchorLocal = poseMul(poseInv(this.anchorPose), { p: pl.p, q: pl.q });
  }

  private tick(times: number[], now: number): void {
    times.push(now);
    while (times.length > 1 && now - times[0] > 1000) times.shift();
  }
  /** The phone's speed (metres and turn per second, smoothed over a few frames) from the poses of the last frames. */
  private trackMotion(now: number, pose: XrPose): void {
    const m = this.motion;
    const dt = m ? (now - m.t) / 1000 : 0;
    if (!m || dt < 0.002 || dt > 0.3) {
      this.motion = { t: now, pose, v: [0, 0, 0], w: [0, 0, 0] };
      return;
    }
    const k = 0.5;
    const turn = qLog(qNorm(qMul(qNorm(pose.q), qConj(qNorm(m.pose.q)))));
    const v = [0, 1, 2].map((i) => m.v[i] * (1 - k) + ((pose.p[i] - m.pose.p[i]) / dt) * k) as Vec3;
    const w = [0, 1, 2].map((i) => m.w[i] * (1 - k) + ((2 * turn[i]) / dt) * k) as Vec3;
    this.motion = { t: now, pose, v, w };
  }

  /** The pose `ms` milliseconds on at the current speed; the step is limited (half a metre, 40 degrees, a quarter second) so a jolt cannot fling it. */
  private predict(pose: XrPose, ms: number): { pose: XrPose; seconds: number } {
    const m = this.motion;
    const s = Math.min(0.25, Math.max(0, ms / 1000));
    if (!m || s < 0.005) return { pose, seconds: s };
    const step = (v: Vec3, max: number): Vec3 => {
      const d = [v[0] * s, v[1] * s, v[2] * s] as Vec3;
      const n = Math.hypot(d[0], d[1], d[2]);
      return n > max ? ([d[0] * (max / n), d[1] * (max / n), d[2] * (max / n)] as Vec3) : d;
    };
    const dp = step(m.v, 0.5);
    const dw = step(m.w, (40 * Math.PI) / 180);
    return { pose: { p: [pose.p[0] + dp[0], pose.p[1] + dp[1], pose.p[2] + dp[2]], q: qNorm(qMul(qExp([dw[0] / 2, dw[1] / 2, dw[2] / 2]), qNorm(pose.q))) }, seconds: s };
  }

  private rate(times: number[]): number {
    return times.length < 2 ? 0 : Math.round(((times.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0]));
  }

  state(): ArLoopState {
    const r = this.recording;
    const sourceError = this.d.source.error();
    const scan = this.d.scan;
    return {
      ...(scan ? { scan: scan.state() } : {}),
      phase: this.place.phase,
      tracking: this.place.tracking,
      hint: scan ? scan.hint(this.place, { gestures: this.d.features.domOverlay, paused: this.paused }) : sourceError ? renderFailHint(sourceError) : hintFor(this.place, { gestures: this.d.features.domOverlay, recording: !!r, paused: this.paused }),
      recording: !!r,
      recSeconds: r && r.t0 >= 0 ? (this.d.now() - r.t0) / 1000 : 0,
      fps: this.rate(this.frameTimes),
      pictureFps: this.rate(this.pictureTimes),
      pictureBehindMs: Math.round(this.behindMs),
      height: this.place.placement?.h ?? 0,
      anchored: !!this.anchor,
      clip: r?.withClip === true,
      zoom: this.canZoom ? this.zoom : 1,
      zoomAvailable: this.canZoom,
      recordFps: r && this.rateUsed ? this.rateUsed.fps : this.recordRateFor(this.projectFps).fps,
      askedFps: r && this.rateUsed ? this.rateUsed.asked : this.recordRateFor(this.projectFps).asked,
      cameraFps: this.cameraFps,
      light: !!this.light,
      physics: !!this.d.physics && !this.d.scan,
      error: this.error,
      ended: this.ended,
    };
  }

  private emit(force: boolean): void {
    const now = this.d.now();
    if (!force && now - this.lastStateAt < STATE_EVERY_MS) return;
    this.lastStateAt = now;
    this.d.onState(this.state());
  }

  /** The last view the loop saw (for the tests and the overlay's diagnostics). */
  get view(): { pose: XrPose; lens: Lens } | null {
    return this.lastView;
  }
  get placement(): Placement | null {
    return this.place.placement;
  }
}
