import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { projectRef, viewSetup } from '../../lib/splat-math';
import { resetSplatDebug, splatDebug } from '../../lib/splat-render';
import { buildNode, cam, evalPort, moments, readHalf } from '../../lib/splat-testutil';
import type { ImageValue } from '../../types';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 120_000 };
const IW = 192;
const IH = 128;
const CAP = { position: [0, 0, -4.5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 40 };

/** A scene as a picture + depth: grey far background with a green marker, a red near square. White depth = near (3.5), black = far (5.5). */
async function layers() {
  const t = await H();
  const inRed = (x: number, y: number) => x >= 110 && x < 150 && y >= 40 && y < 90;
  const inGreen = (x: number, y: number) => x >= 30 && x < 60 && y >= 20 && y < 50;
  const image = t.fromFn(IW, IH, (x, y) => (inRed(x, y) ? [255, 0, 0, 255] : inGreen(x, y) ? [0, 255, 0, 255] : [110, 110, 110, 255]));
  const depth = t.fromFn(IW, IH, (x, y) => (inRed(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  return { t, image, depth };
}
async function render(t: Awaited<ReturnType<typeof H>>, params: Record<string, unknown>, wire: Parameters<typeof buildNode>[3], project?: Record<string, number>) {
  const g = buildNode(t, 'image-to-splats', params, wire, project);
  return t.pixels((await evalPort(t, g)) as ImageValue);
}
/** Pixel centroid and count of pixels near a colour. */
function blob(px: { data: Uint8ClampedArray; width: number; height: number }, rgb: [number, number, number], tol = 70) {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
    const i = (y * px.width + x) * 4;
    if (px.data[i + 3] > 200 && Math.abs(px.data[i] - rgb[0]) < tol && Math.abs(px.data[i + 1] - rgb[1]) < tol && Math.abs(px.data[i + 2] - rgb[2]) < tol) {
      n++; sx += x + 0.5; sy += y + 0.5;
    }
  }
  return { n, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN };
}
/** Where the capture camera's pixel (u, v) at distance d appears in another camera's frame (pixels, y down). */
function appears(view: ReturnType<typeof cam>, uPx: number, vPx: number, dist: number, W: number, H2: number) {
  const ish = Math.min(IW, IH);
  const uf = [(uPx - IW / 2) / (ish / 2), -(vPx - IH / 2) / (ish / 2)];
  const tanH = Math.tan((CAP.fov * Math.PI) / 360);
  const dir = [uf[0] * tanH, uf[1] * tanH, 1];
  const l = Math.hypot(...dir);
  const P: [number, number, number] = [CAP.position[0] + (dir[0] / l) * dist, CAP.position[1] + (dir[1] / l) * dist, CAP.position[2] + (dir[2] / l) * dist];
  const v = viewSetup(view, W, H2);
  const pr = projectRef(v, P, [1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6]);
  return [W / 2 + pr.centre[0], H2 / 2 - pr.centre[1]];
}

describe('capture view', () => {
  it('has no holes and reproduces the picture (a depth ramp and a gradient picture, several densities)', T, async () => {
    const t = await H();
    const img = t.fromFn(IW, IH, (x, y) => [Math.round((x / (IW - 1)) * 255), Math.round((y / (IH - 1)) * 255), 120, 255]);
    const ramp = t.fromFn(IW, IH, (x) => { const g = Math.round((x / (IW - 1)) * 255); return [g, g, g, 255]; });
    for (const density of [192, 96, 48]) {
      const px = await render(t, { density, near: 3.5, far: 5.5, edgeBreak: 0 }, { image: img, depth: ramp });
      let holes = 0, err = 0, n = 0;
      for (let y = 6; y < IH - 6; y++) for (let x = 6; x < IW - 6; x++) {
        const i = (y * IW + x) * 4;
        if (px.data[i + 3] < 250) holes++;
        err += Math.abs(px.data[i] - (x / (IW - 1)) * 255) + Math.abs(px.data[i + 1] - (y / (IH - 1)) * 255);
        n += 2;
      }
      expect(holes, `density ${density}`).toBe(0);
      expect(err / n, `density ${density} mean error`).toBeLessThan(density === 192 ? 2 : density === 96 ? 3 : 6);
    }
  });

  it('a picture without depth also fills the frame (flat card guess): no holes, transparent where the picture is', T, async () => {
    const t = await H();
    const img = t.fromFn(IW, IH, (x, y) => (x < IW / 2 ? [200, 60, 60, 255] : y < IH / 2 ? [60, 200, 60, 255] : [0, 0, 0, 0]));
    const px = await render(t, { density: 192, guess: 'flat' }, { image: img });
    expect(px.at(40, 64)[0]).toBeGreaterThan(190);
    expect(px.at(150, 20)[1]).toBeGreaterThan(190);
    expect(px.at(150, 100)[3]).toBe(0);
    expect(px.at(40, 64)[3]).toBe(255);
  });
});

describe('parallax and occlusion', () => {
  it('a near object shifts more than a far one when the camera moves, by 1 / depth', T, async () => {
    const { t, image, depth } = await layers();
    const params = { density: 192, near: 3.5, far: 5.5 };
    const base = await render(t, params, { image, depth });
    const baseRed = blob(base, [255, 0, 0]);
    const baseGreen = blob(base, [0, 255, 0]);
    expect(baseRed.n).toBeGreaterThan(1500);
    // the capture view reproduces the picture's layout
    expect(baseRed.cx).toBeCloseTo(130, 0);
    expect(baseGreen.cx).toBeCloseTo(45, 0);
    for (const dx of [0.4, -0.4]) {
      const moved = cam({ ...CAP, position: [dx, 0, -4.5], target: [dx, 0, 0] }); // slide the camera sideways
      const px = await render(t, params, { image, depth, camera: moved });
      const red = blob(px, [255, 0, 0]);
      const green = blob(px, [0, 255, 0]);
      const dRed = red.cx - baseRed.cx;
      const dGreen = green.cx - baseGreen.cx;
      expect(Math.sign(dRed)).toBe(-Math.sign(dx)); // the world slides the other way
      expect(Math.abs(dRed)).toBeGreaterThan(Math.abs(dGreen) * 1.3);
      // and by exactly the projected amount (distances 3.5 and 5.5 from the capture camera)
      const wantRed = appears(moved, 130, 65, 3.5, IW, IH);
      const wantGreen = appears(moved, 45, 35, 5.5, IW, IH);
      expect(Math.abs(red.cx - wantRed[0]), `red x ${red.cx} vs ${wantRed[0]}`).toBeLessThan(1.5);
      expect(Math.abs(green.cx - wantGreen[0]), `green x ${green.cx} vs ${wantGreen[0]}`).toBeLessThan(1.5);
      expect(Math.abs(red.cy - wantRed[1])).toBeLessThan(1.5);
    }
  });

  it('the near square stays in front from every side (no splat of the background is drawn over it)', T, async () => {
    const { t, image, depth } = await layers();
    const params = { density: 192, near: 3.5, far: 5.5 };
    const base = blob(await render(t, params, { image, depth }), [255, 0, 0]);
    const moves: [number, number, number][] = [[0.7, 0, -4.4], [-0.7, 0, -4.4], [0, 0.6, -4.4], [0, -0.6, -4.4], [0.6, 0.5, -4.8], [-0.6, -0.5, -4.0], [0.2, 0.1, -3.5], [0.3, 0.2, -7], [1.5, 0.2, -3.0], [-1.5, -0.4, -2.5]];
    for (const position of moves) {
      const view = cam({ position, target: [0, 0, 0], fov: 40 });
      const px = await render(t, params, { image, depth, camera: view });
      const red = blob(px, [255, 0, 0]);
      // the red area changes with perspective but must stay a solid block: compare with the exact projected quad's area
      const corners = [[110, 40], [150, 40], [150, 90], [110, 90]].map(([u, v]) => appears(view, u, v, 3.5, IW, IH));
      let area = 0;
      for (let k = 0; k < 4; k++) area += corners[k][0] * corners[(k + 1) % 4][1] - corners[(k + 1) % 4][0] * corners[k][1];
      area = Math.abs(area) / 2;
      expect(red.n, `camera ${position}: red ${red.n} vs projected ${area.toFixed(0)}`).toBeGreaterThan(area * 0.9);
      expect(red.n).toBeLessThan(area * 1.6); // soft edges and the stretched walls of a steep view add red; only a LOSS of red would mean wrong order
      void base;
    }
  });

  it('works on every frame of a video with no sort, no upload and no readback of the cloud', T, async () => {
    const { t, depth } = await layers();
    resetSplatDebug();
    for (let f = 0; f < 5; f++) {
      const frame = t.fromFn(IW, IH, (x, y) => [(x * 3 + f * 40) % 256, (y * 2) % 256, 90, 255]);
      const px = await render(t, { density: 128 }, { image: frame, depth, camera: cam({ ...CAP, position: [0.3 * Math.sin(f), 0, -4.5] }) });
      expect(px.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    }
    expect(splatDebug.sorts).toBe(0);
    expect(splatDebug.uploads).toBe(0);
    expect(splatDebug.draws).toBe(5);
  });
});

describe('depth', () => {
  it('brightness encodings: white near / black near, between the Near and Far distances', T, async () => {
    const t = await H();
    const img = t.solid(IW, IH, [200, 100, 50, 255]);
    const white = t.solid(IW, IH, [255, 255, 255, 255]);
    const black = t.solid(IW, IH, [0, 0, 0, 255]);
    const read = async (encoding: string, d: ImageValue) => {
      const g = buildNode(t, 'image-to-splats', { density: 96, depthEncoding: encoding, near: 3, far: 6 }, { image: img, depth: d });
      const out = (await evalPort(t, g, 'depth')) as ImageValue;
      return (await readHalf(t, out))[(64 * IW + 96) * 4];
    };
    expect(await read('luma-near-white', white)).toBeCloseTo(3, 1);
    expect(await read('luma-near-white', black)).toBeCloseTo(6, 1);
    expect(await read('luma-near-black', white)).toBeCloseTo(6, 1);
    expect(await read('luma-near-black', black)).toBeCloseTo(3, 1);
  });

  it('From 3D nodes: the Depth output of 3D Object round-trips (same distances at the capture view) and a miss draws nothing', T, async () => {
    const t = await H();
    const capCam = cam({ position: [0, 0.4, -4], target: [0, 0, 0], fov: 40 });
    const g = buildNode(t, 'object-3d', { shape: 'sphere', baseColor: [0.9, 0.4, 0.1, 1], scale: 0.7 }, { camera: capCam }, { width: 128, height: 96 });
    const image = (await evalPort(t, g, 'image')) as ImageValue;
    const depth = (await evalPort(t, g, 'depth')) as ImageValue;
    t.gpu.retain(image.texture);
    t.gpu.retain(depth.texture);
    const dIn = await readHalf(t, depth);
    const s = buildNode(t, 'image-to-splats', { density: 128, depthEncoding: 'scene', edgeBreak: 0 }, { image, depth, camera: capCam, captureCamera: capCam });
    const px = await t.pixels((await evalPort(t, s)) as ImageValue);
    const dOut = await readHalf(t, (await evalPort(t, s, 'depth')) as ImageValue);
    const errs: number[] = [];
    for (let y = 20; y < 76; y++) for (let x = 30; x < 98; x++) {
      const i = (y * 128 + x) * 4;
      if (dIn[i + 3] > 0.5 && dOut[i + 3] > 0.5) {
        errs.push(Math.abs(dIn[i] - dOut[i]));
      }
    }
    errs.sort((a, b) => a - b);
    expect(errs.length).toBeGreaterThan(1500);
    expect(errs[errs.length >> 1]).toBeLessThan(0.03); // median: the same distances
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.08); // the steep rim of the sphere is the only place that differs
    expect(px.at(2, 2)[3]).toBe(0); // the background (a miss in the depth) draws nothing
    expect(px.at(64, 48)[0]).toBeGreaterThan(150);
  });

  it('without a Depth wired the result is a labelled guess; the guess modes differ', T, async () => {
    const t = await H();
    const img = t.fromFn(IW, IH, (x, y) => [(x * 2) % 256, (y * 2) % 256, 100, 255]);
    const view = cam({ ...CAP, position: [0.8, 0.2, -4.2] });
    const out: Record<string, Uint8ClampedArray> = {};
    for (const guess of ['flat', 'luminance', 'bulge', 'luminance-bulge']) out[guess] = (await render(t, { density: 128, guess, edgeBreak: 0 }, { image: img, camera: view })).data;
    const d = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    expect(d(out.flat, out.bulge)).toBeGreaterThan(1);
    expect(d(out.flat, out.luminance)).toBeGreaterThan(1);
    expect(t.registry.get('image-to-splats')!.summary!({ density: 640, guess: 'bulge', depthEncoding: 'luma-near-white' } as never, new Set())).toMatch(/No depth wired: showing a center bulge guess. Add Depth from Picture/);
  });
});

describe('look and cost', () => {
  it('edge break: a depth jump stretches splats unless Edge break shrinks or drops them', T, async () => {
    const { t, image, depth } = await layers();
    const view = cam({ ...CAP, position: [1.0, 0, -4.3], target: [0, 0, 0] });
    const off = await render(t, { density: 192, edgeBreak: 0 }, { image, depth, camera: view });
    const shrink = await render(t, { density: 192, edgeBreak: 0.6, edgeMode: 'shrink' }, { image, depth, camera: view });
    const drop = await render(t, { density: 192, edgeBreak: 0.6, edgeMode: 'drop' }, { image, depth, camera: view });
    const cover = (px: { data: Uint8ClampedArray }) => Array.from({ length: IW * IH }, (_, i) => px.data[i * 4 + 3]).reduce((s, v) => s + v, 0);
    expect(cover(off)).toBeGreaterThan(cover(shrink));
    expect(cover(shrink)).toBeGreaterThan(cover(drop));
    expect(cover(drop)).toBeGreaterThan(0);
  });

  it('sliders never compile or sort; the same inputs give the same pixels; jitter is stable', T, async () => {
    const t = await H();
    const { image, depth } = await layers();
    const view = cam({ ...CAP, position: [0.5, 0.2, -4.2] });
    resetSplatDebug();
    const a = await render(t, { density: 160 }, { image, depth, camera: view });
    const pipelines = splatDebug.pipelines;
    const gpuPipelines = t.gpu.stats().objects.pipelinesCreated;
    for (const p of [{ density: 100 }, { splatSize: 1.5 }, { thickness: 0.8 }, { near: 3 }, { far: 7 }, { edgeBreak: 0.2 }, { jitter: 0.6 }, { opacity: 0.7 }, { captureFov: 60 }, { captureDistance: 5 }, { splatShape: 'sharp' }, { splatShape: 'square' }, { background: [0, 0, 1, 1] }]) {
      await render(t, { density: 160, ...p }, { image, depth, camera: view });
    }
    expect(splatDebug.pipelines).toBe(pipelines);
    expect(t.gpu.stats().objects.pipelinesCreated).toBe(gpuPipelines);
    expect(splatDebug.sorts).toBe(0);
    const j1 = await render(t, { density: 160, jitter: 0.8 }, { image, depth, camera: view });
    const j2 = await render(t, { density: 160, jitter: 0.8, opacity: 0.9999 }, { image, depth, camera: view });
    expect(j1.data.some((v, i) => v !== a.data[i])).toBe(true);
    expect(j1.data.reduce((s, v, i) => s + Math.abs(v - j2.data[i]), 0) / j1.data.length).toBeLessThan(0.5);
  });

  it('default density is about 230,000 splats on a 16:9 picture; output follows the picture size unless Size from is wired', T, async () => {
    const t = await H();
    const def = t.registry.get('image-to-splats')!.params.density as { default: number };
    expect(def.default).toBe(640);
    const w = 1920, h = 1080;
    const gw = Math.round(def.default * (w / Math.max(w, h)));
    const gh = Math.round(def.default * (h / Math.max(w, h)));
    expect(gw * gh).toBeGreaterThan(150_000);
    expect(gw * gh).toBeLessThan(300_000);
    const img = t.solid(80, 40, [255, 0, 0, 255]);
    const own = (await evalPort(t, buildNode(t, 'image-to-splats', { density: 40 }, { image: img }))) as ImageValue;
    expect([own.width, own.height]).toEqual([80, 40]);
    const bigger = t.solid(160, 100, [0, 0, 0, 255]);
    const sized = (await evalPort(t, buildNode(t, 'image-to-splats', { density: 40 }, { image: img, size: bigger }))) as ImageValue;
    expect([sized.width, sized.height]).toEqual([160, 100]);
  });

  it('an orthographic view keeps depth-independent scale and parallax by view angle', T, async () => {
    const { t, image, depth } = await layers();
    const px = await render(t, { density: 192, near: 3.5, far: 5.5 }, { image, depth, camera: cam({ projection: 'orthographic', orthoSize: 3, position: [0, 0, -4.5], target: [0, 0, 0] }) });
    const red = blob(px, [255, 0, 0]);
    expect(red.n).toBeGreaterThan(500);
    const rot = await render(t, { density: 192, near: 3.5, far: 5.5 }, { image, depth, camera: cam({ projection: 'orthographic', orthoSize: 3, position: [1.6, 0, -4.2], target: [0, 0, 0] }) });
    const green = blob(px, [0, 255, 0]);
    const greenRot = blob(rot, [0, 255, 0]);
    const redRot = blob(rot, [255, 0, 0]);
    // orthographic parallax: the shift is proportional to the DIFFERENCE in depth from the focal plane
    expect(Math.abs(redRot.cx - red.cx)).toBeGreaterThan(1);
    expect(Math.abs(greenRot.cx - green.cx)).toBeGreaterThan(1);
    expect(redRot.cx - red.cx).not.toBeCloseTo(greenRot.cx - green.cx, 0);
    void moments;
  });
});
