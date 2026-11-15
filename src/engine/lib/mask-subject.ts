/**
 * CPU analysis used by `subject-mask` (always on a <=128px thumbnail): deterministic k-means colour clustering,
 * connected components, island removal and hole detection.
 *
 * NOTE: everything here works on small INTEGERS (colours arrive as OKLab encoded into bytes by a GPU pass) and keeps
 * floating-point arithmetic to a minimum. Reason: in the headless Node WebGPU used by the tests, a burst of JS
 * floating-point work between two GPU awaits crashes the process (see the report). Browsers are not affected,
 * and integer maths is also simply faster here.
 */

export interface Cluster {
  L: number;
  a: number;
  b: number;
  /** RMS distance of the cluster's samples from its centre (OKLab). */
  sigma: number;
  /** Fraction of the samples (0..1). */
  weight: number;
}

/** OKLab byte encoding used between the GPU encode pass and this file. */
export const MODEL_SLOTS = 16;
export const LAB_A_MIN = -0.4;
export const LAB_A_RANGE = 0.8;

function toCluster(L: number, a: number, b: number, sq: number, cnt: number, n: number): Cluster {
  return {
    L: L / 255,
    a: (a / 255) * LAB_A_RANGE + LAB_A_MIN,
    b: (b / 255) * LAB_A_RANGE + LAB_A_MIN,
    sigma: Math.max(0.005, Math.sqrt(sq / cnt) / 255),
    weight: cnt / n,
  };
}

/**
 * Deterministic k-means++ on byte-encoded OKLab points (flat [L,a,b,...], 0..255).
 * Clusters lighter than `minPercent` of the samples are dropped; near-duplicates merge.
 */
export function kmeans(all: Uint8Array, k: number, minPercent = 3, seed = 7): Cluster[] {
  const total = (all.length / 3) | 0;
  if (total === 0) return [];
  const stride = ((total + 1199) / 1200) | 0 || 1;
  const n = ((total + stride - 1) / stride) | 0;
  const pts = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < total; i += stride, j += 3) {
    pts[j] = all[i * 3];
    pts[j + 1] = all[i * 3 + 1];
    pts[j + 2] = all[i * 3 + 2];
  }
  k = Math.max(1, Math.min(k, n));
  let state = (seed * 2654435761) & 0x3fffffff || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state &= 0x3fffffff;
    return state;
  };
  const cen = new Int32Array(k * 3);
  const first = rand() % n;
  for (let q = 0; q < 3; q++) cen[q] = pts[first * 3 + q];
  const d2 = new Int32Array(n).fill(0x3fffffff);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 3] - cen[(c - 1) * 3];
      const dy = pts[i * 3 + 1] - cen[(c - 1) * 3 + 1];
      const dz = pts[i * 3 + 2] - cen[(c - 1) * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let pick = sum > 0 ? rand() % sum : 0;
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      pick -= d2[i];
      if (pick < 0) {
        idx = i;
        break;
      }
    }
    for (let q = 0; q < 3; q++) cen[c * 3 + q] = pts[idx * 3 + q];
  }
  const assign = new Int32Array(n);
  const sum = new Int32Array(k * 3);
  const cnt = new Int32Array(k);
  for (let it = 0; it < 8; it++) {
    sum.fill(0);
    cnt.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = 0x3fffffff;
      for (let c = 0; c < k; c++) {
        const dx = pts[i * 3] - cen[c * 3];
        const dy = pts[i * 3 + 1] - cen[c * 3 + 1];
        const dz = pts[i * 3 + 2] - cen[c * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
      cnt[best]++;
      sum[best * 3] += pts[i * 3];
      sum[best * 3 + 1] += pts[i * 3 + 1];
      sum[best * 3 + 2] += pts[i * 3 + 2];
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) for (let q = 0; q < 3; q++) cen[c * 3 + q] = ((sum[c * 3 + q] + (cnt[c] >> 1)) / cnt[c]) | 0;
    }
  }
  const sq = new Int32Array(k);
  cnt.fill(0);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    cnt[c]++;
    const dx = pts[i * 3] - cen[c * 3];
    const dy = pts[i * 3 + 1] - cen[c * 3 + 1];
    const dz = pts[i * 3 + 2] - cen[c * 3 + 2];
    sq[c] += dx * dx + dy * dy + dz * dz;
  }
  // Merge near-duplicates (centre distance < ~5 byte units), heaviest first.
  const order = Array.from({ length: k }, (_, i) => i).filter((i) => cnt[i] > 0).sort((x, y) => cnt[y] - cnt[x]);
  const groups: { c: number[]; cnt: number; sq: number }[] = [];
  for (const i of order) {
    const g = groups.find((gr) => {
      const j = gr.c[0];
      const dx = cen[i * 3] - cen[j * 3];
      const dy = cen[i * 3 + 1] - cen[j * 3 + 1];
      const dz = cen[i * 3 + 2] - cen[j * 3 + 2];
      return dx * dx + dy * dy + dz * dz < 25;
    });
    if (g) {
      g.c.push(i);
      g.cnt += cnt[i];
      g.sq += sq[i];
    } else groups.push({ c: [i], cnt: cnt[i], sq: sq[i] });
  }
  const out: Cluster[] = [];
  for (const g of groups) {
    if (g.cnt * 100 < minPercent * n && out.length > 0) continue;
    const j = g.c[0];
    out.push(toCluster(cen[j * 3], cen[j * 3 + 1], cen[j * 3 + 2], g.sq, g.cnt, n));
  }
  return out;
}

