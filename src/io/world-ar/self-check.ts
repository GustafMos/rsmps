/**
 * A self-check of the World AR view for a browser WITHOUT AR (a computer): the real WebGL painter, the real node engine, the real
 * copy from WebGPU into WebGL and the real clip recorder, driven by the fake session (fake-xr.ts) instead of a phone. It answers
 * "does the picture of the object end up at the right pixels of the AR framebuffer", which no unit test can.
 *
 * It is not an AR test: there is no camera, no tracking and no browser compositor in it. Run from the developer console:
 *   await __rsmps.io.worldAr.selfCheck(__rsmps.ed.state.graph, '<id of a node that looks through a World AR Camera>')
 * It adds nothing to the project and nothing to Media. Loaded on demand, so it costs the app nothing.
 */
import { qAxisAngle, qMul, type Vec3 } from '../../engine/lib/motion-math';
import { project, type XrPose } from '../../engine/lib/xr-math';
import type { AssetInfo, GraphDoc } from '../../engine/types';
import { WorldArController, browserWorldArEnv, type WorldArDeps, type WorldArTake, type WorldArViewState } from './controller';
import { FakeXrSystem, fakeTransform } from './fake-xr';
import { GlPainter } from './painter';

export interface SelfCheckResult {
  /** How the picture got from WebGPU into WebGL here. */
  route: string;
  /** Middle of what was drawn (alpha-weighted, pixels from the top-left) and how many pixels it covers. */
  drawn: { x: number; y: number; pixels: number };
  /** Where the surface point's own picture should be by plain projection (the object stands on it, so the middle is above this). */
  surfacePoint: { x: number; y: number };
  /** The same after the "phone" turned and before a new picture arrived: the old picture must have moved with the room. */
  afterTurn: { drawn: { x: number; y: number; pixels: number }; shiftExpected: { x: number; y: number }; shiftDrawn: { x: number; y: number } };
  take: { frames: number; clip: boolean } | null;
  clipBytes: number;
  renderMs: number;
  copyMs: number;
  error: string | null;
  /** The last sentence the view showed. */
  hint: string;
  picture: { width: number; height: number } | null;
  states: number;
}

const W = 360;
const H = 640;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelfCheck(deps: WorldArDeps, graph: GraphDoc, node: string): Promise<SelfCheckResult> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('No WebGL here.');
  // stands in for the session's framebuffer
  const fb = gl.createFramebuffer();
  const color = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  // stands in for the browser's camera picture: a plain colour is enough to see that a clip gets recorded
  const cam = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, cam);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 60, 60, 255, 60, 200, 60, 255, 60, 60, 200, 255, 220, 220, 220, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  const eye: XrPose = { p: [0, 1.3, 0], q: qAxisAngle('x', -35) };
  const floor: XrPose = { p: [0, 0, -1.6], q: [0, 0, 0, 1] };
  const xr = new FakeXrSystem({ width: W, height: H, framebuffer: fb, lens: [1.9, 1.9 * (W / H), 0, 0] });
  xr.onSession = (s) => {
    s.viewer = eye;
    s.hit = floor;
    s.camera = { width: 180, height: 320 };
  };
  const base = browserWorldArEnv();
  const files: File[] = [];
  const states: WorldArViewState[] = [];
  const takes: WorldArTake[] = [];
  const ctl = new WorldArController(
    { ...deps, add: async (f) => (files.push(...f), f.map((x, i) => ({ id: `self-check-${i}`, name: x.name }) as unknown as AssetInfo)) },
    {
      ...base,
      xr,
      makeTransform: fakeTransform,
      async makePainter() {
        const painter = new GlPainter(gl);
        painter.binding = { getCameraImage: () => cam };
        return { painter, layer: xr.session!.layer, dispose: () => painter.dispose() };
      },
    },
  );
  const read = (): { x: number; y: number; pixels: number } => {
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sx = 0;
    let sy = 0;
    let m = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = px[(y * W + x) * 4 + 3];
      sx += a * (x + 0.5);
      sy += a * (H - y - 0.5); // readPixels counts rows from the bottom
      m += a;
    }
    return { x: m ? sx / m : -1, y: m ? sy / m : -1, pixels: Math.round(m / 255) };
  };
  const toPixel = (view: XrPose, p: Vec3) => {
    const n = project(view, xr.session!.lens, p) ?? [0, 0];
    return { x: ((n[0] + 1) / 2) * W, y: ((1 - n[1]) / 2) * H };
  };

  const handle = await ctl.open({ graph: () => graph, node, card: { mode: 'upright', width: 0.5 }, overlay: null, onState: (s) => states.push(s), onTake: (t) => takes.push(t) });
  const session = xr.session!;
  let error: string | null = null;
  try {
    session.step();
    handle.place();
    // camera frames until a picture of the object has arrived and been drawn
    let drawn = { x: -1, y: -1, pixels: 0 };
    for (let i = 0; i < 200 && drawn.pixels < 10; i++) {
      session.step();
      await sleep(15);
      drawn = read();
    }
    // let the last request finish, then draw once more so the picture on screen was rendered for exactly this pose
    await sleep(120);
    session.step();
    await sleep(120);
    session.step();
    drawn = read();
    const surfacePoint = toPixel(eye, floor.p);
    // the phone turns; the very next camera frame still has the old picture
    const yawed: XrPose = { p: eye.p, q: qMul(qAxisAngle('y', 6), eye.q) };
    session.viewer = yawed;
    session.step();
    const after = read();
    const a = toPixel(eye, floor.p);
    const b = toPixel(yawed, floor.p);
    // a short recording
    handle.toggleRecord();
    for (let i = 0; i < 45; i++) {
      session.viewer = { p: [i * 0.004, 1.3, 0], q: eye.q };
      session.step();
      await sleep(34);
    }
    handle.toggleRecord();
    for (let i = 0; i < 100 && !takes.length; i++) await sleep(50);
    const st = handle.state();
    const t = takes[0] ?? null;
    return {
      route: st.route,
      drawn,
      surfacePoint,
      afterTurn: { drawn: after, shiftExpected: { x: b.x - a.x, y: b.y - a.y }, shiftDrawn: { x: after.x - drawn.x, y: after.y - drawn.y } },
      take: t?.take ? { frames: t.take.frames, clip: t.take.clip } : null,
      clipBytes: files[0]?.size ?? 0,
      renderMs: st.renderMs,
      copyMs: st.copyMs,
      error: t?.error ?? st.error ?? error,
      hint: states.length ? states[states.length - 1].hint : '',
      picture: st.picture,
      states: states.length,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await handle.close().catch(() => undefined);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(color);
    gl.deleteTexture(cam);
  }
}
