/**
 * The scan view's brain (no WebXR and no DOM in here: the loop hands it poses, the environment grabs and encodes pictures).
 *
 *   aim (find a surface, tap) -> setup (size the dome, lift its middle) -> capture (walk around it)
 *
 * While capturing, every frame: where the phone is, whether it is steady, whether it looks at the target, whether this is a new
 * viewpoint, whether an encode slot is free; if all hold (auto capture) the camera picture of THIS frame is grabbed inside the frame
 * callback (the only moment the browser's camera texture is valid) and encoded afterwards. At most `MAX_PENDING` encodes run at once;
 * when they are busy an automatic shot is skipped, never queued.
 */
import { DEFAULT_GRID, DEFAULT_RADIUS, MAX_RADIUS, MIN_RADIUS, SCAN_MAX_SHOTS, emptyScan, intrinsicsFromProjection, type DepthMap, type ScanData, type ScanShot, type ScanTarget, encodeDepth, shrinkDepth } from '../../engine/lib/scan-data';
import {
  COVERAGE_MEANING,
  PoseHistory,
  buildDomeMesh,
  cellOfPosition,
  coverageOf,
  distanceOk,
  guidanceFor,
  isAimed,
  isNewViewpoint,
  isTooBlurry,
  qualitySummary,
  sharpnessFromVariance,
  viewFromCentre,
  type Cell,
  type CoverageReport,
  type DomeMesh,
  type QualitySummary,
} from '../../engine/lib/scan-coverage';
import type { Vec3 } from '../../engine/lib/motion-math';
import { project, projectionMatrix, type Lens, type XrPose } from '../../engine/lib/xr-math';
import type { PlaceState } from './placement';
import { hintFor } from './placement';

/** Encodes running at once. */
export const MAX_PENDING = 2;
/** At least this long between two automatic shots (milliseconds). */
export const MIN_SHOT_GAP_MS = 250;
/** How long "Too blurry" stays on screen (milliseconds). */
export const BLUR_HINT_MS = 2500;
/** The radius of a new scan's dome and how far one pixel on the Size strip changes it (exponential). */
export const RADIUS_PER_PIXEL = 0.006;

/** A camera picture taken inside the frame callback, still to be encoded. The painter's own object extends this. */
export interface ScanGrab {
  width: number;
  height: number;
}

export interface ScanEnv {
  /** Turn a grab into a JPEG (quality about 0.92) and a Laplacian variance of a small greyscale copy; frees what the grab held. */
  encode(grab: ScanGrab): Promise<{ blob: Blob; variance: number }>;
}

export type ScanPhase = 'aim' | 'setup' | 'capture';

export interface ScanViewState {
  phase: ScanPhase;
  auto: boolean;
  radius: number;
  /** Photos kept, photos being encoded, photos left out for blur. */
  kept: number;
  pending: number;
  rejected: number;
  /** 0..1 of the reachable dome. */
  coverage: number;
  grid: { az: number; el: number };
  /** Per cell, row-major (row 0 = lowest): 0 not reachable, 1 missing, 2 thin (one photo), 3 covered. */
  cells: number[];
  /** The cell the camera is in, or null. */
  here: Cell | null;
  /** The one line of guidance (plain words). */
  guidance: string;
  /** Plain-language line for the overlay: "Coverage 62% · 41 photos". */
  line: string;
  /** Counts up with every kept photo (the overlay flashes on a change). */
  flash: number;
  /** The phone gave depth sensing: shown as "depth: yes". */
  depth: boolean;
  /** Photos that came with a depth map. */
  depthShots: number;
  steady: boolean;
  aimed: boolean;
  distance: number;
  /** The most recent problem in words ("Too blurry, hold steadier"), cleared after a few seconds. */
  notice: string | null;
  /** The size of the biggest camera picture seen and the shape mismatch with the view, for the readout. */
  picture: { width: number; height: number } | null;
  aspectOff: number;
}

