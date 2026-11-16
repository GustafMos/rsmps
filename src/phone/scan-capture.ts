/**
 * Taking the full-resolution still for scan mode. Three ways, picked per platform (pure `pickCapturePath`), each with the next as its
 * fallback at run time:
 *
 *  1. `takePhoto`    ImageCapture.takePhoto() on the live track: a real photo at the sensor's photo size (Chrome / Android).
 *  2. `grabFrame`    ask the track for its largest size (applyConstraints), draw the video frame on a canvas, JPEG 0.95. Used where the
 *                    stream itself is big (>= 2500 px) but takePhoto does not exist.
 *  3. `nativeCamera` a hidden <input type="file" accept="image/*" capture="environment">: the phone's own camera app. Always works on iOS,
 *                    needs a tap per photo (so no auto-capture), and the viewfinder stream is released while the camera app is open.
 *
 * Only the choice and the size arithmetic are pure and tested; the rest needs a real phone.
 */
import type { CapturePathName } from './scan-photos';
import { PHOTO_LIMITS, PHOTO_TYPES } from './scan-protocol';

export interface CaptureEnv {
  /** `ImageCapture` exists and has takePhoto. */
  imageCapture: boolean;
  /** Longest side the live track offers (capabilities max, or its current size), 0 when unknown / no stream. */
  trackMaxSide: number;
  /** The viewfinder could not be opened at all. */
  noStream: boolean;
}

/** Streams at least this big give a usable scan frame without the native camera. */
export const MIN_GRAB_SIDE = 2500;

/** The path to try first, and the whole chain in order. */
export function pickCapturePath(env: CaptureEnv): { first: CapturePathName; chain: CapturePathName[] } {
  const chain: CapturePathName[] = [];
  if (!env.noStream && env.imageCapture) chain.push('takePhoto');
  if (!env.noStream && env.trackMaxSide >= MIN_GRAB_SIDE) chain.push('grabFrame');
  chain.push('nativeCamera'); // always last: works everywhere a file input does
  return { first: chain[0], chain };
}

export const PATH_TEXT: Record<CapturePathName, string> = {
  takePhoto: 'Photo mode: full sensor resolution (takePhoto)',
  grabFrame: 'Camera frame at the largest size the camera offers',
  nativeCamera: "Your phone's own camera app (full resolution, one tap per sheet)",
};

/** Auto-capture needs a path that does not need a tap. */
export const canAutoCapture = (p: CapturePathName): boolean => p !== 'nativeCamera';

/** Largest canvas area a phone browser reliably allows (iOS Safari: 16,777,216 px). */
export const MAX_CANVAS_PIXELS = 16_000_000;

/** Size to draw a w x h frame at so the canvas stays within the browser's limit (never enlarges). */
export function fitCanvas(w: number, h: number, maxPixels = MAX_CANVAS_PIXELS): { w: number; h: number } {
  if (w * h <= maxPixels) return { w, h };
  const k = Math.sqrt(maxPixels / (w * h));
  return { w: Math.floor(w * k), h: Math.floor(h * k) };
}

/** Scales to try, one after another, when a picture is over the size cap (each step re-encodes at JPEG quality 0.92). */
export function shrinkScales(bytes: number, cap = PHOTO_LIMITS.maxBytes): number[] {
  if (bytes <= cap) return [];
  const scales: number[] = [];
  // JPEG size falls about with the pixel count: aim a little under the cap
  let k = Math.sqrt((cap * 0.85) / bytes);
  for (let i = 0; i < 4; i++) {
    scales.push(Math.max(0.2, k));
    k *= 0.8;
  }
  return scales;
}

/** Is this one of the types the computer accepts? */
export const isAllowedType = (t: string): boolean => (PHOTO_TYPES as readonly string[]).includes(t);

export const JPEG_QUALITY = 0.95;

/* ------------------------------------- browser parts (need a real phone) ------------------------------------- */

type ImageCaptureLike = {
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>;
  getPhotoCapabilities?(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }>;
};
declare const ImageCapture: (new (track: MediaStreamTrack) => ImageCaptureLike) | undefined;

export function hasImageCapture(): boolean {
  return typeof ImageCapture !== 'undefined' && typeof ImageCapture.prototype?.takePhoto === 'function';
}

export interface Viewfinder {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** The largest side the track says it can deliver (0 = unknown). */
  maxSide: number;
}

/** Rear camera, video only, at a practical preview size (1920 x 1080 ideal; the still is taken separately). */
export async function openViewfinder(video: HTMLVideoElement): Promise<Viewfinder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera on this page (it needs https).');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  const track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const caps = (track.getCapabilities?.() ?? {}) as { width?: { max?: number }; height?: { max?: number } };
  const st = track.getSettings?.() ?? {};
  const maxSide = Math.max(caps.width?.max ?? 0, caps.height?.max ?? 0, st.width ?? 0, st.height ?? 0);
  return { stream, track, maxSide };
}

