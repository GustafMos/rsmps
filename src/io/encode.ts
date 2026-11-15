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
    this.canvas = new OffscreenCanvas(1, 1);
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas for encoding.');
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

export async function imageToBlob(
  gpu: Gpu,
  image: Drawable,
  mime = 'image/png',
  quality?: number,
  presenter?: OffscreenPresenter,
): Promise<Blob> {
  const p = presenter ?? new OffscreenPresenter(gpu, mime === 'image/jpeg');
  const canvas = p.present(image);
  return canvas.convertToBlob({ type: mime, quality });
}
