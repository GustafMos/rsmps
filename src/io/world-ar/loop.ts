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
import type { Quat, Vec3 } from '../../engine/lib/motion-math';
import type { WorldMoment, WorldSample } from '../../engine/lib/world-take';
import { cardCorners, depthOf, layerCorners, lensAspect, lensOf, mat4Mul, placementQuat, poseInv, poseMul, rayPlane, reticleCorners, viewMatrix, viewRay, type CardMode, type Corners, type Lens, type Placement, type XrPose } from '../../engine/lib/xr-math';
import { rotate } from '../../engine/lib/motion-math';
import { hintFor, initialPlaceState, placeStep, type Gesture, type PlaceState } from './placement';
import type { GrantedFeatures, XrAnchorLike, XrFrameLike, XrHitTestResultLike, XrLayerLike, XrRigidTransform, XrSessionLike, XrViewLike, XrViewportLike } from './xr-api';

/** What draws into the AR view (WebGL in the app, a recorder of calls in the tests). */
export interface ArPainter {
  /** Start a camera frame: bind the layer's framebuffer, set the viewport, clear to fully transparent (the camera shows through). */
  begin(framebuffer: unknown, viewport: XrViewportLike): void;
  /** Draw the object's picture on a rectangle in the room. */
  picture(corners: Corners, viewProjection: Float32Array, opacity: number): void;
  /** Draw the ring that marks a surface. */
  ring(corners: Corners, viewProjection: Float32Array): void;
  /** The camera picture of this frame as something a recorder can read right now, or null (no camera access, or no picture yet). */
  camera?(view: XrViewLike): unknown | null;
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
  /** The object is held by a browser anchor (false = a fixed pose in the room). */
  anchored: boolean;
  /** The recording has the camera picture with it. */
  clip: boolean;
  error: string | null;
  ended: boolean;
}

export interface ArLoopDeps {
  session: XrSessionLike;
  referenceSpace: unknown;
  /** The `viewer` space for the hit test in the middle of the screen; null when hit testing is not available. */
  hitTestSource: unknown | null;
  layer: XrLayerLike;
  features: GrantedFeatures;
  painter: ArPainter;
  source: ArPictureSource;
  show: ArShow;
  /** Longest side of the object's picture in pixels. */
  maxSide: number;
  /** The project's clock for animated graphs, seconds. */
  seconds(): number;
  now(): number;
  /** `new XRRigidTransform(position, orientation)`; absent in browsers without it (then a moved object is not re-anchored). */
  makeTransform?: (p: Vec3, q: Quat) => unknown;
  /** Size of the screen in CSS pixels, to turn a finger position into a point of the view. */
  screen(): { width: number; height: number };
  onState(state: ArLoopState): void;
}

const pt = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
export const poseOf = (t: XrRigidTransform): XrPose => ({ p: pt(t.position), q: [t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w] });

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