/** Pack models into a (16 x 2) float table: row 0 = background clusters, row 1 = subject clusters. texel = (L, a, b, sigma). */
export function packModels(bg: Cluster[], fg: Cluster[]): Float32Array {
  const data = new Float32Array(MODEL_SLOTS * 2 * 4);
  const put = (row: number, list: Cluster[]) => {
    list.slice(0, MODEL_SLOTS).forEach((c, i) => data.set([c.L, c.a, c.b, c.sigma], (row * MODEL_SLOTS + i) * 4));
  };
  put(0, bg);
  put(1, fg);
  return data;
}

/* ------------------------------ regions ---------------------------------- */

export interface Region {
  id: number;
  area: number;
  touchesBorder: boolean;
  sx: number;
  sy: number;
}

/** 4-connected component labelling of a binary map. labels[i] = region index+1 (0 = background). */
export function label(bin: Uint8Array, w: number, h: number): { labels: Int32Array; regions: Region[] } {
  const labels = new Int32Array(w * h);
  const regions: Region[] = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!bin[s] || labels[s]) continue;
    const id = regions.length + 1;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = id;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let border = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      sx += x;
      sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && bin[i - 1] && !labels[i - 1]) (labels[i - 1] = id), (stack[sp++] = i - 1);
      if (x < w - 1 && bin[i + 1] && !labels[i + 1]) (labels[i + 1] = id), (stack[sp++] = i + 1);
      if (y > 0 && bin[i - w] && !labels[i - w]) (labels[i - w] = id), (stack[sp++] = i - w);
      if (y < h - 1 && bin[i + w] && !labels[i + w]) (labels[i + w] = id), (stack[sp++] = i + w);
    }
    regions.push({ id, area, touchesBorder: border, sx, sy });
  }
  return { labels, regions };
}

export function dilateBin(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = bin;
  for (let it = 0; it < r; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        next[i] = cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]) ? 1 : 0;
      }
    cur = next;
  }
  return cur;
}

export function erodeBin(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = bin[i] ? 0 : 1;
  // Pixels outside the image count as foreground, so shapes touching the border are not eaten.
  const d = dilateBin(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] ? 0 : 1;
  return out;
}

export interface SubjectSelection {
  /** Foreground after island removal (thumb res). */
  fg: Uint8Array;
  /** Enclosed background pockets that are filled in. */
  holes: Uint8Array;
  area: number;
}

/**
 * Pick which foreground regions are the subject and which enclosed background pockets are holes.
 *
 * Regions closer than ~3% of the frame are grouped (a character is often several pieces). Groups are ranked by area with a
 * strong centre prior, so a big bright distractor at the edge loses against a smaller compact thing in the middle.
 *  - 'subject': the best group, minus specks smaller than `minRatio` of it;
 *  - 'largest': only the biggest single region of the best group;
 *  - 'all': every group at least `minRatio` as strong as the best.
 */
