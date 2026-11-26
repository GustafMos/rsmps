/**
 * The browser's side of taking a scan photo: copy the camera picture out of the painter's WebGL canvas INSIDE the frame callback
 * (the canvas is cleared after it), and later encode that copy as a JPEG and measure how sharp it is. Nothing here runs at import time.
 *
 * UNTESTED ON A REAL AR DEVICE (desktop Chromium has no AR camera picture; the pieces are exercised against plain canvases).
 */
import { SCAN_JPEG_QUALITY } from '../../engine/lib/scan-data';
import { laplacianVariance } from '../../engine/lib/scan-coverage';
import type { ScanEnv, ScanGrab } from './scan-session';

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

export interface CanvasGrab extends ScanGrab {
  canvas: Canvas2D;
}

const makeCanvas = (w: number, h: number): Canvas2D => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** Copy `source` (the painter's canvas, valid right now) into a canvas of its own. Returns null when the copy is not possible. */
export function copyToGrab(source: Canvas2D): CanvasGrab | null {
  const w = source.width;
  const h = source.height;
  if (!(w > 0) || !(h > 0)) return null;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  return { width: w, height: h, canvas };
}

const toBlob = async (c: Canvas2D, quality: number): Promise<Blob> => {
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('The photo could not be encoded.'))), 'image/jpeg', quality));
};

/** Variance of the Laplacian of a small greyscale copy (the long side about 160 pixels). */
export function blurVariance(c: Canvas2D): number {
  const k = 160 / Math.max(c.width, c.height);
  const w = Math.max(8, Math.round(c.width * Math.min(1, k)));
  const h = Math.max(8, Math.round(c.height * Math.min(1, k)));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return 0;
  ctx.drawImage(c as CanvasImageSource, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return laplacianVariance(grey, w, h);
}

export function browserScanEnv(): ScanEnv {
  return {
    async encode(grab) {
      const canvas = (grab as CanvasGrab).canvas;
      try {
        const variance = blurVariance(canvas);
        const blob = await toBlob(canvas, SCAN_JPEG_QUALITY);
        return { blob, variance };
      } finally {
        canvas.width = 1; // give the big picture's memory back right away
        canvas.height = 1;
      }
    },
  };
}
