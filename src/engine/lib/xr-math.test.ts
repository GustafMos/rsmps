import { describe, expect, it } from 'vitest';
import { cameraBasis } from './gen-camera';
import { qAxisAngle, qMul, rotate, type Quat, type Vec3 } from './motion-math';
import { buildWorldTake, isWorldTake, sampleWorldTake, worldTakeDuration, type WorldSample, type WorldTake } from './world-take';
import {
  cardCorners,
  depthOf,
  layerCorners,
  lensAspect,
  lensFor,
  lensFromFov,
  lensOf,
  mat4Mul,
  placementQuat,
  poseInv,
  poseMul,
  project,
  projectionMatrix,
  rayPlane,
  reticleCorners,
  sceneToWorld,
  unproject,
  viewMatrix,
  viewRay,
  worldCamera,
  yawFacing,
  type Lens,
  type Placement,
  type XrPose,
} from './xr-math';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
};
const FIT = { unit: 1, lift: 0 };
const PORTRAIT = { width: 900, height: 1600 };
const lens: Lens = lensFromFov(60, 9 / 16);
const identity: Quat = [0, 0, 0, 1];

describe('axes: WebXR (looks along -z) to the scene (z into the screen)', () => {
  it('a viewer at the WebXR identity looks along the scene\'s +z, x stays right and y stays up', () => {
    const cam = worldCamera({ p: [0, 0, 0], q: identity }, lens, { p: [0, 0, -2], q: identity, yaw: 0, scale: 1 }, FIT, PORTRAIT);
    const b = cameraBasis(cam);
    close(b.forward, [0, 0, 1]);
    close(b.right, [1, 0, 0]);
    close(b.up, [0, 1, 0]);
    // the object is 2 m in front of the viewer: the camera is 2 units in front of the scene's origin, on -z like the default camera
    close(cam.position, [0, 0, -2]);
    expect(cam.projection).toBe('perspective');
  });
  it('walking to the right in the room moves the camera to the scene\'s +x; up is up', () => {
    const cam = worldCamera({ p: [0.5, 0.3, 0], q: identity }, lens, { p: [0, 0, -2], q: identity, yaw: 0, scale: 1 }, FIT, PORTRAIT);
    close(cam.position, [0.5, 0.3, -2]);
  });
  it('size and lift: half-size units double the camera\'s distance in scene units; lift lowers the camera by that much', () => {
    const cam = worldCamera({ p: [0, 1, 0], q: identity }, lens, { p: [0, 0, -2], q: identity, yaw: 0, scale: 2 }, { unit: 0.25, lift: 1 }, PORTRAIT);
    // 1 scene unit = 2 * 0.25 = 0.5 m: 2 m away = 4 units, 1 m up = 2 units, minus the lift
    close(cam.position, [0, 1, -4]);
  });
  it('turning the phone to its right (about the room\'s up, clockwise from above) turns the camera to the scene\'s +x', () => {
    const cam = worldCamera({ p: [0, 0, 0], q: qAxisAngle('y', -90) }, lens, { p: [0, 0, -2], q: identity, yaw: 0, scale: 1 }, FIT, PORTRAIT);
    close(cameraBasis(cam).forward, [1, 0, 0], 5);
  });
  it('rolling the phone rolls the camera, with no trouble when it points straight down', () => {
    for (const q of [qAxisAngle('z', 30), qMul(qAxisAngle('x', -90), qAxisAngle('z', 50)), qMul(qAxisAngle('y', 200), qAxisAngle('x', 89.9))]) {
      const cam = worldCamera({ p: [0, 1, 1], q }, lens, { p: [0, 0, 0], q: identity, yaw: 0, scale: 1 }, FIT, PORTRAIT);
      const b = cameraBasis(cam);
      const flip = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];
      close(b.forward, flip(rotate(q, [0, 0, -1])), 5);
      close(b.right, flip(rotate(q, [1, 0, 0])), 5);
      close(b.up, flip(rotate(q, [0, 1, 0])), 5);
    }
  });
  it('the twist turns the object, so the camera goes round it the other way', () => {
    const view: XrPose = { p: [0, 0, 2], q: identity };
    const cam = worldCamera(view, lens, { p: [0, 0, 0], q: identity, yaw: 90, scale: 1 }, FIT, PORTRAIT);
    // object turned 90 degrees anticlockwise from above: its front (+z) now faces the room's +x, so the viewer on +z sees its side
    close(cam.position, [-2, 0, 0], 5);
    close(cameraBasis(cam).forward, [1, 0, 0], 5);
  });
  it('sceneToWorld is the inverse of what the camera does: a scene point lands where the camera sees it', () => {
    const pl: Placement = { p: [0.3, 0.1, -1], q: qMul(qAxisAngle('x', 10), qAxisAngle('z', -5)), yaw: 33, scale: 1.7 };
    const fit = { unit: 0.2, lift: 1 };
    const view: XrPose = { p: [0.2, 1.3, 0.8], q: qMul(qAxisAngle('y', 12), qAxisAngle('x', -35)) };
    const cam = worldCamera(view, lens, pl, fit, PORTRAIT);
    const b = cameraBasis(cam);
    for (const point of [[0, 0, 0], [1, 0.5, -0.3], [-0.4, 2, 1]] as Vec3[]) {
      const w = sceneToWorld(point, pl, fit);
      const ndc = project(view, lens, w)!;
      // the same point through the app camera: camera-space x / z over tan(fov / 2), plus the shift
      const rel: Vec3 = [point[0] - cam.position[0], point[1] - cam.position[1], point[2] - cam.position[2]];
      const dot = (a: Vec3, c: Vec3) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
      const t = Math.tan((cam.fov * Math.PI) / 360);
      const short = Math.min(PORTRAIT.width, PORTRAIT.height);
      const px = ((dot(rel, b.right) / dot(rel, b.forward) / t + 2 * cam.shift[0]) * short) / 2;
      const py = ((dot(rel, b.up) / dot(rel, b.forward) / t + 2 * cam.shift[1]) * short) / 2;
      expect(px).toBeCloseTo((ndc[0] * PORTRAIT.width) / 2, 3);
      expect(py).toBeCloseTo((ndc[1] * PORTRAIT.height) / 2, 3);
    }
  });
});

