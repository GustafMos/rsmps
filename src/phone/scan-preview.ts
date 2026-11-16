/**
 * Playing the preview sprite on the phone (pure parts). The computer sends ONE sprite-sheet JPEG (up to 96 frames in a grid) plus its
 * description (`PreviewMeta`) over the chunked transfer; the phone draws one cell at a time onto a canvas and loops.
 */
import type { PreviewMeta } from './scan-protocol';

/** Source rectangle of sprite frame `i` inside the sheet. */
export function spriteRect(meta: Pick<PreviewMeta, 'cols' | 'fw' | 'fh' | 'count'>, i: number): { sx: number; sy: number; sw: number; sh: number } {
  const k = ((i % meta.count) + meta.count) % meta.count;
  return { sx: (k % meta.cols) * meta.fw, sy: Math.floor(k / meta.cols) * meta.fh, sw: meta.fw, sh: meta.fh };
}

/** The sprite frame to show `elapsedMs` after playback (re)started at frame `from`. Loops. */
export function frameAt(elapsedMs: number, fps: number, count: number, from = 0): number {
  if (count <= 0 || !(fps > 0)) return 0;
  return (from + Math.floor((Math.max(0, elapsedMs) / 1000) * fps)) % count;
}

/** Frame number of the real animation (1-based) that sprite frame `i` shows. */
export function realFrameNumber(meta: Pick<PreviewMeta, 'step'>, i: number): number {
  return i * meta.step + 1;
}

/** "Frame 13 / 48" for the counter (the real animation's numbers even when the preview skips frames). */
export function counterText(meta: Pick<PreviewMeta, 'step' | 'total' | 'count'>, i: number): string {
  return `Frame ${realFrameNumber(meta, i)} / ${meta.total}`;
}

/** Is sprite frame `i` a stand-in for a missing frame? */
export function isMissingFrame(meta: Pick<PreviewMeta, 'step' | 'missingFrames'>, i: number): boolean {
  return meta.missingFrames.includes(realFrameNumber(meta, i));
}
