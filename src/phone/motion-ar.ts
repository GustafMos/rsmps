/**
 * Optional 6-DoF tracking with WebXR (`immersive-ar`, Android Chrome with ARCore). Streams the viewer pose position + orientation.
 *
 * UNTESTED ON A REAL DEVICE: it follows the WebXR Device API but could not be run here. It is only offered when the browser says
 * `immersive-ar` is supported; the phone reports `ar: false` in its capabilities otherwise and the toggle stays hidden.
 * Known risk: an AR session takes over the camera, which the page also holds for the video link; some devices refuse or pause one of them.
 */
import { r3, r5, type ArMsg } from './motion-protocol';

interface XRLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: unknown): Promise<XRSessionLike>;
}
interface XRSessionLike {
  requestReferenceSpace(type: string): Promise<unknown>;
  requestAnimationFrame(cb: (t: number, frame: XRFrameLike) => void): number;
  updateRenderState(state: unknown): void;
  end(): Promise<void>;
  addEventListener(type: 'end', cb: () => void): void;
}
interface XRFrameLike {
  session: XRSessionLike;
  getViewerPose(space: unknown): { transform: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } } | null;
}

const xr = (): XRLike | null => ((navigator as unknown as { xr?: XRLike }).xr ?? null);

/** True when this browser can start an immersive-ar session. Never throws. */
export async function arSupported(): Promise<boolean> {
  try {
    return !!xr() && (await xr()!.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

export interface ArHandle {
  stop(): Promise<void>;
}

/** Start tracking. Must be called from a user gesture. `onPose` gets a ready-to-send message at the display rate (the caller caps it). */
export async function startAr(onPose: (m: ArMsg) => void, onEnd: () => void): Promise<ArHandle> {
  const api = xr();
  if (!api) throw new Error('This browser has no WebXR.');
  const session = await api.requestSession('immersive-ar', { requiredFeatures: ['local'], optionalFeatures: [] });
  // A session needs a render layer even though nothing is drawn: a 1x1 WebGL canvas made XR-compatible.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl', { xrCompatible: true }) as (WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> }) | null;
  const Layer = (window as unknown as { XRWebGLLayer?: new (s: unknown, g: unknown) => unknown }).XRWebGLLayer;
  if (gl && Layer) {
    await gl.makeXRCompatible?.();
    session.updateRenderState({ baseLayer: new Layer(session, gl) });
  }
  const space = await session.requestReferenceSpace('local');
  let ended = false;
  session.addEventListener('end', () => {
    ended = true;
    onEnd();
  });
  const loop = (t: number, frame: XRFrameLike) => {
    if (ended) return;
    const pose = frame.getViewerPose(space);
    if (pose) {
      const p = pose.transform.position;
      const q = pose.transform.orientation;
      onPose({ type: 'ar', t: Math.round(performance.now() * 10) / 10, p: [r3(p.x), r3(p.y), r3(p.z)], q: [r5(q.x), r5(q.y), r5(q.z), r5(q.w)] });
    }
    session.requestAnimationFrame(loop);
  };
  session.requestAnimationFrame(loop);
  return { stop: () => session.end().catch(() => undefined) };
}
