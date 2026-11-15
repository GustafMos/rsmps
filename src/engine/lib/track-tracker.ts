/**
 * Deterministic multi-object tracker used by the `track` node. It is a pure function of a window of
 * per-frame detections: no state survives between calls (the engine forbids it), so the node re-runs the
 * tracker over a short history for every frame it renders. See track.node.ts for the consequences.
 */
import type { Region } from '../types';
import { areaOf, centerOf, hashInts, iou, sizeOf, type Box } from './track-core';

export interface TrackerOptions {
  /** Largest plausible centre move per frame (normalised). */
  maxMove: number;
  /** 0 = follow detections exactly, towards 1 = heavy smoothing of box position and size. */
  smooth: number;
  /** Keep a track alive (and output it) for this many frames after its detection vanished. */
  hold: number;
  /** Only match regions that share a label. */
  matchLabels: boolean;
  /** Loop length in frames (ids hash the wrapped frame so the loop seam is consistent); 0 = no wrapping. */
  loopFrames: number;
}

interface Track {
  id: number;
  label: string;
  box: Box;
  vx: number;
  vy: number;
  lastSeen: number;
  score: number;
  rawScore: number;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function labelHash(label: string): number {
  let h = 7;
  for (let i = 0; i < label.length; i++) h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
  return h;
}

/**
 * Run the tracker over `seq` (detections for frames startFrame, startFrame+1, ...) and return the tracked
 * regions for the LAST frame. Ids are `hash(birth frame, quantised birth position, label)` folded into 1..9999.
 */
export function runTracker(seq: Region[][], startFrame: number, o: TrackerOptions): Region[] {
  const tracks: Track[] = [];
  const used = new Set<number>();
  const last = seq.length - 1;

  for (let k = 0; k <= last; k++) {
    const g = startFrame + k;
    const dets = seq[k];
    const cand: { ti: number; di: number; cost: number }[] = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti];
      const gap = Math.max(1, g - t.lastSeen);
      const [tcx, tcy] = centerOf(t.box);
      const px = tcx + t.vx * gap;
      const py = tcy + t.vy * gap;
      const [tw, th] = sizeOf(t.box);
      const predBox: Box = [px - tw / 2, py - th / 2, px + tw / 2, py + th / 2];
      for (let di = 0; di < dets.length; di++) {
        const d = dets[di];
        if (o.matchLabels && d.label !== t.label) continue;
        const [dcx, dcy] = centerOf(d.box);
        const dist = Math.hypot(dcx - px, dcy - py);
        const near = dist <= o.maxMove * gap || iou(predBox, d.box) > 0.1;
        if (!near) continue;
        const [dw, dh] = sizeOf(d.box);
        cand.push({ ti, di, cost: dist + 0.25 * (Math.abs(dw - tw) + Math.abs(dh - th)) });
      }
    }
    cand.sort((a, b) => a.cost - b.cost || a.ti - b.ti || a.di - b.di);
    const trackTaken = new Set<number>();
    const detTaken = new Set<number>();
    for (const c of cand) {
      if (trackTaken.has(c.ti) || detTaken.has(c.di)) continue;
      trackTaken.add(c.ti);
      detTaken.add(c.di);
      const t = tracks[c.ti];
      const d = dets[c.di];
      const dt = Math.max(1, g - t.lastSeen);
      const [ocx, ocy] = centerOf(t.box);
      const [ow, oh] = sizeOf(t.box);
      // Predict where the box should be, then blend the detection in.
      const pcx = ocx + t.vx * dt;
      const pcy = ocy + t.vy * dt;
      const [dcx, dcy] = centerOf(d.box);
      const [dw, dh] = sizeOf(d.box);
      const a = 1 - o.smooth;
      const ncx = pcx + (dcx - pcx) * a;
      const ncy = pcy + (dcy - pcy) * a;
      const nw = ow + (dw - ow) * a;
      const nh = oh + (dh - oh) * a;
      t.vx = t.vx * 0.5 + ((ncx - ocx) / dt) * 0.5;
      t.vy = t.vy * 0.5 + ((ncy - ocy) / dt) * 0.5;
      t.box = [ncx - nw / 2, ncy - nh / 2, ncx + nw / 2, ncy + nh / 2];
      t.lastSeen = g;
      t.score = d.score;
      t.rawScore = d.score;
      t.label = d.label;
    }
    for (let di = 0; di < dets.length; di++) {
      if (detTaken.has(di)) continue;
      const d = dets[di];
      const [cx, cy] = centerOf(d.box);
      const frameKey = o.loopFrames > 0 ? mod(g, o.loopFrames) : g;
      let id = (hashInts(frameKey, Math.round(cx * 32), Math.round(cy * 32), labelHash(d.label)) % 9999) + 1;
      while (used.has(id)) id = (id % 9999) + 1;
      used.add(id);
      tracks.push({ id, label: d.label, box: [...d.box] as Box, vx: 0, vy: 0, lastSeen: g, score: d.score, rawScore: d.score });
    }
    // Retire tracks that have been gone for longer than the hold time.
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (g - tracks[i].lastSeen > o.hold) {
        used.delete(tracks[i].id);
        tracks.splice(i, 1);
      }
    }
  }

  const gEnd = startFrame + last;
  const out: Region[] = [];
  for (const t of tracks) {
    const missed = gEnd - t.lastSeen;
    if (missed > o.hold) continue;
    const box: Box = [Math.max(0, t.box[0]), Math.max(0, t.box[1]), Math.min(1, t.box[2]), Math.min(1, t.box[3])];
    if (areaOf(box) <= 0) continue;
    out.push({ id: t.id, label: t.label, score: missed === 0 ? t.rawScore : t.rawScore * (1 - missed / (o.hold + 1)), box });
  }
  return out;
}
