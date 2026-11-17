/**
 * Node params -> live picture source, for the three live picture inputs (Webcam, Phone Camera, URL / Stream).
 * The nodes use these in `render` and the live recorder uses them to find the same stream, so the two cannot disagree. Pure.
 */
import type { LiveSource } from '../types';

export type LiveSourceRequest = LiveSource & { freeze?: boolean };

/** Node types that have a live picture (and so a Record button). */
export const LIVE_PICTURE_TYPES = ['camera-in', 'phone-camera', 'url-in'] as const;
export type LivePictureType = (typeof LIVE_PICTURE_TYPES)[number];

export function isLivePictureType(type: string): type is LivePictureType {
  return (LIVE_PICTURE_TYPES as readonly string[]).includes(type);
}

const CAMERA_SIZES: Record<string, { width: number; height: number } | undefined> = {
  auto: undefined,
  '640x480': { width: 640, height: 480 },
  '1280x720': { width: 1280, height: 720 },
  '1920x1080': { width: 1920, height: 1080 },
};

type Params = Readonly<Record<string, unknown>>;

/** Webcam: always a source (an empty device is the default camera). */
export function cameraSource(p: Params): LiveSourceRequest {
  const size = CAMERA_SIZES[String(p.resolution ?? 'auto')];
  return { kind: 'camera', deviceId: String(p.device ?? ''), ...size, freeze: !!p.freeze };
}

/** Phone Camera: null until a phone was linked. */
export function phoneSource(p: Params): LiveSourceRequest | null {
  const session = String(p.session ?? '');
  return session ? { kind: 'phone', session, freeze: !!p.freeze } : null;
}

/** URL / Stream: null while the address is empty. */
export function urlSource(p: Params): LiveSourceRequest | null {
  const url = String(p.url ?? '').trim();
  if (!url) return null;
  return { kind: 'url', url, mode: p.kind as 'auto' | 'image' | 'mjpeg' | 'video' | undefined, refresh: p.refresh as number | undefined };
}

/** The source of a live picture node (params with defaults applied), or null when it is not set up yet or is another node type. */
export function liveSourceOfNode(type: string, p: Params): LiveSourceRequest | null {
  if (type === 'camera-in') return cameraSource(p);
  if (type === 'phone-camera') return phoneSource(p);
  if (type === 'url-in') return urlSource(p);
  return null;
}

/** How the node shows the incoming picture: mirrored and / or turned clockwise in quarter turns. A recording applies the same. */
export function liveOrientOfNode(type: string, p: Params): { mirror: boolean; turns: number } {
  if (type === 'camera-in') return { mirror: !!p.mirror, turns: 0 };
  if (type === 'phone-camera') {
    const turns = p.rotate === 'auto' || p.rotate === undefined ? 0 : Math.round(Number(p.rotate) / 90);
    return { mirror: !!p.mirror, turns: Number.isFinite(turns) ? ((turns % 4) + 4) % 4 : 0 };
  }
  return { mirror: false, turns: 0 };
}

/** First word of a recorded clip's name. */
export function liveTakeLabel(type: string): string {
  return type === 'camera-in' ? 'Webcam' : type === 'phone-camera' ? 'Phone' : 'Stream';
}
