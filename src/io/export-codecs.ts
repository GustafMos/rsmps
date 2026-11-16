/**
 * Which Output `codec` values go through FFmpeg (desktop app) and what each needs. Keyed by the node's enum value, so the node
 * kernel type stays `{ value, label }`. The ids on the right are the ones `desktop/addons/export.mjs` accepts (src/cli/encode.ts).
 */
export interface FfmpegCodec {
  /** Id the desktop export endpoint takes. */
  id: string;
  /** Needs an even width and height (the frame is padded with transparent texels). */
  even: boolean;
  /** Keeps transparency: frames are sent straight alpha. Others get the picture composited over black. */
  alpha: boolean;
  ext: 'mov' | 'webm' | 'mp4';
}

/** Always FFmpeg. */
const ONLY: Record<string, FfmpegCodec> = {
  prores: { id: 'prores', even: false, alpha: false, ext: 'mov' },
  prores4444: { id: 'prores4444', even: false, alpha: true, ext: 'mov' },
  qtrle: { id: 'qtrle', even: false, alpha: true, ext: 'mov' },
  'png-mov': { id: 'png', even: false, alpha: true, ext: 'mov' },
  'webm-alpha': { id: 'webm-alpha', even: true, alpha: true, ext: 'webm' },
};

/** WebCodecs first; FFmpeg only when the browser engine cannot encode them. */
const FALLBACK: Record<string, FfmpegCodec> = {
  avc: { id: 'h264', even: true, alpha: false, ext: 'mp4' },
  hevc: { id: 'hevc', even: true, alpha: false, ext: 'mp4' },
};

/** The codec when it is an FFmpeg-only format (shows a "needs FFmpeg" tag), else null. */
export function ffmpegOnlyCodec(value: string): FfmpegCodec | null {
  return ONLY[value] ?? null;
}

/** H.264 / H.265 through FFmpeg, used only when WebCodecs cannot encode them. */
export function ffmpegFallbackCodec(value: string): FfmpegCodec | null {
  return FALLBACK[value] ?? null;
}

export function needsFfmpeg(value: string): boolean {
  return value in ONLY;
}

/** Output `codec` values that need FFmpeg, in menu order. */
export const FFMPEG_CODEC_VALUES: readonly string[] = Object.keys(ONLY);

/** Plain words for the case "an FFmpeg format is chosen but FFmpeg cannot be used". */
export function ffmpegMissingMessage(desktop: boolean): string {
  return desktop
    ? 'This video format needs FFmpeg, which is not set up yet. Open Plugins, then Official add-ons, and install FFmpeg (or choose one you already have).'
    : 'This video format needs the desktop app, or the free command-line tool (see docs/CLI.md). It is not available in the web version.';
}

export type VideoRoute = 'webcodecs' | 'ffmpeg' | 'missing';

/** Where a video Output goes: FFmpeg-only formats need FFmpeg (or are reported missing); everything else stays on WebCodecs. */
export function videoRoute(codec: string, ffmpegAvailable: boolean): VideoRoute {
  if (!needsFfmpeg(codec)) return 'webcodecs';
  return ffmpegAvailable ? 'ffmpeg' : 'missing';
}
