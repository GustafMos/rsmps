/**
 * The camera picture of an AR session as a GPU texture the node graph can use: this is what the World AR Camera's Picture output
 * hands out.
 *
 * While the AR view is open the phone's AR system owns the camera, so the ordinary camera nodes have nothing. With the browser's
 * camera access the AR loop can still get each camera frame as a WebGL texture, valid only inside that frame's callback. The loop
 * therefore draws it into the painter's own WebGL canvas (small, longer side at most FEED_MAX_SIDE) and calls `push` right there:
 * the canvas is copied into a GPUTexture owned here (`copyExternalImageToTexture`, the same call live pictures use), so the texture
 * holds the newest camera frame when the engine renders the object's picture for that frame.
 *
 * The copy only happens while somebody asked for the picture recently (`ask` is called by the Host each time the node renders), so a
 * graph that does not use the Picture output costs nothing.
 *
 * UNTESTED ON A REAL AR DEVICE.
 */
import type { Gpu } from '../../engine/gpu/gpu';

/** Longest side of the camera picture handed to the graph. */
export const FEED_MAX_SIDE = 960;
/** The picture counts as wanted for this long after the node last asked for it (milliseconds). */
export const WANT_MS = 1500;

export interface CameraFrame {
  texture: GPUTexture;
  width: number;
  height: number;
}

/** What `Host.arCameraFrame` answers. */
export interface ArCameraState {
  /** An AR session is open. */
  session: boolean;
  /** The session hands the camera picture over. */
  access: boolean;
  /** The newest camera frame, or null (not yet, or none this session). */
  frame: CameraFrame | null;
}

type FeedGpu = Pick<Gpu, 'acquire' | 'retain' | 'release'> & { device: { queue: Pick<GPUQueue, 'copyExternalImageToTexture'> } };

export class ArCameraFeed {
  private on = false;
  private access = false;
  private tex: GPUTexture | null = null;
  private lastAsk = -1e9;
  private frame: CameraFrame | null = null;

  constructor(
    private gpu: FeedGpu,
    private now: () => number = () => performance.now(),
  ) {}

  /** The AR session opened. `access`: the browser hands the camera picture over. */
  begin(access: boolean): void {
    this.on = true;
    this.access = access;
    this.lastAsk = -1e9;
    this.free();
  }

  /** The AR session ended: the texture goes back to the pool. */
  end(): void {
    this.on = false;
    this.access = false;
    this.free();
  }

  /** The node asks for the picture: marks it wanted and answers. */
  ask(): ArCameraState {
    this.lastAsk = this.now();
    return { session: this.on, access: this.access, frame: this.on && this.access ? this.frame : null };
  }

  /** Should the loop produce this frame's camera picture? */
  get wanted(): boolean {
    return this.on && this.access && this.now() - this.lastAsk <= WANT_MS;
  }

  /** Copy the canvas holding this frame's camera picture (upright, first row = top) into the texture. Returns whether it did. */
  push(canvas: unknown): boolean {
    const c = canvas as { width: number; height: number } | null;
    if (!this.on || !c || !c.width || !c.height) return false;
    const { width, height } = c;
    if (!this.tex || this.tex.width !== width || this.tex.height !== height) {
      this.free();
      this.tex = this.gpu.acquire(width, height, 'rgba8unorm');
      this.gpu.retain(this.tex);
    }
    this.gpu.device.queue.copyExternalImageToTexture({ source: c as unknown as GPUCopyExternalImageSource }, { texture: this.tex, premultipliedAlpha: true }, [width, height]);
    this.frame = { texture: this.tex, width, height };
    return true;
  }

  private free(): void {
    if (this.tex) this.gpu.release(this.tex);
    this.tex = null;
    this.frame = null;
  }
}