describe('the lens', () => {
  it('reads the four numbers out of a projection matrix and its picture shape', () => {
    const l = lensOf(projectionMatrix([1.9, 1.07, 0.02, -0.03]));
    close(l, [1.9, 1.07, 0.02, -0.03]);
    expect(lensAspect(lensFromFov(60, 9 / 16))).toBeCloseTo(9 / 16, 9);
  });
  it('portrait: the field of view is the horizontal one (the shorter side); landscape: the vertical one', () => {
    const p = lensFor(lensFromFov(60, 9 / 16), 900, 1600);
    const horizontal = (2 * Math.atan(Math.tan(Math.PI / 6) * (9 / 16)) * 180) / Math.PI;
    expect(p.fov).toBeCloseTo(horizontal, 6);
    expect(lensFor(lensFromFov(40, 16 / 9), 1600, 900).fov).toBeCloseTo(40, 6);
    close(p.shift, [0, 0]);
  });
  it('an off-centre lens becomes a shift, in units of the shorter side', () => {
    const l: Lens = [lensFromFov(60, 9 / 16)[0], lensFromFov(60, 9 / 16)[1], 0.1, -0.2];
    const s = lensFor(l, 900, 1600).shift;
    // 0.1 of half the width to the left; -0.2 of half the height = 0.2 * 800 px up, in units of the 900 px short side
    expect(s[0]).toBeCloseTo(-0.05, 6);
    expect(s[1]).toBeCloseTo((0.2 * 800) / 900, 6);
  });
  it('a picture of another shape gets the lens\'s picture fitted inside it', () => {
    const l = lensFromFov(60, 9 / 16);
    // a square canvas: the 9:16 picture is as high as the canvas, so the vertical field of view fills the square's side
    expect(lensFor(l, 1000, 1000).fov).toBeCloseTo(60, 6);
    // a wide canvas: still fitted by height
    expect(lensFor(l, 1600, 900).fov).toBeCloseTo(60, 6);
  });
});