export function closeViewfinder(v: Viewfinder | null, video: HTMLVideoElement): void {
  v?.stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

async function canvasBlob(canvas: HTMLCanvasElement, quality = JPEG_QUALITY): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), 'image/jpeg', quality));
}

/** Path 1. */
export async function captureTakePhoto(v: Viewfinder): Promise<Blob> {
  if (!hasImageCapture() || !ImageCapture) throw new Error('takePhoto is not available.');
  const ic = new ImageCapture(v.track);
  let settings: Record<string, unknown> | undefined;
  try {
    const caps = await ic.getPhotoCapabilities?.();
    if (caps?.imageWidth?.max && caps.imageHeight?.max) settings = { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max, fillLightMode: 'off' };
  } catch {
    /* some phones throw here: take the default photo size */
  }
  try {
    return await ic.takePhoto(settings);
  } catch (err) {
    if (!settings) throw err;
    return ic.takePhoto(); // an explicit size can be refused: the default is still a photo-sized still
  }
}

/** Path 2: the largest frame the track offers. The preview constraints are restored afterwards. */
export async function captureGrabFrame(v: Viewfinder, video: HTMLVideoElement): Promise<Blob> {
  const caps = (v.track.getCapabilities?.() ?? {}) as { width?: { max?: number }; height?: { max?: number } };
  const before = { w: video.videoWidth, h: video.videoHeight };
  const big = caps.width?.max && caps.height?.max;
  if (big) {
    try {
      await v.track.applyConstraints({ width: { ideal: caps.width!.max! }, height: { ideal: caps.height!.max! } });
      for (let i = 0; i < 20 && video.videoWidth === before.w && video.videoHeight === before.h && before.w < caps.width!.max!; i++) await new Promise((r) => setTimeout(r, 75));
      await new Promise((r) => setTimeout(r, 120)); // a frame at the new size
    } catch {
      /* keep the current size */
    }
  }
  try {
    const size = fitCanvas(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    canvas.getContext('2d')!.drawImage(video, 0, 0, size.w, size.h);
    return await canvasBlob(canvas);
  } finally {
    if (big) await v.track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }).catch(() => undefined);
  }
}

/** Path 3: the phone's camera app. Resolves with the file, or null when the person came back without a photo. */
export function captureNativeCamera(input: HTMLInputElement): Promise<File | null> {
  return new Promise((resolve) => {
    const done = (f: File | null) => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      resolve(f);
    };
    const onChange = () => done(input.files?.[0] ?? null);
    const onCancel = () => done(null);
    input.value = '';
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

/**
 * Make sure a still is something the computer accepts: JPEG / PNG / WebP as they are, anything else (HEIC from a camera app that does
 * not convert, an empty type) is re-encoded as JPEG 0.92; a picture over the size cap is shrunk step by step. Returns the blob to send.
 */
export async function prepareStill(blob: Blob): Promise<{ blob: Blob; w: number; h: number }> {
  let type = blob.type;
  let bmp: ImageBitmap | null = null;
  const decode = async () => (bmp ??= await createImageBitmap(blob));
  let out = blob;
  if (!isAllowedType(type)) {
    try {
      const b = await decode();
      const c = document.createElement('canvas');
      const s = fitCanvas(b.width, b.height);
      c.width = s.w;
      c.height = s.h;
      c.getContext('2d')!.drawImage(b, 0, 0, s.w, s.h);
      out = await canvasBlob(c, 0.92);
      type = out.type;
    } catch {
      throw new Error('This photo format is not supported. Set the phone camera to "Most Compatible" (JPEG) and try again.');
    }
  }
  for (const k of shrinkScales(out.size)) {
    const b = await decode();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b.width * k));
    c.height = Math.max(1, Math.round(b.height * k));
    c.getContext('2d')!.drawImage(b, 0, 0, c.width, c.height);
    out = await canvasBlob(c, 0.92);
    if (out.size <= PHOTO_LIMITS.maxBytes) break;
  }
  if (out.size > PHOTO_LIMITS.maxBytes) throw new Error('This photo is too large to send.');
  let w = 0;
  let h = 0;
  try {
    const b = await decode();
    w = b.width;
    h = b.height;
  } catch {
    /* the size is only informational */
  }
  // (a shrunk picture is smaller than the declared w x h: the size is informational, the computer decodes the real one)
  (bmp as ImageBitmap | null)?.close?.();
  return { blob: out, w, h };
}
