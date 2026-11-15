/**
 * Palette extraction in OKLab. Deterministic: no randomness, stable sorts, fixed iteration counts,
 * so the same pixels always give the same palette.
 */
import { oklabToSrgb, srgbToOklab, type Rgb } from './pixel-color';

export type ExtractMethod = 'median-cut' | 'kmeans';

/** Samples from straight RGBA8; pixels that are mostly transparent are ignored. */
export function samplesFromRgba(rgba: Uint8ClampedArray): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    out.push(srgbToOklab([rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255]));
  }
  return out;
}

function mean(points: Rgb[]): Rgb {
  const m: Rgb = [0, 0, 0];
  for (const p of points) {
    m[0] += p[0];
    m[1] += p[1];
    m[2] += p[2];
  }
  const n = Math.max(1, points.length);
  return [m[0] / n, m[1] / n, m[2] / n];
}

function sse(points: Rgb[], c: Rgb): number {
  let s = 0;
  for (const p of points) s += (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  return s;
}

/**
 * Where to cut a box that is sorted along its widest axis: the split that leaves the least squared error in the two
 * halves (a variance-minimising cut, as in Wu's quantizer). A plain median cut would slice through the middle of
 * a dominant colour whenever clusters are of similar size.
 */
function bestSplit(sorted: Rgb[]): number {
  const n = sorted.length;
  const total = [0, 0, 0];
  const totalSq = [0, 0, 0];
  for (const p of sorted) {
    for (let a = 0; a < 3; a++) {
      total[a] += p[a];
      totalSq[a] += p[a] * p[a];
    }
  }
  const left = [0, 0, 0];
  const leftSq = [0, 0, 0];
  let best = Math.floor(n / 2);
  let bestErr = Infinity;
  for (let i = 1; i < n; i++) {
    const p = sorted[i - 1];
    let err = 0;
    for (let a = 0; a < 3; a++) {
      left[a] += p[a];
      leftSq[a] += p[a] * p[a];
      const rn = n - i;
      err += leftSq[a] - (left[a] * left[a]) / i + (totalSq[a] - leftSq[a]) - ((total[a] - left[a]) * (total[a] - left[a])) / rn;
    }
    if (err < bestErr - 1e-12) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

function medianCut(samples: Rgb[], count: number): Rgb[] {
  const boxes: Rgb[][] = [samples];
  const axisOf = (box: Rgb[]): { axis: number; span: number } => {
    const lo: Rgb = [Infinity, Infinity, Infinity];
    const hi: Rgb = [-Infinity, -Infinity, -Infinity];
    for (const p of box) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a]);
        hi[a] = Math.max(hi[a], p[a]);
      }
    }
    // Chroma axes are scaled up a little: L spans 0..1 but a/b only about +-0.3.
    const spans = [hi[0] - lo[0], (hi[1] - lo[1]) * 1.6, (hi[2] - lo[2]) * 1.6];
    const axis = spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
    return { axis, span: spans[axis] };
  };
  while (boxes.length < count) {
    let bi = -1;
    let bs = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2 || axisOf(b).span <= 1e-9) return;
      const s = sse(b, mean(b));
      if (s > bs) {
        bs = s;
        bi = i;
      }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    const { axis } = axisOf(box);
    const sorted = box.slice().sort((p, q) => p[axis] - q[axis]);
    const cut = bestSplit(sorted);
    boxes.splice(bi, 1, sorted.slice(0, cut), sorted.slice(cut));
  }
  return boxes.filter((b) => b.length > 0).map(mean);
}

function kmeans(samples: Rgb[], init: Rgb[], iterations: number): Rgb[] {
  const centers = init.map((c) => [...c] as Rgb);
  const assign = new Int32Array(samples.length);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    let changed = 0;
    for (let s = 0; s < samples.length; s++) {
      const p = samples[s];
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[s] !== best) changed++;
      assign[s] = best;
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      sums[best][3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (changed === 0) break;
  }
  return centers;
}

/**
 * Pick `count` representative colours from OKLab samples. Result is sRGB 0..1, sorted dark → light,
 * without duplicates (so it may be shorter than `count` for images with few distinct colours).
 */
export function extractPalette(samples: Rgb[], count: number, method: ExtractMethod): Rgb[] {
  const n = Math.max(1, Math.min(256, Math.round(count)));
  if (samples.length === 0) return [[0, 0, 0], [1, 1, 1]];
  let centers = medianCut(samples, n);
  if (method === 'kmeans') centers = kmeans(samples, centers, 12);
  const rgb = centers.map((c) => oklabToSrgb(c).map((v) => Math.min(1, Math.max(0, Math.round(v * 255) / 255))) as Rgb);
  // Dedupe on the 8-bit value, sort by OKLab lightness.
  const seen = new Set<string>();
  const unique = rgb.filter((c) => {
    const k = c.map((v) => Math.round(v * 255)).join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const keyed = unique.map((c) => ({ c, l: srgbToOklab(c)[0] }));
  keyed.sort((a, b) => a.l - b.l);
  return keyed.map((k) => k.c);
}
