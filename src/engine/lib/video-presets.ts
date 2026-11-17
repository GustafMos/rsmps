/**
 * "For" presets of the Output node's video side: General, VJ software, Editing, Web / social. A preset never picks something the
 * machine cannot do: the effective codec is resolved from the preset AND what is available (FFmpeg set up, which encoders it has).
 * Pure; used by the exporter, the CLI and the node summary.
 */

export type VideoPreset = 'general' | 'vj' | 'editing' | 'web';
export const VIDEO_PRESETS: readonly VideoPreset[] = ['general', 'vj', 'editing', 'web'];

export function isVideoPreset(v: unknown): v is VideoPreset {
  return typeof v === 'string' && (VIDEO_PRESETS as readonly string[]).includes(v);
}

export interface VideoAvailability {
  /** FFmpeg is set up (desktop add-on, or the CLI's FFmpeg). */
  ffmpeg: boolean;
  /** Encoder names of the installed FFmpeg; null = could not be listed (then only `prores_ks` is assumed, nearly every build has it). */
  encoders: ReadonlySet<string> | null;
}

export interface VideoSettings {
  codec: string;
  bitrate: number;
  allKeys: boolean;
}

export interface ResolvedVideo extends VideoSettings {
  /** Short text for the node summary, '' for General. */
  summary: string;
  /** Set when the preset could not give its first choice: goes into the export notes. */
  note: string;
}

const has = (a: VideoAvailability, encoder: string): boolean => a.ffmpeg && (a.encoders ? a.encoders.has(encoder) : encoder === 'prores_ks');

/** Bitrate for intra-only video: at least `baseMbps` at 1080p, scaled with the pixel count, never above the node's 200 maximum. */
export function intraBitrate(current: number, pixels: number, baseMbps: number): number {
  const floor = Math.min(200, Math.max(8, Math.round(((baseMbps * Math.max(1, pixels)) / (1920 * 1080)) * 2) / 2));
  return Math.min(200, Math.max(current, floor));
}

const builtIn = (codec: string): string => (codec === 'vp9' ? 'vp9' : 'avc');
const builtInName = (codec: string): string => (codec === 'vp9' ? 'VP9' : 'H.264');

export function resolveVideoPreset(preset: VideoPreset | string, cur: VideoSettings, avail: VideoAvailability, pixels = 1920 * 1080): ResolvedVideo {
  const keep = (summary = '', note = ''): ResolvedVideo => ({ ...cur, summary, note });
  if (preset === 'vj') {
    if (has(avail, 'dxv')) return { ...cur, codec: 'dxv', summary: 'VJ: DXV-compatible', note: '' };
    if (has(avail, 'prores_ks')) {
      return { ...cur, codec: 'prores', summary: 'VJ: ProRes-compatible 422 HQ', note: 'VJ software: this FFmpeg has no DXV encoder, so ProRes-compatible 422 HQ was used (Resolume plays it natively).' };
    }
    const codec = builtIn(cur.codec);
    const bitrate = intraBitrate(cur.bitrate, pixels, 40);
    return {
      codec,
      bitrate,
      allKeys: true,
      summary: `VJ: ${builtInName(codec)} all key frames`,
      note: `VJ software: DXV and ProRes-compatible need the desktop app with the FFmpeg add-on, so this was written as ${builtInName(codec)} with every frame a key frame at ${bitrate} Mbps. For the best playback convert it with Resolume Alley, or choose HAP if your VJ software supports it.`,
    };
  }
  if (preset === 'editing') {
    if (has(avail, 'prores_ks')) return { ...cur, codec: 'prores', summary: 'Editing: ProRes-compatible 422 HQ', note: '' };
    const codec = builtIn(cur.codec);
    const bitrate = intraBitrate(cur.bitrate, pixels, 30);
    return { codec, bitrate, allKeys: true, summary: `Editing: ${builtInName(codec)} all key frames`, note: `Editing: ProRes-compatible needs the desktop app with the FFmpeg add-on, so this was written as ${builtInName(codec)} with every frame a key frame at ${bitrate} Mbps.` };
  }
  if (preset === 'web') return { ...cur, codec: 'avc', allKeys: false, summary: 'Web: H.264', note: '' };
  return keep();
}

/* Availability the node summary knows about (set by the desktop add-ons client when FFmpeg's status arrives). */
let known: VideoAvailability = { ffmpeg: false, encoders: null };
export function setVideoAvailability(a: VideoAvailability): void {
  known = a;
}
export function getVideoAvailability(): VideoAvailability {
  return known;
}