describe('poses and placement', () => {
  it('poseMul and poseInv undo each other', () => {
    const a: XrPose = { p: [1, 2, 3], q: qMul(qAxisAngle('y', 40), qAxisAngle('x', 20)) };
    const b: XrPose = { p: [-0.5, 0.2, 0.1], q: qAxisAngle('z', 70) };
    const back = poseMul(poseInv(a), poseMul(a, b));
    close(back.p, b.p);
    close(rotate(back.q, [1, 2, 3]), rotate(b.q, [1, 2, 3]));
  });
  it('yawFacing turns the object\'s front (+z of its frame) towards the viewer, on a floor and on a tilted surface', () => {
    for (const surface of [{ p: [0, 0, 0] as Vec3, q: identity }, { p: [1, 0.2, -1] as Vec3, q: qMul(qAxisAngle('y', 77), qAxisAngle('x', 15)) }]) {
      for (const viewer of [[2, 1.5, 0], [0, 1.5, 2], [-1, 1, -3], [0.5, 0.2, 0.1]] as Vec3[]) {
        const yaw = yawFacing(surface, viewer);
        const front = rotate(placementQuat({ q: surface.q, yaw }), [0, 0, 1]);
        const normal = rotate(surface.q, [0, 1, 0]);
        const to: Vec3 = [viewer[0] - surface.p[0], viewer[1] - surface.p[1], viewer[2] - surface.p[2]];
        // the direction to the viewer, flattened onto the surface
        const d = to[0] * normal[0] + to[1] * normal[1] + to[2] * normal[2];
        const flat: Vec3 = [to[0] - d * normal[0], to[1] - d * normal[1], to[2] - d * normal[2]];
        const l = Math.hypot(...flat);
        close(front, [flat[0] / l, flat[1] / l, flat[2] / l], 5);
      }
    }
    expect(yawFacing({ p: [0, 0, 0], q: identity }, [0, 2, 0])).toBe(0); // straight above: no direction to prefer
  });
});

describe('geometry the AR view draws with', () => {
  const view: XrPose = { p: [0.2, 1.4, 0.5], q: qMul(qAxisAngle('y', 25), qAxisAngle('x', -30)) };
  const off: Lens = [1.9, 1.07, 0.05, -0.04];
  it('project and unproject are inverses, and agree with the 4x4 matrices', () => {
    const w = unproject(view, off, 0.3, -0.6, 2.5);
    close(project(view, off, w)!, [0.3, -0.6]);
    expect(depthOf(view, w)).toBeCloseTo(2.5, 6);
    const m = mat4Mul(projectionMatrix(off), viewMatrix(view));
    const clip = [0, 1, 2, 3].map((r) => m[r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r]);
    close([clip[0] / clip[3], clip[1] / clip[3]], [0.3, -0.6], 5);
    expect(project(view, off, unproject(view, off, 0, 0, -1))).toBeNull(); // behind the viewer
  });
  it('the layer rectangle exactly fills the lens it was rendered for', () => {
    const c = layerCorners(view, off, 1.8);
    const want = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    c.forEach((p, i) => close(project(view, off, p)!, want[i], 5));
  });
  it('after the phone turns, the middle of the layer is still where the object is, not in the middle of the screen', () => {
    const object: Vec3 = unproject(view, off, 0, 0, 2);
    const c = layerCorners(view, off, 2);
    const middle: Vec3 = [(c[0][0] + c[3][0]) / 2, (c[0][1] + c[3][1]) / 2, (c[0][2] + c[3][2]) / 2];
    const turned: XrPose = { p: view.p, q: qMul(view.q, qAxisAngle('y', 8)) };
    const a = project(turned, off, middle)!;
    const b = project(turned, off, object)!;
    close(a, b, 2);
    expect(Math.abs(b[0])).toBeGreaterThan(0.1); // and that is well off the middle of the new view
  });
  it('an upright card stands on the surface, reads the right way round from the front, and is as wide as asked', () => {
    const pl: Placement = { p: [0, 0, 0], q: identity, yaw: 0, scale: 2 };
    const [bl, br, tl, tr] = cardCorners(pl, 'upright', 0.5, 2, [0, 1, 3]);
    close(bl, [-0.5, 0, 0]);
    close(br, [0.5, 0, 0]);
    close(tl, [-0.5, 0.5, 0]);
    close(tr, [0.5, 0.5, 0]);
    // from the front (the viewer on +z looking back) the bottom-left corner is on the left of the picture
    const front: XrPose = { p: [0, 0.25, 3], q: identity };
    expect(project(front, lens, bl)![0]).toBeLessThan(project(front, lens, br)![0]);
    expect(project(front, lens, tl)![1]).toBeGreaterThan(project(front, lens, bl)![1]);
  });
  it('a flat card lies on the surface with its top away from the front; a billboard turns to the viewer', () => {
    const pl: Placement = { p: [0, 0, 0], q: identity, yaw: 0, scale: 1 };
    const flat = cardCorners(pl, 'flat', 1, 1, [0, 1, 3]);
    for (const c of flat) expect(c[1]).toBeCloseTo(0, 9);
    expect(flat[2][2]).toBeLessThan(flat[0][2]); // top is further from a viewer on +z
    const viewer: Vec3 = [3, 1, 0];
    const bb = cardCorners(pl, 'billboard', 1, 1, viewer);
    // the card's width runs across the line to the viewer
    const across: Vec3 = [bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]];
    expect(across[0] * viewer[0] + across[2] * viewer[2]).toBeCloseTo(0, 6);
    const eye: XrPose = { p: viewer, q: qAxisAngle('y', 90) }; // at +x looking back along -x
    expect(project(eye, lens, bb[0])![0]).toBeLessThan(project(eye, lens, bb[1])![0]);
  });
  it('the reticle lies on its surface', () => {
    const s: XrPose = { p: [1, 0.5, -2], q: qAxisAngle('x', 90) }; // a wall: the normal is horizontal
    const n = rotate(s.q, [0, 1, 0]);
    for (const c of reticleCorners(s, 0.1)) expect((c[0] - s.p[0]) * n[0] + (c[1] - s.p[1]) * n[1] + (c[2] - s.p[2]) * n[2]).toBeCloseTo(0, 9);
  });
  it('a finger\'s ray meets the floor where the finger points; not above the horizon, not too far', () => {
    const eye: XrPose = { p: [0, 1.5, 0], q: qAxisAngle('x', -45) };
    const ray = viewRay(eye, lens, 0, 0);
    const h = rayPlane(ray.origin, ray.dir, [0, 0, 0], [0, 1, 0])!;
    close(h, [0, 0, -1.5], 5);
    const up = viewRay({ p: [0, 1.5, 0], q: qAxisAngle('x', 20) }, lens, 0, 0);
    expect(rayPlane(up.origin, up.dir, [0, 0, 0], [0, 1, 0])).toBeNull();
    const grazing = viewRay({ p: [0, 1.5, 0], q: qAxisAngle('x', -1) }, lens, 0, 0);
    expect(rayPlane(grazing.origin, grazing.dir, [0, 0, 0], [0, 1, 0])).toBeNull();
    // the finger at the right edge of the screen points to the right of the middle
    const right = viewRay(eye, lens, 1, 0);
    expect(rayPlane(right.origin, right.dir, [0, 0, 0], [0, 1, 0])![0]).toBeGreaterThan(0.3);
  });
});