type Action = { type: 'place' } | { type: 'reset' } | { type: 'gesture'; g: Gesture };

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
  private lastView: { pose: XrPose; lens: Lens } | null = null;
  private recording: { t0: number; samples: WorldSample[]; clip: ArClipRecorder | null; withClip: boolean | null } | null = null;
  private frameTimes: number[] = [];
  private pictureTimes: number[] = [];
  private lastSeq = -1;
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

  /** The Place button (or a tap while aiming). */
  placeHere(): void {
    this.actions.push({ type: 'place' });
  }
  /** The Reset button: pick the object up again. */
  reset(): void {
    this.actions.push({ type: 'reset' });
  }
  /** A finger gesture on the overlay (positions in CSS pixels). */
  gesture(g: Gesture): void {
    this.actions.push({ type: 'gesture', g });
  }

  get isRecording(): boolean {
    return !!this.recording;
  }
  get placeState(): PlaceState {
    return this.place;
  }

  /** Start noting poses. `clip` records the camera picture alongside when the session hands it over; null = motion only. */
  startRecording(clip: ArClipRecorder | null): void {
    if (this.recording || this.ended) return;
    this.recording = { t0: -1, samples: [], clip, withClip: null };
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
      this.emit(false);
      return;
    }
    const pose = poseOf(view.transform);
    const lens = lensOf(view.projectionMatrix);
    this.lastView = { pose, lens };
    const tracking = vp.emulatedPosition !== true;

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
    const viewProjection = mat4Mul(view.projectionMatrix, viewMatrix(pose));
    d.painter.begin(d.layer.framebuffer, viewport);
    const pl = this.place.placement;
    if (this.place.phase !== 'placed' && this.place.reticle) d.painter.ring(reticleCorners(this.place.reticle, RING_RADIUS), viewProjection);
    const moment: WorldMoment = { view: pose, lens, object: pl ? { p: pl.p, q: placementQuat(pl), scale: pl.scale } : null };
    const pic = d.source.latest();
    if (pic && pic.seq !== this.lastSeq) {
      this.lastSeq = pic.seq;
      this.tick(this.pictureTimes, now);
    }
    if (pl && pic) {
      if (d.show.kind === 'layer') {
        // only a picture rendered WITH a placement shows the object; one from before the tap is empty
        if (pic.moment.object) d.painter.picture(layerCorners(pic.moment.view, pic.moment.lens, pic.depth), viewProjection, 1);
      } else d.painter.picture(cardCorners(pl, d.show.mode, d.show.width, pic.width / Math.max(1, pic.height), pose.p), viewProjection, 1);
    }

    // 5. the next picture, for this pose
    if (!this.paused && (pl || d.show.kind === 'card')) {
      const depth = pl ? Math.max(0.05, depthOf(pose, pl.p)) : 1;
      d.source.request({ moment, depth, size: pictureSize(lens, d.maxSide), seconds: d.seconds() });
    }

    // 6. the take
    const r = this.recording;
    if (r && !this.paused) {
      if (r.t0 < 0) r.t0 = now;
      const t = (now - r.t0) / 1000;
      const cam = r.clip && d.painter.camera ? d.painter.camera(view) : null;
      if (r.withClip === null) r.withClip = !!cam; // decided by the first frame: either every sample has a clip frame or none has
      if (r.withClip) {
        const n = cam && r.clip ? r.clip.push(cam) : -1;
        if (n >= 0) r.samples.push({ t, frame: n, ...moment });
      } else r.samples.push({ t, ...moment });
    }
    this.emit(false);
  }

  private act(a: Action, frame: XrFrameLike, pose: XrPose, lens: Lens): void {
    if (a.type === 'reset') {
      this.dropAnchor();
      this.drag = null;
      this.place = placeStep(this.place, { type: 'reset' });
      return;
    }
    if (a.type === 'place') return this.placeNow(frame, pose);
    const g = a.g;
    const pl = this.place.placement;
    if (g.type === 'tap') {
      if (this.place.phase !== 'placed') this.placeNow(frame, pose);
      return;
    }
    if (!pl) return;
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
    const ray = viewRay(pose, lens, (g.x / Math.max(1, scr.width)) * 2 - 1, 1 - (g.y / Math.max(1, scr.height)) * 2);
    const h = rayPlane(ray.origin, ray.dir, pl.p, rotate(pl.q, [0, 1, 0]));
    if (!h) return; // the finger points above the horizon of the surface: the object stays
    if (g.type === 'drag-start' || !this.drag) {
      this.drag = { h0: h, p0: pl.p };
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
  private rate(times: number[]): number {
    return times.length < 2 ? 0 : Math.round(((times.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0]));
  }

  state(): ArLoopState {
    const r = this.recording;
    const sourceError = this.d.source.error();
    return {
      phase: this.place.phase,
      tracking: this.place.tracking,
      hint: sourceError ? `The picture could not be rendered: ${sourceError}` : hintFor(this.place, { gestures: this.d.features.domOverlay, recording: !!r, paused: this.paused }),
      recording: !!r,
      recSeconds: r && r.t0 >= 0 ? (this.d.now() - r.t0) / 1000 : 0,
      fps: this.rate(this.frameTimes),
      pictureFps: this.rate(this.pictureTimes),
      anchored: !!this.anchor,
      clip: r?.withClip === true,
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
