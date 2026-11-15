/**
 * GPU -> bytes helpers shared by the player (snapshot) and the exporter.
 * Nothing here loops over pixels: the GPU draws into an OffscreenCanvas WebGPU context and the
 * browser encodes that canvas.
 *
 * Capture rule: a WebGPU canvas texture is only valid in the task that rendered it. Callers must
 * call `convertToBlob()` / `new VideoFrame(canvas)` synchronously after `present()`, before any await.
 */
import type { Gpu } from '../engine/gpu/gpu';

export interface Drawable {
  texture: GPUTexture;
  width: number;
  height: number;
}

export class OffscreenPresenter {
  private canvas: OffscreenCanvas;
  private ctx: GPUCanvasContext;

  /** `opaque` drops alpha (JPEG, video): transparent areas become black. */
  constructor(
    private gpu: Gpu,
    opaque: boolean,
  ) {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('This browser has no OffscreenCanvas, which exporting needs.');
    this.canvas = new OffscreenCanvas(1, 1);
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('This browser cannot create a WebGPU canvas on an OffscreenCanvas (needed to encode pictures).');
    this.ctx = ctx as unknown as GPUCanvasContext;
    this.ctx.configure({
      device: gpu.device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: opaque ? 'opaque' : 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  /** Draw `image` 1:1 into a canvas of its own size and return the canvas, ready to capture. */
  present(image: Drawable): OffscreenCanvas {
    if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    this.gpu.blit(image, this.ctx.getCurrentTexture(), true);
    return this.canvas;
  }
}

let directBlobOk = true;
let directFrameOk = true;
let scratch: OffscreenCanvas | null = null;

/** A 2D copy of the (WebGPU) canvas, made synchronously: the texture is gone after the task ends. */
function copyTo2d(canvas: OffscreenCanvas): OffscreenCanvas {
  const copy = (scratch ??= new OffscreenCanvas(canvas.width, canvas.height));
  if (copy.width !== canvas.width || copy.height !== canvas.height) {
    copy.width = canvas.width;
    copy.height = canvas.height;
  }
  const ctx = copy.getContext('2d');
  if (!ctx) throw new Error('This browser has no 2D canvas to encode pictures with.');
  ctx.clearRect(0, 0, copy.width, copy.height);
  ctx.drawImage(canvas, 0, 0);
  return copy;
}

/**
 * Draw `image` and encode it as PNG/WebP/JPEG. Uses convertToBlob on the WebGPU canvas (fast); browsers that cannot do that
 * get the picture copied into a 2D canvas first (remembered after the first failure).
 */
export async function presentToBlob(p: OffscreenPresenter, image: Drawable, mime = 'image/png', quality?: number): Promise<Blob> {
  if (directBlobOk) {
    const canvas = p.present(image);
    try {
      const blob = await canvas.convertToBlob({ type: mime, quality });
      if (blob.size > 0) return blob;
    } catch {
      /* fall through to the 2D path */
    }
    directBlobOk = false;
  }
  const copy = copyTo2d(p.present(image));
  return copy.convertToBlob({ type: mime, quality });
}

/** A VideoFrame of the canvas just drawn. Must be called in the same task as `present`. */
export function frameFromCanvas(canvas: OffscreenCanvas, init: VideoFrameInit): VideoFrame {
  if (typeof VideoFrame === 'undefined') throw new Error('This browser has no WebCodecs VideoFrame, so video export is unavailable. Use a current Chrome or Edge, or export an image sequence.');
  if (directFrameOk) {
    try {
      return new VideoFrame(canvas, init);
    } catch {
      directFrameOk = false; // a WebGPU canvas is not accepted as a VideoFrame source here
    }
  }
  return new VideoFrame(copyTo2d(canvas), init);
}

export async function imageToBlob(
  gpu: Gpu,
  image: Drawable,
  mime = 'image/png',
  quality?: number,
  presenter?: OffscreenPresenter,
): Promise<Blob> {
  return presentToBlob(presenter ?? new OffscreenPresenter(gpu, mime === 'image/jpeg'), image, mime, quality);
}
