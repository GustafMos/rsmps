/**
 * Node params -> live picture source, for the three live picture inputs (Webcam, Phone Camera, URL / Stream).
 * The nodes use these in `render` and the live recorder uses them to find the same stream, so the two cannot disagree. Pure.
 */
import type { CameraControls, LiveSource } from '../types';

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

/** Frame rates the Webcam node offers (besides Auto and Match project). */
export const CAMERA_FRAME_RATES = [24, 25, 30, 50, 60] as const;

/** The panel-only camera settings kept in the hidden `cameraExtra` param (text, so one param holds them all). */
export function parseCameraExtra(raw: unknown): CameraControls {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as CameraControls) : {};
  } catch {
    return {};
  }
}

/**
 * What the Webcam node asks of the camera itself, from its params (defaults applied) and the project's frame rate.
 * Neutral values (zoom 1, no frame rate, no manual modes) ask for nothing, so an old project leaves the camera alone.
 */
export function cameraControlsOf(p: Params, projectFps: number): CameraControls {
  const x = parseCameraExtra(p.cameraExtra);
  const rate = String(p.frameRate ?? 'auto');
  const out: CameraControls = { ...x };
  if (rate === 'project') out.frameRate = Math.max(1, Math.round(projectFps || 0)) || undefined;
  else if (rate !== 'auto' && Number.isFinite(Number(rate))) out.frameRate = Number(rate);
  else delete out.frameRate;
  const zoom = Number(p.zoom ?? 1);
  out.zoom = Number.isFinite(zoom) ? Math.max(0.1, zoom) : 1;
  const comp = Number(p.exposureComp ?? 0);
  out.exposureComp = Number.isFinite(comp) ? comp : 0;
  const fd = Number(p.focusDistance ?? 0.5);
  if (out.focus === 'manual') out.focusDistance = Number.isFinite(fd) ? fd : 0.5;
  const ct = Number(p.colorTemp ?? 5000);
  if (out.whiteBalance === 'manual') out.colorTemp = Number.isFinite(ct) ? ct : 5000;
  return out;
}

/** Webcam: always a source (an empty device is the default camera). */
export function cameraSource(p: Params): LiveSourceRequest {
  const size = CAMERA_SIZES[String(p.resolution ?? 'auto')];
  const deviceId = String(p.device ?? '');
  // "Side" picks one of a phone's own cameras; a camera chosen by name wins over it.
  const facing = deviceId ? undefined : p.facing === 'back' ? ('environment' as const) : p.facing === 'front' ? ('user' as const) : undefined;
  return { kind: 'camera', deviceId, ...size, ...(facing ? { facing } : {}), freeze: !!p.freeze };
}

/** The Webcam source as the node asks for it: the stream plus what to do to the camera itself (`projectFps` feeds "Match project"). */
export function cameraRequest(p: Params, projectFps: number): LiveSourceRequest {
  return { ...(cameraSource(p) as Extract<LiveSourceRequest, { kind: 'camera' }>), controls: cameraControlsOf(p, projectFps) };
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
  // a back camera looks at the world, not at you: never mirrored
  if (type === 'camera-in') return { mirror: !!p.mirror && !(p.facing === 'back' && !p.device), turns: 0 };
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
