/**
 * Test helpers for the marker code: a small software renderer that draws a marker lying on a table as a given camera sees it, and
 * the ways a real phone picture is worse than that (blur, noise, uneven light, something in the way). Not used by the app.
 */
import type { CameraValue } from '../types';
import { orbitPosition } from './gen-camera';
import { MARKER_CELLS, markerCellWhite } from './marker-code';
import { MARKER_CORNERS, homography, invert3, poseFromCamera, projectPoint, type MarkerPose, type Pt } from './marker-pose';

export interface SceneOptions {
  width: number;
  height: number;
  fov: number;
  pose: Pick<MarkerPose, 'r' | 't'>;
  id?: number;
  /** Grey levels 0..255. */
  ink?: number;
  paper?: number;
  table?: number;
  /** Half size of the white sheet around the marker, in marker widths (0.5 = no margin at all). */
  sheet?: number;
  /** Samples per pixel side. */
  samples?: number;
  /** Draw the picture mirrored left to right, as a mirrored front camera shows it. */
  mirror?: boolean;
}

/** A camera on a sphere around the marker (which lies at the origin, 1 unit wide, face up). elevation 90 = straight above. */
export function orbitCamera(distance: number, azimuth: number, elevation: number, roll = 0, target: [number, number, number] = [0, 0, 0]): Pick<CameraValue, 'position' | 'target' | 'roll'> {
  return { position: orbitPosition(target, distance, azimuth, elevation), target, roll };
}
export const orbitPose = (distance: number, azimuth: number, elevation: number, roll = 0, target: [number, number, number] = [0, 0, 0]): MarkerPose =>
  poseFromCamera(orbitCamera(distance, azimuth, elevation, roll, target), { markerWidth: 1, floor: 0 });

/** Where the four corners of the marker are in the picture (pixels), exactly. */
export function trueCorners(o: Pick<SceneOptions, 'width' | 'height' | 'fov' | 'pose' | 'mirror'>): Pt[] {
  return MARKER_CORNERS.map(([u, v]) => {
    const p = projectPoint(o.pose, [u, 0, v], o.width, o.height, o.fov)!;
    return o.mirror ? [o.width - p[0], p[1]] : p;
  });
}

/** Greyscale picture of the scene. */
export function renderScene(o: SceneOptions): Uint8Array {
  const { width, height } = o;
  const ink = o.ink ?? 25;
  const paper = o.paper ?? 235;
  const table = o.table ?? 120;
  const sheet = o.sheet ?? 1.1;
  const n = o.samples ?? 3;
  const id = o.id ?? 0;
  const H = homography(MARKER_CORNERS, trueCorners({ ...o, mirror: false }));
  const inv = H && invert3(H);
  const out = new Uint8Array(width * height);
  if (!inv) return out.fill(table);
  const centre = projectPoint(o.pose, [0, 0, 0], width, height, o.fov)!;
  const wSign = Math.sign(inv[6] * centre[0] + inv[7] * centre[1] + inv[8]) || 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const sx = x + (i + 0.5) / n;
          const px = o.mirror ? width - sx : sx;
          const py = y + (j + 0.5) / n;
          const w = inv[6] * px + inv[7] * py + inv[8];
          let v = table;
          if (w * wSign > 1e-9) {
            const u = (inv[0] * px + inv[1] * py + inv[2]) / w;
            const vv = (inv[3] * px + inv[4] * py + inv[5]) / w;
            if (Math.abs(u) <= 0.5 && Math.abs(vv) <= 0.5) {
              const cx = Math.min(MARKER_CELLS - 1, Math.floor((u + 0.5) * MARKER_CELLS));
              const cy = Math.min(MARKER_CELLS - 1, Math.floor((0.5 - vv) * MARKER_CELLS));
              v = markerCellWhite(id, cx, cy) ? paper : ink;
            } else if (Math.abs(u) <= sheet && Math.abs(vv) <= sheet) v = paper;
            // a little pattern on the table so it is not a flat grey
            else v = table + (((Math.floor(u * 3) + Math.floor(vv * 3)) & 1) ? 10 : -10);
          }
          sum += v;
        }
      out[y * width + x] = Math.round(sum / (n * n));
    }
  return out;
}

/** Small seeded random generator (0..1). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
export function gauss(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
}

/** Gaussian blur (separable). `sx`, `sy` = standard deviation in pixels along x and y (different values imitate motion blur). */
export function blur(g: Uint8Array, w: number, h: number, sx: number, sy = sx): Uint8Array {
  const pass = (src: Float32Array, sigma: number, horizontal: boolean): Float32Array => {
    if (sigma <= 0.01) return src;
    const r = Math.ceil(sigma * 3);
    const k: number[] = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) {
      k.push(Math.exp((-i * i) / (2 * sigma * sigma)));
      ks += k[k.length - 1];
    }
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
          s += src[yy * w + xx] * k[i + r];
        }
        dst[y * w + x] = s / ks;
      }
    return dst;
  };
  const f = pass(pass(Float32Array.from(g), sx, true), sy, false);
  return Uint8Array.from(f, (v) => Math.max(0, Math.min(255, Math.round(v))));
}

export function addNoise(g: Uint8Array, sigma: number, seed = 1): Uint8Array {
  const rnd = seeded(seed);
  return Uint8Array.from(g, (v) => Math.max(0, Math.min(255, Math.round(v + gauss(rnd) * sigma))));
}

/** Uneven light: the left edge is multiplied by `left`, the right edge by `right`. */
export function lightGradient(g: Uint8Array, w: number, h: number, left: number, right: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.max(0, Math.min(255, Math.round(g[y * w + x] * (left + ((right - left) * x) / (w - 1)))));
  return out;
}

/** Squeeze the brightness range towards `mid` (1 = unchanged, 0.2 = very flat). */
export function lowContrast(g: Uint8Array, amount: number, mid = 128): Uint8Array {
  return Uint8Array.from(g, (v) => Math.round(mid + (v - mid) * amount));
}

/** Something in the way: a filled disc of one grey. */
export function occlude(g: Uint8Array, w: number, h: number, cx: number, cy: number, radius: number, value: number): Uint8Array {
  const out = Uint8Array.from(g);
  for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(h, cy + radius + 1); y++)
    for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(w, cx + radius + 1); x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius) out[y * w + x] = value;
  return out;
}

export function greyToRgba(g: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}
