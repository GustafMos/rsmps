/**
 * The one place that puts a browser picture source on a GPU texture.
 *
 * Chrome accepts a VideoFrame or an <video> element as the source of `copyExternalImageToTexture`; Firefox only accepts
 * ImageBitmap, <img>, canvases. We try the direct (fast) path once per source type; if the browser rejects it with a
 * TypeError the type is remembered and every later upload goes through `createImageBitmap` (and, if even that refuses
 * the source, through a 2D canvas).
 */

export type ExternalSource = ImageBitmap | HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | VideoFrame;
type Kind = 'frame' | 'video' | 'other';

const rejected = new Set<Kind>();
let scratch: OffscreenCanvas | null = null;

function kindOf(s: unknown): Kind {
  if (typeof VideoFrame !== 'undefined' && s instanceof VideoFrame) return 'frame';
  if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) return 'video';
  return 'other';
}

/** For tests: forget what was learned about the browser. */
export function resetUploadCapabilities(): void {
  rejected.clear();
}

/** Which source kinds this browser refused to upload directly (diagnostics). */
export function directUploadRejected(): string[] {
  return [...rejected];
}

/**
 * Upload `source` into `texture` (rgba8unorm, size width x height). `natural` is the source's own size; when it differs from
 * the target the picture is scaled by createImageBitmap on the way. Premultiplies alpha.
 */
export async function uploadExternal(
  device: GPUDevice,
  source: ExternalSource,
  texture: GPUTexture,
  width: number,
  height: number,
  natural?: { width: number; height: number },
): Promise<void> {
  const dest = { texture, premultipliedAlpha: true };
  const kind = kindOf(source);
  const resize = !!natural && (natural.width !== width || natural.height !== height);
  if (!resize && !(kind !== 'other' && rejected.has(kind))) {
    try {
      device.queue.copyExternalImageToTexture({ source }, dest, [width, height]);
      return;
    } catch (err) {
      if (!(err instanceof TypeError) || kind === 'other') throw err;
      rejected.add(kind); // e.g. Firefox: no VideoFrame / <video> as a texture source
    }
  }
  let bmp: ImageBitmap | null = null;
  try {
    bmp = resize ? await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' }) : await createImageBitmap(source);
  } catch {
    bmp = null;
  }
  if (bmp) {
    try {
      device.queue.copyExternalImageToTexture({ source: bmp }, dest, [width, height]);
    } finally {
      bmp.close();
    }
    return;
  }
  // Last resort: draw through a canvas.
  const canvas = (scratch ??= new OffscreenCanvas(width, height));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot read the picture: no ImageBitmap and no 2D canvas support for this source.');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  device.queue.copyExternalImageToTexture({ source: canvas }, dest, [width, height]);
}