export function selectSubject(score: Uint8Array, w: number, h: number, opts: { minRatio: number; mode: 'all' | 'subject' | 'largest'; holeFraction: number }): SubjectSelection {
  // Hysteresis: confident pixels (>= 0.5) plus weaker ones (>= 0.19) that connect to them. Ambiguous pixels next to a sure
  // part of the subject (an outline similar to the backdrop) belong to it; isolated ambiguous pixels do not.
  const bin = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < bin.length; i++) {
    if (score[i] >= 128) {
      bin[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    const tryAdd = (j: number) => {
      if (!bin[j] && score[j] >= 48) {
        bin[j] = 1;
        stack[sp++] = j;
      }
    };
    if (x > 0) tryAdd(i - 1);
    if (x < w - 1) tryAdd(i + 1);
    if (y > 0) tryAdd(i - w);
    if (y < h - 1) tryAdd(i + w);
  }
  const { labels, regions } = label(bin, w, h);

  // Group nearby regions: components of the dilated foreground (specks of 1 px are ignored so they cannot bridge groups).
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = labels[i] && regions[labels[i] - 1].area >= 3 ? 1 : 0;
  const grouped = label(dilateBin(solid, w, h, Math.max(2, ((Math.max(w, h) * 3) / 100) | 0)), w, h);
  const gOf = new Int32Array(regions.length + 1);
  for (let i = 0; i < labels.length; i++) if (labels[i] && solid[i] && !gOf[labels[i]]) gOf[labels[i]] = grouped.labels[i];
  const gArea = new Float64Array(grouped.regions.length + 1);
  const gSx = new Float64Array(grouped.regions.length + 1);
  const gSy = new Float64Array(grouped.regions.length + 1);
  const gBorder = new Uint8Array(grouped.regions.length + 1);
  for (const r of regions) {
    const g = gOf[r.id];
    if (!g) continue;
    gArea[g] += r.area;
    gSx[g] += r.sx;
    gSy[g] += r.sy;
    if (r.touchesBorder) gBorder[g] = 1;
  }
  const gRank = new Float64Array(grouped.regions.length + 1);
  let bestRank = 0;
  let bestGroup = 0;
  for (let g = 1; g <= grouped.regions.length; g++) {
    if (!gArea[g]) continue;
    const dx = gSx[g] / gArea[g] / w - 0.5;
    const dy = gSy[g] / gArea[g] / h - 0.5;
    const dd = (dx * dx + dy * dy) / 0.0625; // 0.25 of the frame from the centre = distance 1
    gRank[g] = (gArea[g] * (gBorder[g] ? 0.85 : 1)) / Math.exp(2 * dd);
    if (gRank[g] > bestRank) {
      bestRank = gRank[g];
      bestGroup = g;
    }
  }
  const keep = new Uint8Array(regions.length + 1);
  let area = 0;
  let biggest = 0;
  for (const r of regions) if (gOf[r.id] === bestGroup && r.area > biggest) biggest = r.area;
  for (const r of regions) {
    const g = gOf[r.id];
    if (!g || r.area < 2) continue;
    const ok =
      opts.mode === 'largest'
        ? g === bestGroup && r.area === biggest
        : opts.mode === 'subject'
          ? g === bestGroup && r.area >= opts.minRatio * 0.25 * gArea[g]
          : gRank[g] >= bestRank * opts.minRatio && r.area >= opts.minRatio * 0.25 * gArea[g];
    if (ok) {
      keep[r.id] = 1;
      area += r.area;
    }
  }
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = labels[i] && keep[labels[i]] ? 1 : 0;

  const holes = new Uint8Array(w * h);
  if (opts.holeFraction > 0 && area > 0) {
    // Close 1px gaps before looking for enclosed pockets, but only report pockets (not the gap pixels).
    const closed = erodeBin(dilateBin(fg, w, h, 1), w, h, 1);
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = closed[i] ? 0 : 1;
    const bgRegions = label(inv, w, h);
    const limit = opts.holeFraction * 0.5 * area + 2;
    for (let i = 0; i < holes.length; i++) {
      const id = bgRegions.labels[i];
      if (id && !fg[i]) {
        const r = bgRegions.regions[id - 1];
        if (!r.touchesBorder && r.area <= limit) holes[i] = 1;
      }
    }
  }
  return { fg, holes, area };
}
