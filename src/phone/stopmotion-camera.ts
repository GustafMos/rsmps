/**
 * Taking a still on the phone for stop motion, and locking exposure and focus. The choices are pure and tested with fakes; `browserStillEnv`
 * is the thin part that needs a real camera.
 *
 *  1. ImageCapture `takePhoto()` on the live track: the camera's full-size photo (Chrome on Android). Works while the same track is sent to
 *     the computer as the live picture.
 *  2. Otherwise the current video frame drawn on a canvas (the size the live stream has).
 *
 * The node's Shot size (full / 1080 / 720 on the longer side) is applied here, so a smaller shot also travels faster.
 */
import { clamp, modesOf, rangeOf, type Caps } from '../io/camera-controls';
import { MAX_CANVAS_PIXELS, fitCanvas } from './scan-capture';

export interface Still {
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
}

export interface StillEnv {
  /** ImageCapture's takePhoto, when the browser has it. */
  takePhoto?: () => Promise<Blob>;
  /** Pixel size of a picture (decodes it). */
  sizeOf(blob: Blob): Promise<{ w: number; h: number } | null>;
  /** The same picture re-encoded at w x h. */
  resize(blob: Blob, w: number, h: number): Promise<Blob | null>;
  /** Size of the live video frame (0 x 0 when there is none). */
  frameSize(): { w: number; h: number };
  /** The live video frame at w x h as JPEG. */
  encodeFrame(w: number, h: number): Promise<Blob | null>;
}

/** w x h scaled so the longer side is at most `maxSide` (0 = no limit), never enlarged, and within the canvas limit. */
export function fitSide(w: number, h: number, maxSide: number): { w: number; h: number } {
  const longer = Math.max(w, h);
  let out = { w, h };
  if (maxSide > 0 && longer > maxSide) out = { w: Math.max(1, Math.round((w * maxSide) / longer)), h: Math.max(1, Math.round((h * maxSide) / longer)) };
  return out.w * out.h > MAX_CANVAS_PIXELS ? fitCanvas(out.w, out.h) : out;
}

const mimeOf = (b: Blob): string => (b.type === 'image/png' || b.type === 'image/webp' ? b.type : 'image/jpeg');

async function bytesOf(blob: Blob, w: number, h: number): Promise<Still> {
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: mimeOf(blob), w, h };
}

/** One still no bigger than `maxSide` on its longer side (0 = the camera's own size). Null when the camera gives nothing. */
export async function captureStill(env: StillEnv, maxSide: number): Promise<Still | null> {
  if (env.takePhoto) {
    try {
      const photo = await env.takePhoto();
      const size = await env.sizeOf(photo);
      if (photo.size > 0 && size) {
        const to = fitSide(size.w, size.h, maxSide);
        if (to.w === size.w && to.h === size.h) return bytesOf(photo, size.w, size.h);
        const small = await env.resize(photo, to.w, to.h);
        if (small) return bytesOf(small, to.w, to.h);
        return bytesOf(photo, size.w, size.h); // could not shrink it: the full picture is better than none
      }
    } catch {
      /* fall through to the video frame */
    }
  }
  const f = env.frameSize();
  if (!(f.w > 0 && f.h > 0)) return null;
  const to = fitSide(f.w, f.h, maxSide);
  const blob = await env.encodeFrame(to.w, to.h);
  return blob && blob.size > 0 ? bytesOf(blob, to.w, to.h) : null;
}

/** The real thing: a video element and its camera track. */
export function browserStillEnv(video: HTMLVideoElement, track: () => MediaStreamTrack | null): StillEnv {
  const IC = (globalThis as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  const canvas = (w: number, h: number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const toBlob = (c: HTMLCanvasElement, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', q));
  return {
    takePhoto: IC
      ? () => {
          const t = track();
          if (!t || t.readyState !== 'live') return Promise.reject(new Error('no camera'));
          return new IC(t).takePhoto();
        }
      : undefined,
    async sizeOf(blob) {
      try {
        const bmp = await createImageBitmap(blob);
        const s = { w: bmp.width, h: bmp.height };
        bmp.close();
        return s;
      } catch {
        return null;
      }
    },
    async resize(blob, w, h) {
      try {
        const bmp = await createImageBitmap(blob);
        const c = canvas(w, h);
        c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        return await toBlob(c, 0.92);
      } catch {
        return null;
      }
    },
    frameSize: () => ({ w: video.videoWidth, h: video.videoHeight }),
    async encodeFrame(w, h) {
      const c = canvas(w, h);
      c.getContext('2d')!.drawImage(video, 0, 0, w, h);
      return toBlob(c, 0.92);
    },
  };
}

/** A small picture for the onion skin and the strip (JPEG, longer side at most `side`). */
export async function makeThumb(blob: Blob, side = 640): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.7));
  } catch {
    return null;
  }
}

/* ------------------------------------------- lock exposure and focus ------------------------------------------- */

export interface LockTrack {
  getCapabilities?(): object;
  getSettings?(): object;
  applyConstraints(c: MediaTrackConstraints): Promise<void>;
}

/** What the camera lets a web page lock: names of the controls, or [] when none. */
export function lockable(caps: Caps | null | undefined): string[] {
  const out: string[] = [];
  if (modesOf(caps, 'focusMode').includes('manual')) out.push('focus');
  if (modesOf(caps, 'exposureMode').includes('manual')) out.push('exposure');
  if (modesOf(caps, 'whiteBalanceMode').includes('manual')) out.push('white balance');
  return out;
}

/**
 * Lock (or release) focus, exposure and white balance where the camera offers manual modes: the values the camera chose at this moment are
 * kept. Says in plain words what happened.
 */
export async function setCameraLock(track: LockTrack | null, on: boolean): Promise<{ ok: boolean; note: string }> {
  if (!track) return { ok: false, note: 'There is no camera to lock.' };
  const caps = (track.getCapabilities?.() ?? null) as Caps | null;
  const what = lockable(caps);
  if (!what.length) return { ok: false, note: 'This camera does not let a web page lock exposure or focus.' };
  const cur = (track.getSettings?.() ?? {}) as Record<string, unknown>;
  const adv: Record<string, unknown> = {};
  if (what.includes('focus')) {
    adv.focusMode = on ? 'manual' : modesOf(caps, 'focusMode').includes('continuous') ? 'continuous' : 'single-shot';
    const r = rangeOf(caps, 'focusDistance');
    if (on && r && typeof cur.focusDistance === 'number') adv.focusDistance = clamp(cur.focusDistance, r.min, r.max);
  }
  if (what.includes('exposure')) {
    adv.exposureMode = on ? 'manual' : 'continuous';
    const t = rangeOf(caps, 'exposureTime');
    if (on && t && typeof cur.exposureTime === 'number') adv.exposureTime = clamp(cur.exposureTime, t.min, t.max);
    const iso = rangeOf(caps, 'iso');
    if (on && iso && typeof cur.iso === 'number') adv.iso = clamp(cur.iso, iso.min, iso.max);
  }
  if (what.includes('white balance')) {
    adv.whiteBalanceMode = on ? 'manual' : 'continuous';
    const k = rangeOf(caps, 'colorTemperature');
    if (on && k && typeof cur.colorTemperature === 'number') adv.colorTemperature = clamp(cur.colorTemperature, k.min, k.max);
  }
  try {
    await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
  } catch {
    return { ok: false, note: 'The camera refused to lock.' };
  }
  return { ok: true, note: on ? `Locked: ${what.join(', ')}.` : 'Unlocked.' };
}
