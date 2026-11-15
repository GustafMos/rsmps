import { oklabToRgb, rgbToOklab, type RGB } from '../lib/colorMath';

export type Mood = 'auto' | 'colorful' | 'bright' | 'muted' | 'deep' | 'dark';
export const MOODS: { id: Mood; label: string }[] = [
  { id: 'auto', label: 'Dominant' },
  { id: 'colorful', label: 'Colourful' },
  { id: 'bright', label: 'Bright' },
  { id: 'muted', label: 'Muted' },
  { id: 'deep', label: 'Deep' },
  { id: 'dark', label: 'Dark' },
];

function weight(mood: Mood, L: number, C: number): number {
  switch (mood) {
    case 'colorful': return 0.05 + C * C * 60;
    case 'bright': return 0.05 + L * L * L * 2;
    case 'muted': return 0.05 + (1 - Math.min(1, C * 6)) * 0.8 + 0.1 * L;
    case 'deep': return 0.05 + (1 - L) * Math.min(1, C * 6) * 2;
    case 'dark': return 0.05 + (1 - L) ** 3 * 2;
    default: return 1;
  }
}

/** Weighted k-means in OKLab. `data` is RGBA (straight), at most ~128px on a side. */
export function extractColors(data: Uint8ClampedArray, n: number, mood: Mood): RGB[] {
  const pts: { lab: [number, number, number]; w: number }[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const lab = rgbToOklab([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    pts.push({ lab, w: weight(mood, lab[0], Math.hypot(lab[1], lab[2])) });
  }
  if (!pts.length) return [];
  const k = Math.min(n, pts.length);
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const cent: number[][] = [pts.reduce((m, p) => (p.w > m.w ? p : m)).lab.slice()];
  const minD = pts.map((p) => d2(p.lab, cent[0]));
  while (cent.length < k) {
    let best = 0;
    let bv = -1;
    for (let i = 0; i < pts.length; i++) {
      const v = minD[i] * pts[i].w;
      if (v > bv) {
        bv = v;
        best = i;
      }
    }
    cent.push(pts[best].lab.slice());
    for (let i = 0; i < pts.length; i++) minD[i] = Math.min(minD[i], d2(pts[i].lab, cent[cent.length - 1]));
  }
  for (let it = 0; it < 14; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let bj = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = d2(p.lab, cent[j]);
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      const s = sum[bj];
      s[0] += p.lab[0] * p.w;
      s[1] += p.lab[1] * p.w;
      s[2] += p.lab[2] * p.w;
      s[3] += p.w;
    }
    for (let j = 0; j < k; j++) if (sum[j][3] > 0) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  return cent.sort((a, b) => a[0] - b[0]).map((c) => oklabToRgb(c as [number, number, number]));
}

/** Downscale a drawable to at most `max` px on its long side and return RGBA pixels. */
export function sampleImage(src: CanvasImageSource & { width: number; height: number }, max = 128): Uint8ClampedArray {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
