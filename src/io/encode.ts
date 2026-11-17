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
    readonly opaque: boolean,
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

  /** Give the canvas context (and its swap-chain textures) back. Safe to call twice; the presenter is not usable afterwards. */
  dispose(): void {
    try {
      this.ctx.unconfigure();
    } catch {
      /* already gone */
    }
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  /** The GPU this presenter draws with (for the pixel read-back path). */
  get device(): Gpu {
    return this.gpu;
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

/**
 * Whether capturing a WebGPU canvas right after drawing gives THAT picture. Some browsers hand back the previously presented picture
 * instead (the canvas is only updated when the task ends). An export would then be shifted by one frame: a stale first frame and a
 * missing last one, which shows as a freeze or a jump exactly at the loop point. Checked once per session with three known colors;
 * when the check fails (or cannot run) every capture reads the pixels back from the GPU instead, which is slower but always exact.
 */
let captureMode: 'unknown' | 'direct' | 'readback' = 'unknown';
let captureCheck: Promise<void> | null = null;

/** Diagnostics: how captures are made in this session. */
export function captureModeNow(): 'unknown' | 'direct' | 'readback' {
  return captureMode;
}
/** Test hook, and a way to force the exact path. */
export function setCaptureMode(mode: 'unknown' | 'direct' | 'readback'): void {
  captureMode = mode;
  captureCheck = null;
}

async function pixelOf(source: CanvasImageSource): Promise<[number, number, number]> {
  const c = new OffscreenCanvas(8, 8);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas');
  ctx.drawImage(source, 0, 0, 8, 8);
  const d = ctx.getImageData(4, 4, 1, 1).data;
  return [d[0], d[1], d[2]];
}

async function runCaptureCheck(gpu: Gpu): Promise<'direct' | 'readback'> {
  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];
  const pics = colors.map(([r, g, b]) => {
    const data = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) data.set([r, g, b, 255], i * 4);
    const img = gpu.upload(data, 8, 8, 1, true);
    gpu.retain(img.texture);
    return img;
  });
  const probe = new OffscreenPresenter(gpu, true);
  const near = (a: [number, number, number], b: [number, number, number]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 120;
  try {
    for (let i = 0; i < pics.length; i++) {
      // exactly what an export does: draw, capture in the same task, then let the task end
      const canvas = probe.present(pics[i]);
      const frame = typeof VideoFrame !== 'undefined' ? new VideoFrame(canvas, { timestamp: i * 1000 }) : null;
      const blobPromise = canvas.convertToBlob({ type: 'image/png' });
      let fromFrame: [number, number, number] | null = null;
      try {
        const bmp = await createImageBitmap(await blobPromise);
        const fromBlob = await pixelOf(bmp);
        bmp.close();
        if (frame) fromFrame = await pixelOf(frame);
        if (!near(fromBlob, colors[i]) || (fromFrame && !near(fromFrame, colors[i]))) return 'readback';
      } finally {
        frame?.close();
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    return 'direct';
  } catch {
    return 'readback';
  } finally {
    probe.dispose();
    pics.forEach((img) => gpu.release(img.texture));
  }
}

async function ensureCapture(gpu: Gpu): Promise<void> {
  if (captureMode !== 'unknown') return;
  captureCheck ??= runCaptureCheck(gpu).then((mode) => {
    if (captureMode === 'unknown') captureMode = mode;
    if (mode === 'readback') console.info('[rsmps] This browser captures a WebGPU canvas one picture late; exports read pixels back from the GPU instead (slower, exact).');
  });
  await captureCheck;
}

/** The picture as plain RGBA bytes: straight alpha, or (opaque) color over black with alpha 255. */
async function readPixels(gpu: Gpu, image: Drawable, opaque: boolean): Promise<Uint8ClampedArray> {
  const px = await gpu.read(image, !opaque);
  if (opaque) for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

/** Draw `image` and return a VideoFrame of exactly that picture. */
export async function presentToFrame(p: OffscreenPresenter, image: Drawable, init: VideoFrameInit): Promise<VideoFrame> {
  await ensureCapture(p.device);
  if (captureMode === 'direct') return frameFromCanvas(p.present(image), init);
  if (typeof VideoFrame === 'undefined') throw new Error('This browser has no WebCodecs VideoFrame, so video export is unavailable. Use a current Chrome or Edge, or export an image sequence.');
  const px = await readPixels(p.device, image, p.opaque);
  return new VideoFrame(px, { format: p.opaque ? 'RGBX' : 'RGBA', codedWidth: image.width, codedHeight: image.height, timestamp: init.timestamp ?? 0, duration: init.duration ?? undefined });
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
  await ensureCapture(p.device);
  if (captureMode === 'readback') {
    const px = await readPixels(p.device, image, p.opaque);
    const c = new OffscreenCanvas(image.width, image.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('This browser has no 2D canvas to encode pictures with.');
    const data = new ImageData(image.width, image.height);
    data.data.set(px);
    ctx.putImageData(data, 0, 0);
    return c.convertToBlob({ type: mime, quality });
  }
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

let avifProbe: Promise<boolean> | null = null;

/** True when this browser can encode AVIF stills (`convertToBlob` returns PNG when it cannot). Asked once; the Output node hides AVIF otherwise. */
export function canEncodeAvif(): Promise<boolean> {
  avifProbe ??= (async () => {
    try {
      if (typeof OffscreenCanvas === 'undefined') return false;
      const c = new OffscreenCanvas(2, 2);
      if (!c.getContext('2d')) return false;
      const blob = await c.convertToBlob({ type: 'image/avif', quality: 0.5 });
      return blob.type === 'image/avif' && blob.size > 0;
    } catch {
      return false;
    }
  })();
  return avifProbe;
}