export interface ScanResult {
  scan: ScanData;
  /** The encoded photos, in the order of `scan.shots`. */
  blobs: Blob[];
  summary: QualitySummary;
  rejected: number;
  depth: boolean;
}

export interface ScanFrame {
  /** Milliseconds. */
  now: number;
  pose: XrPose;
  lens: Lens;
  tracking: boolean;
  paused: boolean;
  /** The size of the view in pixels (for the aspect check). */
  viewport: { width: number; height: number };
  /** Where the target stands this frame (the lifted surface point and the surface's up), when it is placed. */
  placed: { center: Vec3; up: Vec3; h: number } | null;
  /** The camera picture of this frame as a grab, or null (no picture). Called at most once, and only when a shot is taken. */
  grab(): ScanGrab | null;
  /** The depth picture of this frame, or null. */
  depth(): DepthMap | null;
}

interface Kept {
  shot: ScanShot;
  blob: Blob;
}

export class ScanSession {
  /** 'aim' until Start is pressed, then 'capture'; `state().phase` also tells 'setup' (the target is placed, Start not yet pressed). */
  phase: 'aim' | 'capture' = 'aim';
  private placed = false;
  auto = true;
  private _radius = DEFAULT_RADIUS;
  private target: ScanTarget | null = null;
  private history = new PoseHistory();
  private kept: Kept[] = [];
  private inflight: Vec3[] = [];
  private rejected = 0;
  private t0 = -1;
  private lastShotAt = -1e9;
  private flash = 0;
  private wantShutter = false;
  private notice: { text: string; until: number } | null = null;
  private report: CoverageReport | null = null;
  private keptSharp: number[] = [];
  private depthShots = 0;
  private pictureSize: { width: number; height: number } | null = null;
  private aspectOff = 0;
  private last: { steady: boolean; aimed: boolean; distance: number; here: Cell | null; dir: Vec3 } = { steady: false, aimed: false, distance: 0, here: null, dir: [0, 1, 0] };
  private mesh$: DomeMesh | null = null;
  private meshKey = '';
  private pendingDone = new Set<Promise<void>>();
  private finished = false;
  private nowMs = 0;

  constructor(private o: { env: ScanEnv; depth: boolean; grid?: { az: number; el: number }; auto?: boolean }) {
    if (o.auto === false) this.auto = false;
  }

