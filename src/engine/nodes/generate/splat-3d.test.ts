import { describe, expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { ballCloud, manualCloud, quatAxisAngle, terrainCloud, torusCloud } from '../../lib/splat-gen';
import { dropSplatBuffers, resetSplatDebug, splatDebug } from '../../lib/splat-render';
import { projectRef, viewSetup, worldCovariance } from '../../lib/splat-math';
import { buildNode, cam, evalPort, moments, putCloud, readHalf, splatHost } from '../../lib/splat-testutil';
import type { ImageValue } from '../../types';

const files = new Map<string, ArrayBuffer>();
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness([], splatHost(files)));
const BASE = { autoFit: false, orientation: 'asis', minOpacity: 0, viewDependent: false };
const ORTHO = cam({ projection: 'orthographic', orthoSize: 4 }); // 128x96 frame: 24 px per unit
const T = { timeout: 120_000 };

async function draw(file: string, params: Record<string, unknown> = {}, wire: Parameters<typeof buildNode>[3] = { camera: ORTHO }, project?: Record<string, number>, opts: Parameters<typeof evalPort>[3] = {}) {
  const t = await H();
  const g = buildNode(t, 'splat-3d', { ...BASE, file: [file], ...params }, wire, project);
  const img = (await evalPort(t, g, 'image', opts)) as ImageValue;
  return t.pixels(img);
}
const sample = (px: { data: Uint8ClampedArray; width: number }, x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

describe('single splat', () => {
  it('renders a Gaussian falloff: alpha = opacity * exp(-0.5 d^2 / sigma^2) around the projected centre', T, async () => {
    putCloud(files, 'iso', manualCloud([{ p: [0, 0, 0], s: [0.5, 0.5, 0.5], rgb: [1, 0, 0], o: 0.9 }]));
    const px = await draw('iso');
    // sigma = 0.5 unit = 12 px; the 0.3 px low pass widens it to sqrt(144.3); the tiny-splat compensation scales alpha by sqrt(144 / 144.3)
    const comp = Math.sqrt(144 / 144.3);
    for (const d of [0, 6, 12, 18, 24, 30, 36]) {
      const [r, g, b, a] = sample(px, 64 + d, 48); // pixel (64 + d) has its centre d + 0.5 from the centre line x = 64
      const dd = d + 0.5;
      const want = 255 * 0.9 * comp * Math.exp((-0.5 * dd * dd) / 144.3) * Math.exp((-0.5 * 0.25) / 144.3);
      expect(Math.abs(a - want), `d=${d}: alpha ${a} vs ${want.toFixed(1)}`).toBeLessThan(3.2);
      if (a > 20) expect([r, g, b]).toEqual([255, 0, 0]);
    }
    // diagonal and vertical samples follow the same law (isotropic)
    for (const [dx, dy] of [[8, 8], [0, 15], [-12, 5]]) {
      const [, , , a] = sample(px, 64 + dx, 48 + dy);
      const dd = Math.hypot(dx + 0.5, dy + 0.5);
      const want = 255 * 0.9 * comp * Math.exp((-0.5 * dd * dd) / 144.3);
      expect(Math.abs(a - want)).toBeLessThan(3.5);
    }
    // outside 3.3 sigma nothing is drawn; the corner is transparent
    expect(sample(px, 2, 2)[3]).toBe(0);
    const m = moments(px);
    expect(m.cx).toBeCloseTo(64, 1);
    expect(m.cy).toBeCloseTo(48, 1);
  });

  it('projects an anisotropic rotated splat to the reference ellipse (orthographic and perspective)', T, async () => {
    const q = quatAxisAngle([0.2, 0.3, 1], 0.9);
    const s: [number, number, number] = [0.5, 0.2, 0.15];
    putCloud(files, 'aniso', manualCloud([{ p: [0.3, 0.2, 0.4], s, rgb: [1, 1, 1], o: 1, q }]));
    for (const [name, camera] of [
      ['orthographic', cam({ projection: 'orthographic', orthoSize: 6, position: [0, 0, -4] })],
      ['perspective', cam({ fov: 40, position: [0.5, -0.3, -5], target: [0.2, 0.1, 0] })],
    ] as const) {
      const px = await draw('aniso', {}, { camera }, { width: 160, height: 120 });
      const v = viewSetup(camera, 160, 120);
      const pr = projectRef(v, [0.3, 0.2, 0.4], worldCovariance([1, 0, 0, 0, 1, 0, 0, 0, 1], q, s));
      const m = moments(px);
      // pixel space of the image: x right, y DOWN; the reference is y up
      expect(m.cx, name).toBeCloseTo(80 + pr.centre[0], 0);
      expect(m.cy, name).toBeCloseTo(60 - pr.centre[1], 0);
      const want = { xx: pr.cov[0] + 0.3, xy: -pr.cov[1], yy: pr.cov[2] + 0.3 };
      const tol = 0.07 * Math.sqrt(want.xx * want.yy);
      expect(Math.abs(m.xx - want.xx), `${name} xx ${m.xx} vs ${want.xx}`).toBeLessThan(tol);
      expect(Math.abs(m.yy - want.yy), `${name} yy ${m.yy} vs ${want.yy}`).toBeLessThan(tol);
      expect(Math.abs(m.xy - want.xy), `${name} xy ${m.xy} vs ${want.xy}`).toBeLessThan(tol);
    }
  });

  it('a splat behind the camera or outside the frame draws nothing; the 3 sigma truncation never shows a hard edge', T, async () => {
    putCloud(files, 'away', manualCloud([{ p: [0, 0, -9], s: [0.5, 0.5, 0.5], rgb: [1, 0, 0], o: 1 }, { p: [9, 0, 0], s: [0.5, 0.5, 0.5], rgb: [1, 0, 0], o: 1 }]));
    const px = await draw('away', {}, { camera: cam({ fov: 40 }) });
    expect(Math.max(...Array.from({ length: 128 * 96 }, (_, i) => px.data[i * 4 + 3]))).toBe(0);
  });
});

describe('order', () => {
  const two = (nearFirst: boolean) => {
    const red = { p: [0, 0, -0.5] as [number, number, number], s: [0.5, 0.5, 0.5] as [number, number, number], rgb: [1, 0, 0] as [number, number, number], o: 0.8 };
    const blue = { p: [0, 0, 0.5] as [number, number, number], s: [0.5, 0.5, 0.5] as [number, number, number], rgb: [0, 0, 1] as [number, number, number], o: 0.8 };
    return manualCloud(nearFirst ? [red, blue] : [blue, red]); // file order must not matter
  };
  const comp = Math.sqrt(144 / 144.3);
  it('sorted mode blends back to front from both sides, whatever the file order', T, async () => {
    const a = 0.8 * comp;
    for (const nearFirst of [true, false]) {
      const id = `two-${nearFirst}`;
      putCloud(files, id, two(nearFirst));
      for (const projection of ['orthographic', 'perspective'] as const) {
        // from -z the red splat (z = -0.5) is nearer; from +z the blue one is
        const front = await draw(id, {}, { camera: cam({ projection, orthoSize: 4, position: [0, 0, -5] }) });
        const back = await draw(id, {}, { camera: cam({ projection, orthoSize: 4, position: [0, 0, 5] }) });
        const over = (top: number[], bottom: number[]) => {
          // premultiplied "top over bottom" at the centre pixels, as straight 0..255
          const alpha = a + a * (1 - a);
          return [0, 1, 2].map((k) => (255 * (top[k] * a + bottom[k] * a * (1 - a))) / alpha);
        };
        const f = sample(front, 64, 48);
        const b = sample(back, 64, 48);
        const wantFront = over([1, 0, 0], [0, 0, 1]);
        const wantBack = over([0, 0, 1], [1, 0, 0]);
        if (projection === 'orthographic') {
          for (let k = 0; k < 3; k++) {
            expect(Math.abs(f[k] - wantFront[k]), `${id} ${projection} front ch${k}: ${f} vs ${wantFront}`).toBeLessThan(4);
            expect(Math.abs(b[k] - wantBack[k]), `${id} ${projection} back ch${k}: ${b} vs ${wantBack}`).toBeLessThan(4);
          }
        } else {
          // perspective sizes differ with distance: only the ORDER is asserted (red dominates in front, blue behind)
          expect(f[0]).toBeGreaterThan(f[2]);
          expect(b[2]).toBeGreaterThan(b[0]);
        }
      }
    }
  });

  it('draft mode needs no sort and keeps the nearer splat dominant', T, async () => {
    putCloud(files, 'two-draft', two(true));
    resetSplatDebug();
    const front = await draw('two-draft', { quality: 'draft' }, { camera: cam({ projection: 'orthographic', orthoSize: 4, position: [0, 0, -5] }) });
    const back = await draw('two-draft', { quality: 'draft' }, { camera: cam({ projection: 'orthographic', orthoSize: 4, position: [0, 0, 5] }) });
    expect(splatDebug.sorts).toBe(0);
    const f = sample(front, 64, 48);
    const b = sample(back, 64, 48);
    expect(f[0]).toBeGreaterThan(f[2] + 20);
    expect(b[2]).toBeGreaterThan(b[0] + 20);
  });
});

describe('caching and cost', () => {
  it('sorts only when the cloud or the snapped view changes; sliders never sort, upload or compile', T, async () => {
    const t = await H();
    dropSplatBuffers();
    putCloud(files, 'torus-cache', torusCloud(3000, 9));
    const camA = cam({ position: [0.3, 1.2, -4], target: [0, 0, 0] });
    const p = { orientation: 'asis', autoFit: false };
    resetSplatDebug();
    await draw('torus-cache', p, { camera: camA });
    expect(splatDebug.sorts).toBe(1);
    expect(splatDebug.uploads).toBe(1);
    const pipelines = splatDebug.pipelines;
    const gpuPipelines = t.gpu.stats().objects.pipelinesCreated;
    // look sliders: opacity, size, exposure, saturation, tint, min opacity, crop, shape, background: no sort, no upload
    for (const look of [{ opacityMul: 0.5 }, { splatSize: 1.7 }, { exposure: 1 }, { saturation: 0.3 }, { tint: [1, 0.5, 0.5, 1] }, { minOpacity: 0.3 }, { cropMode: 'sphere', cropRadius: 0.9 }, { shape: 'sharp' }, { shape: 'square' }, { background: [0, 0, 0.5, 1] }, { quality: 'sorted' }]) {
      await draw('torus-cache', { ...p, ...look }, { camera: camA });
    }
    expect(splatDebug.sorts).toBe(1);
    expect(splatDebug.uploads).toBe(1);
    expect(splatDebug.pipelines).toBe(pipelines);
    expect(t.gpu.stats().objects.pipelinesCreated).toBe(gpuPipelines);
    // a camera nudge inside the snap grid: same order; a real move: new order
    await draw('torus-cache', p, { camera: cam({ position: [0.30002, 1.2, -4], target: [0, 0, 0] }) });
    expect(splatDebug.sorts).toBe(1);
    await draw('torus-cache', p, { camera: cam({ position: [1.5, 1.2, -3.5], target: [0, 0, 0] }) });
    expect(splatDebug.sorts).toBe(2);
    // the object moves relative to the camera: also a new order; a pure spin about the view axis keeps the order
    await draw('torus-cache', { ...p, posX: 0.5 }, { camera: camA });
    expect(splatDebug.sorts).toBe(3);
    // draft playback never sorts
    await draw('torus-cache', { ...p, quality: 'draft' }, { camera: cam({ position: [2, 1, -3], target: [0, 0, 0] }) });
    expect(splatDebug.sorts).toBe(3);
    // moving a sorted splat count slider (max splats) is a new cloud: sorts once
    await draw('torus-cache', { ...p, maxSplats: 2000 }, { camera: camA });
    expect(splatDebug.sorts).toBe(4);
    expect(splatDebug.uploads).toBe(2);
  });

  it('automatic blending: sorted for export and still preview, draft only while playing at reduced resolution', T, async () => {
    putCloud(files, 'torus-auto', torusCloud(2000, 10));
    const c = { camera: cam({ position: [0.1, 1, -4] }) };
    resetSplatDebug();
    await draw('torus-auto', { quality: 'auto' }, c, undefined, { quality: 'preview', proxy: 1 });
    expect(splatDebug.sorts).toBe(1);
    await draw('torus-auto', { quality: 'auto' }, { camera: cam({ position: [0.1, 1.5, -4] }) }, undefined, { quality: 'preview', proxy: 0.5 });
    expect(splatDebug.sorts).toBe(1); // draft
    await draw('torus-auto', { quality: 'auto' }, { camera: cam({ position: [0.1, 2, -4] }) }, undefined, { quality: 'final', proxy: 0.5 });
    expect(splatDebug.sorts).toBe(2); // export is always sorted
  });

  it('the same inputs give the same pixels (sorting is deterministic), on a cold cache too', T, async () => {
    putCloud(files, 'torus-det', torusCloud(4000, 11));
    const c = { camera: cam({ position: [1, 1, -3.5] }) };
    const a = await draw('torus-det', { orientation: 'asis' }, c);
    dropSplatBuffers();
    const b = await draw('torus-det', { orientation: 'asis', quality: 'sorted' }, c); // same pixels, different params: a real render on a cold cache
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('GPU buffers are counted in gpu.stats(), kept in a small LRU and destroyed on eviction', T, async () => {
    const t = await H();
    dropSplatBuffers();
    const count = () => t.gpu.stats().categories['splat-buffer']?.count ?? 0;
    expect(count()).toBe(0);
    for (let i = 0; i < 5; i++) {
      putCloud(files, `lru-${i}`, ballCloud(300 + i, 20 + i));
      await draw(`lru-${i}`);
    }
    expect(count()).toBeGreaterThan(0);
    expect(count()).toBeLessThanOrEqual(9); // 3 clouds x (data, order, sh)
    const created = t.gpu.stats().categories['splat-buffer'].created;
    expect(created).toBeGreaterThanOrEqual(15);
    expect(t.gpu.stats().categories['splat-buffer'].destroyed).toBeGreaterThanOrEqual(6);
    dropSplatBuffers();
    expect(count()).toBe(0);
  });

  it('caps: more splats than Max splats keeps the largest and most opaque ones, identically every time', T, async () => {
    const big = ballCloud(6000, 33);
    putCloud(files, 'cap-big', big);
    const full = await draw('cap-big', { orientation: 'asis' }, { camera: cam({ position: [0, 0, -4] }) });
    const a = await draw('cap-big', { orientation: 'asis', maxSplats: 1500 }, { camera: cam({ position: [0, 0, -4] }) });
    const b = await draw('cap-big', { orientation: 'asis', maxSplats: 1500 }, { camera: cam({ position: [0, 0, -4] }), });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const cover = (px: { data: Uint8ClampedArray }) => Array.from({ length: 128 * 96 }, (_, i) => px.data[i * 4 + 3]).reduce((s, v) => s + v, 0);
    expect(cover(a)).toBeLessThan(cover(full));
    expect(cover(a)).toBeGreaterThan(0);
  });
});

describe('look', () => {
  it('crop box and sphere keep the inside (or the outside), min opacity cuts faint splats', T, async () => {
    putCloud(files, 'crop3', manualCloud([
      { p: [-1, 0, 0], s: [0.3, 0.3, 0.3], rgb: [1, 0, 0], o: 1 },
      { p: [0, 0, 0], s: [0.3, 0.3, 0.3], rgb: [0, 1, 0], o: 0.2 },
      { p: [1, 0, 0], s: [0.3, 0.3, 0.3], rgb: [0, 0, 1], o: 1 },
    ]));
    const at = (px: ReturnType<typeof sample> extends infer _ ? { data: Uint8ClampedArray; width: number } : never, dx: number) => sample(px, 64 + Math.round(dx * 24), 48);
    const all = await draw('crop3');
    expect(at(all, -1)[3]).toBeGreaterThan(200);
    expect(at(all, 0)[3]).toBeGreaterThan(30);
    expect(at(all, 1)[3]).toBeGreaterThan(200);
    const box = await draw('crop3', { cropMode: 'box', cropX: -1, cropSizeX: 0.4, cropSizeY: 2, cropSizeZ: 2 });
    expect(at(box, -1)[3]).toBeGreaterThan(200);
    expect(at(box, 0)[3]).toBe(0);
    expect(at(box, 1)[3]).toBe(0);
    const sph = await draw('crop3', { cropMode: 'sphere', cropX: 1, cropRadius: 0.5 });
    expect(at(sph, 1)[3]).toBeGreaterThan(200);
    expect(at(sph, -1)[3]).toBe(0);
    const inv = await draw('crop3', { cropMode: 'sphere', cropX: 1, cropRadius: 0.5, cropInvert: true });
    expect(at(inv, 1)[3]).toBe(0);
    expect(at(inv, -1)[3]).toBeGreaterThan(200);
    const cut = await draw('crop3', { minOpacity: 0.5 });
    expect(at(cut, 0)[3]).toBeLessThan(4); // only the faint tails of the neighbours remain
    expect(at(cut, 1)[3]).toBeGreaterThan(200);
    const boost = await draw('crop3', { opacityMul: 3 });
    expect(at(boost, 0)[3]).toBeGreaterThan(at(all, 0)[3]);
  });

  it('size, exposure, saturation, tint', T, async () => {
    putCloud(files, 'look1', manualCloud([{ p: [0, 0, 0], s: [0.25, 0.25, 0.25], rgb: [0.5, 0.25, 0.125], o: 1 }]));
    const base = sample(await draw('look1'), 64, 48);
    expect(Math.abs(base[0] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(base[1] - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(base[2] - 32)).toBeLessThanOrEqual(1);
    const bright = sample(await draw('look1', { exposure: 1 }), 64, 48);
    expect(bright[0]).toBe(255);
    expect(Math.abs(bright[1] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(bright[2] - 64)).toBeLessThanOrEqual(1);
    const grey = sample(await draw('look1', { saturation: 0 }), 64, 48);
    expect(Math.abs(grey[0] - grey[1])).toBeLessThan(2);
    expect(Math.abs(grey[1] - grey[2])).toBeLessThan(2);
    const tinted = sample(await draw('look1', { tint: [1, 0, 0, 1] }), 64, 48);
    expect(Math.abs(tinted[0] - 128)).toBeLessThanOrEqual(1);
    expect(tinted[1]).toBe(0);
    expect(tinted[2]).toBe(0);
    const wide = moments(await draw('look1', { splatSize: 2 }));
    const norm = moments(await draw('look1'));
    expect(wide.xx / norm.xx).toBeGreaterThan(3.3);
  });

  it('sharp and square shapes draw hard edges; square is screen aligned', T, async () => {
    putCloud(files, 'shape1', manualCloud([{ p: [0, 0, 0], s: [0.4, 0.2, 0.2], rgb: [1, 1, 0], o: 1, q: quatAxisAngle([0, 0, 1], 0.6) }]));
    const sharp = await draw('shape1', { shape: 'sharp' });
    const square = await draw('shape1', { shape: 'square' });
    const soft = await draw('shape1', { shape: 'gaussian' });
    // hard edges: the alpha ramp from 255 to 0 spans only a pixel or two
    const ramp = (px: { data: Uint8ClampedArray; width: number }) => {
      let transitional = 0, solid = 0;
      for (let i = 0; i < 128 * 96; i++) {
        const a = px.data[i * 4 + 3];
        if (a >= 250) solid++;
        else if (a > 8) transitional++;
      }
      return { transitional, solid };
    };
    const rs = ramp(sharp), rq = ramp(square), rg = ramp(soft);
    expect(rs.solid).toBeGreaterThan(rs.transitional * 3);
    expect(rq.solid).toBeGreaterThan(rq.transitional * 3);
    expect(rg.transitional).toBeGreaterThan(rg.solid);
    // square: a filled axis-aligned square (rows are equally wide, columns too)
    const widthAt = (px: { data: Uint8ClampedArray; width: number }, y: number) => Array.from({ length: 128 }, (_, x) => px.data[(y * 128 + x) * 4 + 3] > 128).filter(Boolean).length;
    const w1 = widthAt(square, 48), w2 = widthAt(square, 52), w3 = widthAt(square, 44);
    expect(Math.abs(w1 - w2)).toBeLessThanOrEqual(1);
    expect(Math.abs(w1 - w3)).toBeLessThanOrEqual(1);
  });

  it('view-dependent colour (SH degree 1) changes with the viewing direction and can be switched off', T, async () => {
    // "Fade tiny splats" was the default when these numbers were set (now off by default); it only changes coverage, not the colour maths
    const c = manualCloud([{ p: [0, 0, 0], s: [0.5, 0.5, 0.5], rgb: [0.5, 0.5, 0.5], o: 1 }]);
    c.sh1 = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]); // red: +1 on the y term
    putCloud(files, 'sh1', c);
    const above = sample(await draw('sh1', { viewDependent: true, antialias: true }, { camera: cam({ projection: 'perspective', position: [0, 4, -4] }) }), 64, 48);
    const below = sample(await draw('sh1', { viewDependent: true, antialias: true }, { camera: cam({ projection: 'perspective', position: [0, -4, -4] }) }), 64, 48);
    // dir (camera -> splat) has y = -0.707 from above: colour = 0.5 - C1 * y * k0 = 0.5 + 0.3455
    expect(above[0]).toBeGreaterThan(205);
    expect(above[0]).toBeLessThan(225);
    expect(below[0]).toBeGreaterThan(30);
    expect(below[0]).toBeLessThan(50);
    expect(above[1]).toBe(128);
    const flat = sample(await draw('sh1', { viewDependent: false, antialias: true }, { camera: cam({ projection: 'perspective', position: [0, 4, -4] }) }), 64, 48);
    expect(flat[0]).toBe(128);
  });
});

describe('outputs and edge cases', () => {
  it('depth output: distance along the ray (perspective) or the view axis (orthographic), alpha-weighted, only when wired', T, async () => {
    const t = await H();
    putCloud(files, 'depth1', manualCloud([{ p: [0, 0, 1], s: [0.5, 0.5, 0.5], rgb: [1, 1, 1], o: 1 }]));
    for (const [projection, want] of [['perspective', 5], ['orthographic', 5]] as const) {
      const g = buildNode(t, 'splat-3d', { ...BASE, file: ['depth1'] }, { camera: cam({ projection, orthoSize: 4, position: [0, 0, -4] }) });
      resetSplatDebug();
      await evalPort(t, g, 'image');
      expect(splatDebug.depthPasses, 'no depth work unless wired').toBe(0);
      const depth = (await evalPort(t, g, 'depth')) as ImageValue;
      const d = await readHalf(t, depth);
      const mid = (48 * 128 + 64) * 4;
      expect(d[mid], projection).toBeGreaterThan(want - 0.02);
      expect(d[mid]).toBeLessThan(want + 0.02);
      expect(d[mid + 1]).toBe(d[mid]);
      expect(d[mid + 3]).toBe(1);
      expect(d[0]).toBe(0);
      expect(d[3]).toBe(0);
      expect(splatDebug.depthPasses).toBe(1);
    }
    // perspective: off-axis pixels are further along the ray than the view axis
    const g = buildNode(t, 'splat-3d', { ...BASE, file: ['depth1'], splatSize: 1 }, { camera: cam({ position: [0, 0, -4], fov: 40 }) });
    const d = await readHalf(t, (await evalPort(t, g, 'depth')) as ImageValue);
    expect(d[0]).toBe(0);
    // two layers: the expected depth is the alpha-weighted mean, near layer first
    putCloud(files, 'depth2', manualCloud([{ p: [0, 0, -0.5], s: [0.5, 0.5, 0.5], rgb: [1, 0, 0], o: 0.5 }, { p: [0, 0, 1.5], s: [0.5, 0.5, 0.5], rgb: [0, 0, 1], o: 0.5 }]));
    const g2 = buildNode(t, 'splat-3d', { ...BASE, file: ['depth2'] }, { camera: ORTHO });
    const d2 = await readHalf(t, (await evalPort(t, g2, 'depth')) as ImageValue);
    const a = 0.5 * Math.sqrt(144 / 144.3);
    const wantDepth = (a * 3.5 + a * (1 - a) * 5.5) / (a + a * (1 - a));
    expect(Math.abs(d2[(48 * 128 + 64) * 4] - wantDepth)).toBeLessThan(0.03);
  });

  it('no file chosen: a clear (transparent) frame, or the background colour; a missing or invalid file is a readable error', T, async () => {
    const t = await H();
    const px = await draw('x', { file: [] });
    expect(px.data.every((v) => v === 0)).toBe(true);
    const bg = await draw('x', { file: [], background: [0.2, 0.4, 0.6, 1] });
    expect(sample(bg, 10, 10)).toEqual([51, 102, 153, 255]);
    const g = buildNode(t, 'splat-3d', { file: ['nope'] }, {});
    await expect(evalPort(t, g)).rejects.toThrow(/missing/);
    files.set('bad', new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n').buffer as ArrayBuffer);
    const g2 = buildNode(t, 'splat-3d', { file: ['bad'] }, {});
    await expect(evalPort(t, g2)).rejects.toThrow(/ASCII/);
  });

  it('reads a .splat file (32-byte records) as well as a .ply', T, async () => {
    const buf = new ArrayBuffer(32);
    const dv = new DataView(buf);
    [0, 0, 0, 0.5, 0.5, 0.5].forEach((v, i) => dv.setFloat32(i * 4, v, true));
    new Uint8Array(buf).set([255, 0, 0, 255, 255, 128, 128, 128], 24);
    files.set('raw-splat', buf);
    const px = await draw('raw-splat');
    expect(sample(px, 64, 48).slice(0, 3)).toEqual([255, 0, 0]);
    expect(sample(px, 64, 48)[3]).toBeGreaterThan(250);
  });

  it('fisheye / panoramic / cylindrical cameras fall back to a perspective lens', T, async () => {
    putCloud(files, 'lens', torusCloud(1500, 12));
    const persp = await draw('lens', { orientation: 'asis' }, { camera: cam({ projection: 'perspective', fov: 60, position: [0, 1, -3] }) });
    const fish = await draw('lens', { orientation: 'asis' }, { camera: cam({ projection: 'fisheye', fov: 60, position: [0, 1, -3] }) });
    expect(Buffer.from(persp.data).equals(Buffer.from(fish.data))).toBe(true);
    const pano = await draw('lens', { orientation: 'asis' }, { camera: cam({ projection: 'panoramic', position: [0, 1, -3] }) });
    expect(pano.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('orientation: an upside-down (y-down) scan is turned upright by Automatic; the same scene as y-up needs no turning', T, async () => {
    putCloud(files, 'terrain-up', terrainCloud(6000, 4, false));
    putCloud(files, 'terrain-down', terrainCloud(6000, 4, true));
    const c = { camera: cam({ position: [0, 1.4, -2.4], target: [0, 0, 0], fov: 50 }) };
    const up = await draw('terrain-up', { orientation: 'asis' }, c);
    const autoDown = await draw('terrain-down', { orientation: 'auto' }, c);
    const asisDown = await draw('terrain-down', { orientation: 'asis' }, c);
    const diff = (a: { data: Uint8ClampedArray }, b: { data: Uint8ClampedArray }) => a.data.reduce((s, v, i) => s + Math.abs(v - b.data[i]), 0) / a.data.length;
    expect(diff(up, autoDown)).toBeLessThan(diff(up, asisDown) * 0.35);
    expect(diff(up, autoDown)).toBeLessThan(6);
  });

  it('auto-fit centres and scales a scan of any size to the same frame', T, async () => {
    const small = manualCloud([{ p: [100, 200, 300], s: [0.01, 0.01, 0.01], rgb: [1, 1, 1], o: 1 }, { p: [100.5, 200, 300], s: [0.01, 0.01, 0.01], rgb: [1, 1, 1], o: 1 }, { p: [99.5, 200, 300], s: [0.01, 0.01, 0.01], rgb: [1, 1, 1], o: 1 }, { p: [100, 200.5, 300], s: [0.01, 0.01, 0.01], rgb: [1, 1, 1], o: 1 }, { p: [100, 199.5, 300], s: [0.01, 0.01, 0.01], rgb: [1, 1, 1], o: 1 }]);
    putCloud(files, 'fit', small);
    const px = await draw('fit', { autoFit: true, orientation: 'asis', splatSize: 8, rotX: 0, rotY: 0 }, {});
    const m = moments(px);
    expect(Math.abs(m.cx - 64)).toBeLessThan(2);
    expect(Math.abs(m.cy - 48)).toBeLessThan(2);
    expect(m.w).toBeGreaterThan(0);
  });

  it('looks the same at twice the resolution (no lengths in pixels)', T, async () => {
    putCloud(files, 'res', torusCloud(2000, 14));
    const a = await draw('res', { orientation: 'asis', rotX: 30, rotY: 20 }, {}, { width: 128, height: 96 });
    const b = await draw('res', { orientation: 'asis', rotX: 30, rotY: 20 }, {}, { width: 256, height: 192 });
    const ma = moments(a);
    const mb = moments(b);
    expect(mb.cx / ma.cx).toBeGreaterThan(1.97);
    expect(mb.cx / ma.cx).toBeLessThan(2.03);
    expect(mb.xx / ma.xx).toBeGreaterThan(3.7);
    expect(mb.xx / ma.xx).toBeLessThan(4.3);
  });

  it('spin loops by construction', T, async () => {
    const t = await H();
    putCloud(files, 'spin', torusCloud(3000, 15));
    const r = await t.loopCheck('splat-3d', { file: ['spin'], orientation: 'asis', rotX: 35, spinY: 1 });
    expect(r.seam).toBeLessThan(LOOP_SEAM_OK);
    expect(r.motion).toBeGreaterThan(0.3);
  });
});