describe('world take', () => {
  const walk = (i: number, n: number): WorldSample => {
    const u = i / n;
    const p: Vec3 = [Math.sin(u * 3) * 0.8, 1.4 + 0.1 * Math.sin(u * 7), 1.5 - u];
    return {
      t: u * 4,
      view: { p, q: qMul(qAxisAngle('y', 60 * u - 20), qAxisAngle('x', -20 - 10 * u)) },
      lens: [1.9, 1.07, 0.01, -0.02],
      object: i < n * 0.2 ? null : { p: [0.1, 0, -0.5], q: qAxisAngle('y', 30), scale: 1 + (i > n * 0.6 ? 0.5 : 0) },
    };
  };
  it('motion only: a round trip keeps the poses to well under a millimetre and a tenth of a degree', () => {
    const n = 240; // 60 samples a second for 4 s, read back at 30 frames a second
    const samples = Array.from({ length: n + 1 }, (_, i) => walk(i, n));
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(isWorldTake(take)).toBe(true);
    expect(take.clip).toBe(false);
    expect(take.frames).toBe(121);
    expect(worldTakeDuration(take)).toBeCloseTo(121 / 30, 9);
    let worstP = 0;
    let worstA = 0;
    for (let f = 0; f <= 120; f++) {
      const want = walk(f * 2, n);
      const got = sampleWorldTake(take, f / 30);
      worstP = Math.max(worstP, Math.hypot(got.view.p[0] - want.view.p[0], got.view.p[1] - want.view.p[1], got.view.p[2] - want.view.p[2]));
      const a = rotate(got.view.q, [0, 0, -1]);
      const b = rotate(want.view.q, [0, 0, -1]);
      worstA = Math.max(worstA, (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI);
      expect(!!got.object).toBe(!!want.object);
      if (got.object && want.object) {
        close(got.object.p, want.object.p, 3);
        expect(got.object.scale).toBeCloseTo(want.object.scale, 2);
      }
      close(got.lens, want.lens, 4);
    }
    expect(worstP).toBeLessThan(0.0008);
    expect(worstA).toBeLessThan(0.05);
    // and it is compact: far fewer numbers than one per frame per channel
    const stored = Object.values(take.tracks).reduce((s, t) => s + t.length, 0);
    expect(stored).toBeLessThan(121 * 20);
  });
  it('between two frames positions are blended and orientations go the short way round', () => {
    const a: WorldSample = { t: 0, view: { p: [0, 0, 0], q: qAxisAngle('y', 170) }, lens: [1, 1, 0, 0], object: null };
    const b: WorldSample = { t: 1, view: { p: [1, 0, 0], q: qAxisAngle('y', -170) }, lens: [1, 1, 0, 0], object: null };
    const take = buildWorldTake([a, b], { fps: 1 })!;
    const mid = sampleWorldTake(take, 0.5);
    expect(mid.view.p[0]).toBeCloseTo(0.5, 4);
    // half way from 170 to -170 degrees is 180, not 0
    expect(rotate(mid.view.q, [0, 0, 1])[2]).toBeCloseTo(-1, 3);
  });
  it('with a camera clip: frame n is exactly the pose of clip frame n, and a frame the recorder skipped holds the one before', () => {
    const frames = [0, 1, 2, 4, 5, 9];
    const samples: WorldSample[] = frames.map((f) => ({ t: f / 30 + 0.004, frame: f, view: { p: [f * 0.1, 1, 0], q: identity }, lens: [1.9, 1.07, 0, 0], object: { p: [0, 0, -1], q: identity, scale: 1 } }));
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(take.clip).toBe(true);
    expect(take.frames).toBe(10);
    const x = (f: number) => sampleWorldTake(take, f / 30).view.p[0];
    for (const f of frames) expect(x(f)).toBeCloseTo(f * 0.1, 3);
    expect(x(3)).toBeCloseTo(0.2, 3); // held, like the clip holds its picture
    expect(x(7)).toBeCloseTo(0.5, 3);
    expect(x(8)).toBeCloseTo(0.5, 3);
  });
  it('holds its ends, repeats when asked, and a clip that does not start at frame 0 is shifted to it', () => {
    const samples: WorldSample[] = [5, 6, 7, 8].map((f) => ({ t: f, frame: f, view: { p: [f, 0, 0], q: identity }, lens: [1, 1, 0, 0], object: null }));
    const take = buildWorldTake(samples, { fps: 10 })!;
    expect(take.frames).toBe(4);
    expect(sampleWorldTake(take, -3).view.p[0]).toBeCloseTo(5, 3);
    expect(sampleWorldTake(take, 99).view.p[0]).toBeCloseTo(8, 3);
    expect(sampleWorldTake(take, 0.5, true).view.p[0]).toBeCloseTo(6, 3); // frame 5 of a 4-frame loop is frame 1
  });
  it('before anything is placed the object is absent, and its channels do not jump from zero', () => {
    const samples: WorldSample[] = Array.from({ length: 11 }, (_, i) => ({ t: i / 10, view: { p: [0, 1, 0], q: identity }, lens: [1, 1, 0, 0], object: i < 5 ? null : { p: [3, 0, -4], q: identity, scale: 2 } }));
    const take = buildWorldTake(samples, { fps: 10 })!;
    expect(sampleWorldTake(take, 0.2).object).toBeNull();
    close(sampleWorldTake(take, 0.6).object!.p, [3, 0, -4], 3);
    expect(take.tracks.ox.every((v, i) => i % 2 === 0 || Math.abs(v - 3) < 1e-3)).toBe(true);
  });
  it('too few samples make no take; a take with channels missing still reads (neutral values)', () => {
    expect(buildWorldTake([], { fps: 30 })).toBeNull();
    expect(buildWorldTake([{ t: 0, view: { p: [0, 0, 0], q: identity }, lens: [1, 1, 0, 0], object: null }], { fps: 30 })).toBeNull();
    const bare: WorldTake = { v: 1, kind: 'world-ar', fps: 30, frames: 3, tracks: { cx: [0, 1, 2, 3] }, clip: false };
    const m = sampleWorldTake(bare, 1 / 30);
    expect(m.view.p[0]).toBeCloseTo(2, 6);
    close(m.view.q, [0, 0, 0, 1]);
    expect(m.object).toBeNull();
    expect(isWorldTake({ v: 1, fps: 30, frames: 3, raw: {} })).toBe(false); // a phone motion take is not a world take
  });
});