  get radius(): number {
    return this._radius;
  }
  set radius(r: number) {
    if (this.phase === 'capture') return; // the dome is fixed once the walk has begun
    this._radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r));
  }
  get grid(): { az: number; el: number } {
    return this.o.grid ?? { ...DEFAULT_GRID };
  }
  get keptCount(): number {
    return this.kept.length;
  }

  setAuto(on: boolean): void {
    this.auto = on;
  }
  /** The shutter button: one photo at the next frame whatever the viewpoint (it still needs the camera picture and a free slot). */
  shutter(): void {
    if (this.phase === 'capture') this.wantShutter = true;
  }

  /** Lock the target and begin the walk. Needs the target to be placed (the loop passes it). Returns false when there is none. */
  begin(placed: { center: Vec3; up: Vec3; h: number } | null): boolean {
    if (!placed || this.phase === 'capture') return false;
    this.target = { center: [...placed.center] as Vec3, radius: this._radius, up: [...placed.up] as Vec3, h: placed.h };
    this.phase = 'capture';
    this.t0 = -1;
    this.report = null;
    this.meshKey = '';
    return true;
  }

  /** The words under the buttons for the current step. */
  hint(place: PlaceState, o: { gestures: boolean; paused: boolean }): string {
    if (o.paused || !place.tracking || place.phase === 'searching') return hintFor(place, { gestures: o.gestures, recording: false, paused: o.paused });
    if (this.phase === 'aim' && place.phase !== 'placed') return 'Step 1: aim at the object and tap the screen' + (o.gestures ? ' (or press Place).' : '.') + ' Tap on the surface right next to it.';
    if (this.phase === 'aim') return 'Make the dome fit the object: pinch, or slide the Size strip. Lift its middle to the middle of the object with two fingers (or the Height strip). Then press Start.';
    if (this.notice && this.notice.until > this.nowMs) return this.notice.text;
    return this.last.here || this.kept.length ? this.guidanceLine() : 'Step 2: walk around the object, keeping it in the middle of the picture.';
  }

  private guidanceLine(): string {
    if (!this.target || !this.report) return '';
    if (this.kept.length + this.inflight.length >= SCAN_MAX_SHOTS) return 'The photo limit is reached. Press Done.';
    return guidanceFor({ steady: this.last.steady, aimed: this.last.aimed, distance: this.last.distance, radius: this.target.radius, report: this.report, dir: this.last.dir, up: this.target.up }).text;
  }

  /** Called every camera frame by the loop. Never throws for a bad frame: an encode that fails only loses that photo. */
  frame(f: ScanFrame): void {
    this.nowMs = f.now;
    this.placed = !!f.placed;
    const pose = f.pose;
    this.history.push({ t: f.now, pos: pose.p, quat: pose.q });
    if (this.notice && this.notice.until <= f.now) this.notice = null;
    if (this.phase !== 'capture' || !this.target) return;
    const target = this.target;
    if (this.t0 < 0) this.t0 = f.now;
    if (!this.report) this.report = this.recompute();
    const v = viewFromCentre(pose.p, target.center);
    const ndc = project(pose, f.lens, target.center);
    const aimed = isAimed(ndc);
    const steady = this.history.steady();
    const here = cellOfPosition(pose.p, target, this.grid);
    this.last = { steady, aimed, distance: v.dist, here, dir: v.dir };
    // the picture should fill the view; remember how far off it is, for the readout
    if (f.paused || !f.tracking || this.finished) return;

    const free = this.inflight.length < MAX_PENDING && this.kept.length + this.inflight.length < SCAN_MAX_SHOTS;
    let take = false;
    if (this.wantShutter) {
      this.wantShutter = false;
      if (free) take = true;
      else this.notice = { text: this.inflight.length >= MAX_PENDING ? 'One moment: the last photos are still being saved.' : 'The photo limit is reached. Press Done.', until: f.now + 1500 };
    } else if (this.auto && free && aimed && steady && distanceOk(v.dist, target.radius) && here && f.now - this.lastShotAt >= MIN_SHOT_GAP_MS) {
      const positions = [...this.kept.map((k) => k.shot), ...this.inflight.map((pos) => ({ pos }))];
      take = isNewViewpoint(pose.p, positions, target, this.grid, this.report.counts);
    }
    if (take) this.capture(f, v.dist);
  }

  private capture(f: ScanFrame, _dist: number): void {
    const grab = f.grab();
    if (!grab) {
      this.notice = { text: 'The phone gave no camera picture for this frame. Hold still and try again.', until: f.now + 2000 };
      return;
    }
    this.lastShotAt = f.now;
    this.pictureSize = { width: grab.width, height: grab.height };
    const view = f.viewport;
    if (view.width > 0 && view.height > 0) this.aspectOff = Math.abs(grab.width / grab.height / (view.width / view.height) - 1);
    const k = intrinsicsFromProjection(projectionMatrix(f.lens), grab.width, grab.height);
    const depth = this.o.depth ? f.depth() : null;
    const shot: ScanShot = {
      asset: '',
      t: Math.max(0, (f.now - this.t0) / 1000),
      pos: [...f.pose.p] as Vec3,
      quat: [...f.pose.q] as ScanShot['quat'],
      w: grab.width,
      h: grab.height,
      ...k,
      sharp: 0,
      ...(depth ? { depth: encodeDepth(shrinkDepth(depth)) } : {}),
    };
    this.inflight.push(shot.pos);
    const job = this.o.env
      .encode(grab)
      .then(
        ({ blob, variance }) => {
          shot.sharp = Math.round(sharpnessFromVariance(variance) * 1000) / 1000;
          if (isTooBlurry(shot.sharp, this.keptSharp)) {
            this.rejected++;
            this.notice = { text: 'Too blurry, hold steadier', until: this.nowMs + BLUR_HINT_MS };
            return;
          }
          this.kept.push({ shot, blob });
          this.keptSharp.push(shot.sharp);
          if (shot.depth) this.depthShots++;
          this.flash++;
          this.report = this.recompute();
        },
        () => {
          this.notice = { text: 'A photo could not be saved and was skipped.', until: this.nowMs + 2000 };
        },
      )
      .finally(() => {
        const i = this.inflight.indexOf(shot.pos);
        if (i >= 0) this.inflight.splice(i, 1);
        this.pendingDone.delete(job);
      });
    this.pendingDone.add(job);
  }

  private recompute(): CoverageReport {
    return coverageOf({ target: this.target!, grid: this.grid, shots: this.kept.map((k) => k.shot) });
  }

  /** The dome as vertices for the painter (cached until something it shows changes). */
  mesh(preview: { center: Vec3; up: Vec3; h: number } | null): DomeMesh | null {
    const target: ScanTarget | null = this.target ?? (preview ? { center: preview.center, up: preview.up, h: preview.h, radius: this._radius } : null);
    if (!target) return null;
    const report = this.report ?? coverageOf({ target, grid: this.grid, shots: [] });
    const key = [target.center.join(','), target.radius, target.up.join(','), this.kept.length, this.last.here ? `${this.last.here.col}/${this.last.here.row}` : '-', this.phase].join('|');
    if (key !== this.meshKey || !this.mesh$) {
      this.meshKey = key;
      this.mesh$ = buildDomeMesh(target, report, this.phase === 'capture' ? this.last.here : null, this.kept.map((k) => k.shot.pos));
    }
    return this.mesh$;
  }

  state(): ScanViewState {
    const grid = this.grid;
    const r = this.report;
    const cells = r ? r.counts.map((n, i) => (!r.reachable[i] ? 0 : n === 0 ? 1 : n === 1 ? 2 : 3)) : new Array<number>(grid.az * grid.el).fill(1);
    const coverage = r ? r.fraction : 0;
    const capture = this.phase === 'capture';
    return {
      phase: capture ? 'capture' : this.placed ? 'setup' : 'aim',
      auto: this.auto,
      radius: this._radius,
      kept: this.kept.length,
      pending: this.inflight.length,
      rejected: this.rejected,
      coverage,
      grid,
      cells,
      here: this.last.here,
      guidance: capture ? (this.notice && this.notice.until > this.nowMs ? this.notice.text : this.guidanceLine()) : '',
      line: `Coverage ${Math.round(coverage * 100)}% · ${this.kept.length} photo${this.kept.length === 1 ? '' : 's'}`,
      flash: this.flash,
      depth: this.o.depth,
      depthShots: this.depthShots,
      steady: this.last.steady,
      aimed: this.last.aimed,
      distance: this.last.distance,
      notice: this.notice && this.notice.until > this.nowMs ? this.notice.text : null,
      picture: this.pictureSize,
      aspectOff: this.aspectOff,
    };
  }

  /** What the percentage means, for the overlay's hint. */
  static readonly meaning = COVERAGE_MEANING;

  /** Stop taking photos, wait for the encodes under way, and hand the result over. Safe to call twice (the second call gets the same). */
  async finish(): Promise<ScanResult> {
    this.finished = true;
    while (this.pendingDone.size) await Promise.all([...this.pendingDone]);
    const target = this.target;
    const scan: ScanData = target ? { ...emptyScan(), target, grid: this.grid, shots: this.kept.map((k) => k.shot), ...(this.rejected ? { rejected: this.rejected } : {}) } : emptyScan();
    return { scan, blobs: this.kept.map((k) => k.blob), summary: qualitySummary(scan, this.rejected), rejected: this.rejected, depth: this.o.depth };
  }
}
