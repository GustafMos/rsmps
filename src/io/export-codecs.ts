/**
 * THE table of everything the app can write through FFmpeg (the user's own FFmpeg: the optional add-on or a located install; RSMPS never
 * bundles or hosts an encoder). One row per format: id, label, container, the encoder(s) it needs, the exact arguments, alpha, bitrate,
 * the audio to pair with, group and hint. Everything else is generated from or checked against this table: the Output node's codec
 * list, the dropdown tags (src/ui/inspector/CodecSelect.tsx), the desktop and CLI argument builders (src/cli/encode.ts), the CLI flags
 * and docs (a test keeps them in step). Adding a format is one row here plus its enum option in the Output node.
 *
 * Every row also says WHO writes it (`route`): `builtin-webcodecs` (the browser's own encoder), `own` (an encoder of this app, src/io/encoders:
 * works everywhere, no add-on) or `ffmpeg` (the user's own FFmpeg). A format that exists on two routes is ONE row with the better route chosen
 * here (own wins; its `encoders` / `args` describe the FFmpeg equivalent, which scripts/check-formats.mjs also verifies).
 *
 * Names that are somebody's trademark carry the "-compatible" wording ("ProRes-compatible", "DXV-compatible", "DNxHR-compatible",
 * "CineForm-compatible"): the files follow the format but are written by FFmpeg, not by that company's software. Open formats keep
 * their plain names. A format is offered only when the installed FFmpeg lists its encoder (`ffmpeg -encoders`, src/io/ffmpeg-encoders.ts).
 */

export type CodecGroup = 'General' | 'VJ software' | 'Editing' | 'Lossless' | 'Delivery' | 'Animated picture' | 'Legacy' | 'Web' | 'High dynamic range' | 'Other' | 'Audio';
/** video / animated: the Output node's Video codec list; still: Image format (stills and image sequences); audio: the Audio Output's Sound file. */
export type CodecKind = 'video' | 'animated' | 'still' | 'audio';
/** Who writes the file. */
export type FormatRoute = 'builtin-webcodecs' | 'own' | 'ffmpeg';

export interface ArgOpts {
  bitrateMbps: number;
  /** Every frame a key frame (formats that take a bitrate only). */
  allKeys: boolean;
  /** Encoders the FFmpeg has (a row with several possible encoders picks the best present one); null = unknown. */
  encoders: ReadonlySet<string> | null;
  /** GIF palette dither: bayer (default), floyd_steinberg or none. */
  dither?: 'bayer' | 'floyd_steinberg' | 'none';
}

export interface CodecRow {
  /** Id the desktop endpoint and the CLI take (`--codec`). */
  id: string;
  /** The Output node's `codec` value. */
  value: string;
  label: string;
  group: CodecGroup;
  kind: CodecKind;
  /** File extension; for a sequence the frames' extension. */
  ext: string;
  /** Any one of these FFmpeg encoders is enough. Empty = FFmpeg has no equivalent (the format is written by the app itself). */
  encoders: readonly string[];
  /** Who writes it. A row with an own encoder is always written by the app (works everywhere); FFmpeg is only the fallback named by `encoders`. */
  route: FormatRoute;
  /** Id of the encoder in src/io/encoders (`ENCODERS`) when route is 'own'. */
  own?: string;
  /** Float pixels (half float, written linear): OpenEXR, Radiance HDR, 16-bit TIFF. */
  float?: boolean;
  /** Exact FFmpeg output arguments (codec, pixel format...), without input, audio or file. */
  args: (o: ArgOpts) => string[];
  /** Frames are sent straight alpha and the file keeps it; otherwise the picture is composited over black. */
  alpha: boolean;
  /** Needs an even width and height (the frame is padded). */
  even: boolean;
  /** Takes the Bitrate / All key frames settings. */
  bitrate: boolean;
  /** FFmpeg audio arguments to pair with the picture; null = the file carries no sound. */
  audio: readonly string[] | null;
  hint: string;
  /** Smallest picture the encoder accepts (FFmpeg's DNxHR refuses anything under 256x120). */
  minSize?: readonly [number, number];
  /** The browser's own encoder (WebCodecs) is tried first; works without FFmpeg. */
  builtin?: boolean;
  /** H.264 / H.265 only: FFmpeg writes it when the browser engine cannot. */
  fallback?: boolean;
  /** Offered in the app (Output node lists). */
  wired: boolean;
  aliases?: readonly string[];
}

/** A table row as written below: the route defaults to the browser's encoder for `builtin` rows and to FFmpeg otherwise. */
type RowInput = Omit<CodecRow, 'route'> & { route?: FormatRoute };

const PCM = ['-c:a', 'pcm_s16le'];
const AAC = ['-c:a', 'aac', '-b:a', '192k'];
const OPUS = ['-c:a', 'libopus', '-b:a', '160k'];
const FLAC = ['-c:a', 'flac'];
const MP2 = ['-c:a', 'mp2', '-b:a', '192k'];
const MP3 = ['-c:a', 'libmp3lame', '-b:a', '192k'];

const WRITTEN = 'Written by your own FFmpeg.';
const PRORES_NOTE = 'Follows the ProRes format but is written by FFmpeg, not by Apple software.';

/** A ProRes row: prores_ks profile 0-5 (0-3 are 4:2:2 without alpha, 4 and 5 are 4:4:4 with 16-bit alpha). */
function prores(id: string, label: string, profile: number, hint: string, extra: Partial<RowInput> = {}): RowInput {
  const alpha = profile >= 4;
  return {
    id, value: id, label, group: 'Editing', kind: 'video', ext: 'mov', encoders: ['prores_ks'],
    args: () => ['-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', alpha ? 'yuva444p10le' : 'yuv422p10le', ...(alpha ? ['-alpha_bits', '16'] : []), '-vendor', 'ap10'],
    alpha, even: false, bitrate: false, audio: PCM, hint: `${PRORES_NOTE} ${hint}`, wired: true, ...extra,
  };
}

function dnxhr(id: string, label: string, profile: string, pix: string, hint: string): RowInput {
  return {
    id, value: id, label, group: 'Editing', kind: 'video', ext: 'mov', encoders: ['dnxhd'],
    args: () => ['-c:v', 'dnxhd', '-profile:v', profile, '-pix_fmt', pix],
    alpha: false, even: false, bitrate: false, audio: PCM, hint: `Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. ${hint}`, minSize: [256, 120], wired: true,
  };
}

/** A still format written by FFmpeg only (DPX, JPEG 2000). */
function seq(id: string, label: string, ext: string, encoder: string, args: string[], alpha: boolean, group: CodecGroup, hint: string, extra: Partial<CodecRow> = {}): CodecRow {
  return { id, value: id, label, group, kind: 'still', ext, encoders: [encoder], route: 'ffmpeg', args: () => args, alpha, even: false, bitrate: false, audio: null, hint: `${hint} ${WRITTEN}`, wired: true, ...extra };
}

/** A still written by the app itself; `ffmpeg` is the equivalent FFmpeg encoder + arguments when there is one (checked by scripts/check-formats.mjs). */
function still(id: string, label: string, ext: string, own: string, alpha: boolean, group: CodecGroup, hint: string, extra: Partial<CodecRow> & { ffmpeg?: { encoder: string; args: string[] } } = {}): CodecRow {
  const { ffmpeg, ...rest } = extra;
  return { id, value: id, label, group, kind: 'still', ext, encoders: ffmpeg ? [ffmpeg.encoder] : [], route: 'own', own, args: () => ffmpeg?.args ?? [], alpha, even: false, bitrate: false, audio: null, hint, wired: true, ...rest };
}

function aud(id: string, label: string, ext: string, encoder: string, args: string[], extra: Partial<CodecRow> = {}): CodecRow {
  return { id, value: id, label, group: 'Audio', kind: 'audio', ext, encoders: [encoder], route: 'ffmpeg', args: () => args, alpha: false, even: false, bitrate: false, audio: args, hint: WRITTEN, wired: true, ...extra };
}

const mbps = (b: number) => `${b}M`;

const ROWS: readonly RowInput[] = [
  /* -------------------------------------- General: the browser's own encoders -------------------------------------- */
  {
    id: 'h264', value: 'avc', label: 'H.264 MP4', group: 'General', kind: 'video', ext: 'mp4', encoders: ['libx264'],
    args: (o) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : []), '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: true, audio: AAC, hint: 'Works everywhere.', builtin: true, fallback: true, wired: true, aliases: ['avc', 'h.264', 'x264'],
  },
  {
    id: 'hevc', value: 'hevc', label: 'H.265 MP4', group: 'General', kind: 'video', ext: 'mp4', encoders: ['libx265'],
    args: (o) => ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : []), '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: true, audio: AAC, hint: 'Works where the browser can encode it.', builtin: true, fallback: true, wired: true, aliases: ['h265', 'h.265', 'x265'],
  },
  {
    id: 'vp9', value: 'vp9', label: 'VP9 WebM', group: 'General', kind: 'video', ext: 'webm', encoders: ['libvpx-vp9'],
    args: (o) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : [])],
    alpha: false, even: true, bitrate: true, audio: OPUS, hint: 'Open format. Works everywhere.', builtin: true, wired: true,
  },
  {
    id: 'av1', value: 'av1', label: 'AV1 MP4', group: 'General', kind: 'video', ext: 'mp4', encoders: ['libaom-av1'],
    args: (o) => ['-c:v', 'libaom-av1', '-pix_fmt', 'yuv420p', '-b:v', mbps(o.bitrateMbps), '-cpu-used', '6', '-strict', 'experimental', ...(o.allKeys ? ['-g', '1'] : []), '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: true, audio: AAC, hint: 'Open format. Works where the browser can encode it.', builtin: true, wired: true,
  },

  /* -------------------------------------- VJ software: GPU-friendly -------------------------------------- */
  {
    id: 'dxv', value: 'dxv', label: 'DXV-compatible', group: 'VJ software', kind: 'video', ext: 'mov', encoders: ['dxv'],
    args: () => ['-c:v', 'dxv', '-format', 'dxt1'],
    alpha: false, even: true, bitrate: false, audio: PCM, wired: true, aliases: ['dxv-compatible'],
    hint: "Resolume's own format: plays and loops with almost no load. No transparency. Files are large (about 1 byte per pixel per frame). Sizes are padded to even numbers and the encoder pads to 16 itself. Written by FFmpeg, not by Resolume software: test your file in Resolume before a show.",
  },
  {
    id: 'hap', value: 'hap', label: 'HAP', group: 'VJ software', kind: 'video', ext: 'mov', encoders: ['hap'], route: 'own', own: 'hap',
    args: () => ['-c:v', 'hap', '-format', 'hap'],
    alpha: false, even: false, bitrate: false, audio: PCM, wired: true,
    hint: "GPU-friendly format (DXT1 textures), supported by many VJ and media-server applications; check your software's documentation. No transparency. Large files. Written by the app itself.",
  },
  {
    id: 'hap-alpha', value: 'hap_alpha', label: 'HAP Alpha', group: 'VJ software', kind: 'video', ext: 'mov', encoders: ['hap'], route: 'own', own: 'hap-alpha',
    args: () => ['-c:v', 'hap', '-format', 'hap_alpha'],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['hapalpha'],
    hint: 'HAP with transparency (DXT5 textures). Large files. Written by the app itself.',
  },
  {
    id: 'hap-q', value: 'hap_q', label: 'HAP Q', group: 'VJ software', kind: 'video', ext: 'mov', encoders: ['hap'], route: 'own', own: 'hap-q',
    args: () => ['-c:v', 'hap', '-format', 'hap_q'],
    alpha: false, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['hapq'],
    hint: 'HAP with higher picture quality (DXT5-YCoCg textures). No transparency. Large files. Written by the app itself.',
  },
  {
    id: 'mjpeg', value: 'mjpeg', label: 'Motion JPEG MOV', group: 'VJ software', kind: 'video', ext: 'mov', encoders: ['mjpeg'], route: 'own', own: 'mov-mjpeg',
    args: () => ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj422p'],
    alpha: false, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['photo-jpeg', 'motion-jpeg'],
    hint: 'Every frame is a JPEG picture: plays quickly in VJ software and edits well. No transparency. Written by the app itself.',
  },

  /* -------------------------------------- Editing / intermediate -------------------------------------- */
  prores('prores-proxy', 'ProRes-compatible Proxy', 0, 'Smallest files, for offline editing. No transparency.'),
  prores('prores-lt', 'ProRes-compatible LT', 1, 'Light files. No transparency.'),
  prores('prores-standard', 'ProRes-compatible 422', 2, 'No transparency.'),
  prores('prores', 'ProRes-compatible 422 HQ', 3, '422 HQ has no transparency. Resolume plays it natively.', { aliases: ['prores422'] }),
  prores('prores4444', 'ProRes-compatible 4444', 4, '4444 keeps transparency.', { aliases: ['prores-4444'] }),
  prores('prores-4444xq', 'ProRes-compatible XQ', 5, '4444 XQ: highest quality, with transparency. Very large files.'),
  dnxhr('dnxhr-lb', 'DNxHR-compatible LB', 'dnxhr_lb', 'yuv422p', 'Low bandwidth proxy.'),
  dnxhr('dnxhr-sq', 'DNxHR-compatible SQ', 'dnxhr_sq', 'yuv422p', 'Standard quality.'),
  dnxhr('dnxhr-hq', 'DNxHR-compatible HQ', 'dnxhr_hq', 'yuv422p', 'High quality 8-bit.'),
  dnxhr('dnxhr-hqx', 'DNxHR-compatible HQX', 'dnxhr_hqx', 'yuv422p10le', 'High quality 10-bit.'),
  dnxhr('dnxhr-444', 'DNxHR-compatible 444', 'dnxhr_444', 'yuv444p10le', 'Full color 10-bit. No transparency.'),
  {
    id: 'cineform', value: 'cineform', label: 'CineForm-compatible', group: 'Editing', kind: 'video', ext: 'mov', encoders: ['cfhd'],
    args: () => ['-c:v', 'cfhd', '-quality', 'high', '-pix_fmt', 'yuv422p10le'],
    alpha: false, even: true, bitrate: false, audio: PCM, wired: true,
    hint: 'Follows the CineForm format, written by FFmpeg, not by GoPro software. 10-bit 4:2:2, no transparency.',
  },
  {
    id: 'cineform-alpha', value: 'cineform_alpha', label: 'CineForm-compat. alpha', group: 'Editing', kind: 'video', ext: 'mov', encoders: ['cfhd'],
    args: () => ['-c:v', 'cfhd', '-quality', 'high', '-pix_fmt', 'gbrap12le'],
    alpha: true, even: true, bitrate: false, audio: PCM, wired: true,
    hint: 'CineForm-compatible with transparency (12-bit RGBA). Written by FFmpeg, not by GoPro software. Large files.',
  },

  /* -------------------------------------- Lossless / archive -------------------------------------- */
  {
    id: 'qtrle', value: 'qtrle', label: 'Animation alpha MOV', group: 'Lossless', kind: 'video', ext: 'mov', encoders: ['qtrle'],
    args: () => ['-c:v', 'qtrle', '-pix_fmt', 'argb'],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['animation'],
    hint: 'QuickTime Animation: lossless, with transparency. Large files.',
  },
  {
    id: 'png', value: 'png-mov', label: 'PNG MOV lossless', group: 'Lossless', kind: 'video', ext: 'mov', encoders: ['png'], route: 'own', own: 'mov-png',
    args: () => ['-c:v', 'png', '-pix_fmt', 'rgba'],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['mov-png', 'png-mov'],
    hint: 'PNG pictures in a MOV: lossless, with transparency. Large files. Written by the app itself.',
  },
  {
    id: 'raw-mov', value: 'raw-mov', label: 'Uncompressed MOV', group: 'Lossless', kind: 'video', ext: 'mov', encoders: [], route: 'own', own: 'mov-raw',
    args: () => [],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true, aliases: ['mov-raw', 'uncompressed'],
    hint: 'Raw 8-bit pixels (QuickTime 32-bit ARGB) in a MOV: lossless, with transparency, no decoding work. Very large files: 4 bytes per pixel per frame. Written by the app itself.',
  },
  {
    id: 'ffv1', value: 'ffv1', label: 'FFV1 MKV lossless', group: 'Lossless', kind: 'video', ext: 'mkv', encoders: ['ffv1'],
    args: () => ['-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-g', '1', '-slicecrc', '1', '-pix_fmt', 'bgra'],
    alpha: true, even: false, bitrate: false, audio: FLAC, wired: true,
    hint: 'Open lossless archive format, with transparency. Large files; few players read it.',
  },
  {
    id: 'utvideo', value: 'utvideo', label: 'UT Video AVI', group: 'Lossless', kind: 'video', ext: 'avi', encoders: ['utvideo'],
    args: () => ['-c:v', 'utvideo', '-pix_fmt', 'gbrap'],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true,
    hint: 'Fast open lossless format, with transparency. Large files.',
  },
  {
    id: 'v210', value: 'v210', label: 'Uncompressed 10-bit', group: 'Lossless', kind: 'video', ext: 'mov', encoders: ['v210'],
    args: () => ['-c:v', 'v210', '-pix_fmt', 'yuv422p10le'],
    alpha: false, even: true, bitrate: false, audio: PCM, wired: true,
    hint: 'Uncompressed 10-bit 4:2:2 (v210) in a MOV. Very large files: about 2.7 bytes per pixel per frame.',
  },
  {
    id: 'rawvideo', value: 'rawvideo', label: 'Uncompressed RGBA AVI', group: 'Lossless', kind: 'video', ext: 'avi', encoders: ['rawvideo'],
    args: () => ['-c:v', 'rawvideo', '-pix_fmt', 'bgra'],
    alpha: true, even: false, bitrate: false, audio: PCM, wired: true,
    hint: 'Raw pixels, 4 bytes per pixel per frame: a 1080p second is about 200 MB. Few players read it.',
  },

  /* -------------------------------------- Delivery: written by FFmpeg -------------------------------------- */
  {
    id: 'h264-crf', value: 'h264_crf', label: 'H.264 FFmpeg quality', group: 'Delivery', kind: 'video', ext: 'mp4', encoders: ['libx264'],
    args: () => ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: false, audio: AAC, wired: true,
    hint: 'H.264 by constant quality (CRF 18, medium preset): the file size follows the picture. No bitrate setting.',
  },
  {
    id: 'h264-intra', value: 'h264_intra', label: 'H.264 all-intra', group: 'Delivery', kind: 'video', ext: 'mp4', encoders: ['libx264'],
    args: () => ['-c:v', 'libx264', '-preset', 'medium', '-g', '1', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: false, audio: AAC, wired: true,
    hint: 'H.264 with every frame a key frame: loops and scrubs frame-exactly in VJ and editing software. Larger files.',
  },
  {
    id: 'hevc-crf', value: 'hevc_crf', label: 'H.265 FFmpeg quality', group: 'Delivery', kind: 'video', ext: 'mp4', encoders: ['libx265'],
    args: () => ['-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: false, audio: AAC, wired: true,
    hint: 'H.265 by constant quality (CRF 20, medium preset).',
  },
  {
    id: 'hevc-intra', value: 'hevc_intra', label: 'H.265 all-intra', group: 'Delivery', kind: 'video', ext: 'mp4', encoders: ['libx265'],
    args: () => ['-c:v', 'libx265', '-preset', 'medium', '-g', '1', '-crf', '16', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: false, audio: AAC, wired: true,
    hint: 'H.265 with every frame a key frame. Larger files.',
  },
  {
    id: 'av1-ffmpeg', value: 'av1_ffmpeg', label: 'AV1 FFmpeg quality', group: 'Delivery', kind: 'video', ext: 'mp4', encoders: ['libsvtav1', 'libaom-av1'],
    args: (o) =>
      !o.encoders || o.encoders.has('libsvtav1')
        ? ['-c:v', 'libsvtav1', '-crf', '32', '-preset', '8', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        : ['-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0', '-cpu-used', '6', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    alpha: false, even: true, bitrate: false, audio: AAC, wired: true,
    hint: 'AV1 by constant quality, with SVT-AV1 when your FFmpeg has it, else libaom. Slow to encode.',
  },
  {
    id: 'webm-alpha', value: 'webm-alpha', label: 'WebM VP9 with alpha', group: 'Delivery', kind: 'video', ext: 'webm', encoders: ['libvpx-vp9'],
    args: (o) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : [])],
    alpha: true, even: true, bitrate: true, audio: OPUS, wired: true, aliases: ['webmalpha', 'vp9-alpha'],
    hint: 'VP9 with transparency: needs a player that reads WebM alpha, such as a browser.',
  },

  /* -------------------------------------- Animated pictures -------------------------------------- */
  {
    id: 'gif', value: 'gif', label: 'Animated GIF', group: 'Animated picture', kind: 'animated', ext: 'gif', encoders: ['gif'], route: 'own', own: 'gif',
    args: (o) => [
      '-vf',
      `split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=${o.dither ?? 'bayer'}${(o.dither ?? 'bayer') === 'bayer' ? ':bayer_scale=3' : ''}:alpha_threshold=128`,
      '-loop', '0', '-f', 'gif',
    ],
    alpha: true, even: false, bitrate: false, audio: null, wired: true,
    hint: 'Written by the app itself: a palette per frame (or one shared) of up to 256 colors, exact for pixel art, one transparent level. No sound. Files get large for photographic content.',
  },
  {
    id: 'apng', value: 'apng', label: 'Animated PNG', group: 'Animated picture', kind: 'animated', ext: 'png', encoders: ['apng'], route: 'own', own: 'apng',
    args: () => ['-c:v', 'apng', '-plays', '0', '-pix_fmt', 'rgba', '-f', 'apng'],
    alpha: true, even: false, bitrate: false, audio: null, wired: true,
    hint: 'Full color and smooth transparency, loops forever, lossless. Written by the app itself. No sound.',
  },
  {
    id: 'webp-anim', value: 'webp_anim', label: 'Animated WebP', group: 'Animated picture', kind: 'animated', ext: 'webp', encoders: ['libwebp_anim'],
    args: () => ['-c:v', 'libwebp_anim', '-loop', '0', '-lossless', '0', '-quality', '80', '-pix_fmt', 'yuva420p', '-f', 'webp'],
    alpha: true, even: false, bitrate: false, audio: null, wired: true,
    hint: 'Small files with transparency, loops forever. No sound.',
  },
  {
    id: 'avif-anim', value: 'avif_anim', label: 'Animated AVIF', group: 'Animated picture', kind: 'animated', ext: 'avif', encoders: ['libsvtav1', 'libaom-av1'],
    args: (o) =>
      !o.encoders || o.encoders.has('libsvtav1')
        ? ['-c:v', 'libsvtav1', '-crf', '32', '-preset', '8', '-pix_fmt', 'yuv420p', '-f', 'avif']
        : ['-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0', '-cpu-used', '6', '-pix_fmt', 'yuv420p', '-f', 'avif'],
    alpha: false, even: true, bitrate: false, audio: null, wired: true,
    hint: 'Small files, loops forever; needs a player or browser that reads animated AVIF. No transparency, no sound.',
  },

  /* -------------------------------------- Legacy -------------------------------------- */
  {
    id: 'vp8', value: 'vp8', label: 'VP8 WebM', group: 'Legacy', kind: 'video', ext: 'webm', encoders: ['libvpx'],
    args: (o) => ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-auto-alt-ref', '0', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : [])],
    alpha: false, even: true, bitrate: true, audio: OPUS, wired: true, hint: 'Older open format.',
  },
  {
    id: 'mpeg2', value: 'mpeg2', label: 'MPEG-2 MPG', group: 'Legacy', kind: 'video', ext: 'mpg', encoders: ['mpeg2video'],
    args: (o) => ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-b:v', mbps(o.bitrateMbps), ...(o.allKeys ? ['-g', '1'] : [])],
    alpha: false, even: true, bitrate: true, audio: MP2, wired: true, hint: 'Legacy format for old players and DVD tools.',
  },
  {
    id: 'mpeg4', value: 'mpeg4', label: 'MPEG-4 AVI', group: 'Legacy', kind: 'video', ext: 'avi', encoders: ['mpeg4'],
    args: () => ['-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p'],
    alpha: false, even: true, bitrate: false, audio: MP3, wired: true, hint: 'Legacy MPEG-4 part 2 in an AVI.',
  },

  /* -------------------------------------- Still images and image sequences (the Output node's Image format) -------------------------------------- */
  still('png-image', 'PNG', 'png', '', true, 'Web', 'Lossless, with transparency. Works everywhere.', { value: 'png', route: 'builtin-webcodecs', builtin: true, own: undefined }),
  still('webp', 'WebP', 'webp', '', true, 'Web', 'Small files with transparency; the Quality setting applies.', { route: 'builtin-webcodecs', builtin: true, own: undefined }),
  still('jpeg', 'JPEG', 'jpg', '', false, 'Web', 'Small files, no transparency (the picture is placed over black); the Quality setting applies.', { route: 'builtin-webcodecs', builtin: true, own: undefined, aliases: ['jpg'] }),
  still('avif', 'AVIF', 'avif', '', true, 'Web', 'Very small files with transparency. Offered only where the browser can encode it; the Quality setting applies.', { route: 'builtin-webcodecs', builtin: true, own: undefined }),
  still('qoi', 'QOI', 'qoi', 'qoi', true, 'Lossless', 'Lossless and very fast to write, with transparency. Few programs read it yet. Written by the app itself.'),
  still('tiff', 'TIFF', 'tif', 'tiff', true, 'Lossless', 'TIFF, 8-bit with transparency, deflate compression. Written by the app itself.', { ffmpeg: { encoder: 'tiff', args: ['-c:v', 'tiff', '-compression_algo', 'deflate', '-pix_fmt', 'rgba'] }, aliases: ['tif'] }),
  still('tga', 'TGA', 'tga', 'tga', true, 'Lossless', 'Targa with transparency, run-length compressed. Written by the app itself.', { ffmpeg: { encoder: 'targa', args: ['-c:v', 'targa', '-pix_fmt', 'bgra'] } }),
  still('bmp', 'BMP', 'bmp', 'bmp', false, 'Lossless', 'Windows bitmap, 24-bit, no transparency (the picture is placed over black). Written by the app itself.', { ffmpeg: { encoder: 'bmp', args: ['-c:v', 'bmp', '-pix_fmt', 'bgr24'] } }),
  still('exr', 'OpenEXR', 'exr', 'exr', true, 'High dynamic range', 'Half-float colors above 1.0 are kept, with transparency; zip compressed. Written linear (the sRGB curve removed), as compositing programs expect. Only graphs that produce high-range values gain anything over 8-bit. Written by the app itself.', { float: true }),
  still('hdr', 'Radiance HDR', 'hdr', 'hdr', false, 'High dynamic range', 'RGBE colors above 1.0 are kept, no transparency. Written linear (the sRGB curve removed). Only graphs that produce high-range values gain anything over 8-bit. Written by the app itself.', { float: true }),
  still('tiff16', 'TIFF 16-bit', 'tif', 'tiff16', true, 'High dynamic range', '16-bit TIFF with transparency, deflate compression. The values are the picture as shown (display encoded, clipped to 0..1). Written by the app itself.', { float: true, ffmpeg: { encoder: 'tiff', args: ['-c:v', 'tiff', '-compression_algo', 'deflate', '-pix_fmt', 'rgba64le'] } }),
  seq('dpx', 'DPX', 'dpx', 'dpx', ['-c:v', 'dpx', '-pix_fmt', 'gbrp10le'], false, 'High dynamic range', 'DPX 10-bit, no transparency.'),
  still('ico', 'ICO icon', 'ico', 'ico', true, 'Other', 'Windows icon holding the picture at 16 to 256 pixels (pixel art is enlarged with hard pixels). Written by the app itself.'),
  still('ppm', 'PPM', 'ppm', 'ppm', false, 'Other', 'Plain portable pixmap, no transparency (placed over black). Readable by nearly every tool. Written by the app itself.'),
  seq('jp2', 'JPEG 2000', 'jp2', 'jpeg2000', ['-c:v', 'jpeg2000', '-pix_fmt', 'rgba'], true, 'Other', 'JPEG 2000 with transparency.'),

  /* -------------------------------------- Audio only (the Audio Output's Sound file) -------------------------------------- */
  aud('wav32f', 'WAV 32-bit float', 'wav', 'pcm_f32le', ['-c:a', 'pcm_f32le'], { route: 'own', own: 'wav', hint: 'Uncompressed, exact. Written by the app itself.', aliases: ['wav32'] }),
  aud('wav24', 'WAV 24-bit', 'wav', 'pcm_s24le', ['-c:a', 'pcm_s24le'], { route: 'own', own: 'wav', hint: 'Uncompressed studio quality. Written by the app itself.' }),
  aud('wav', 'WAV 16-bit', 'wav', 'pcm_s16le', ['-c:a', 'pcm_s16le'], { route: 'own', own: 'wav', hint: 'Uncompressed CD quality. Written by the app itself.', aliases: ['wav16'] }),
  aud('aiff24', 'AIFF 24-bit', 'aiff', 'pcm_s24be', ['-c:a', 'pcm_s24be'], { route: 'own', own: 'aiff', hint: 'Uncompressed, for Apple and studio software. Written by the app itself.' }),
  aud('aiff', 'AIFF 16-bit', 'aiff', 'pcm_s16be', ['-c:a', 'pcm_s16be'], { route: 'own', own: 'aiff', hint: 'Uncompressed, for Apple and studio software. Written by the app itself.', aliases: ['aif'] }),
  aud('flac24', 'FLAC 24-bit', 'flac', 'flac', ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], { route: 'own', own: 'flac', hint: 'Lossless and about half the size of WAV. Written by the app itself.' }),
  aud('flac', 'FLAC 16-bit', 'flac', 'flac', ['-c:a', 'flac'], { route: 'own', own: 'flac', hint: 'Lossless and about half the size of WAV. Written by the app itself.' }),
  aud('aac', 'AAC M4A', 'm4a', 'aac', ['-c:a', 'aac', '-b:a', '192k'], { route: 'builtin-webcodecs', builtin: true, hint: 'Small files that play everywhere. Written by the browser where it can encode AAC, else by FFmpeg.' }),
  aud('webm-opus', 'Opus WebM', 'webm', 'libopus', ['-c:a', 'libopus', '-b:a', '160k'], { route: 'builtin-webcodecs', builtin: true, hint: 'Small, high quality sound in a WebM file. Written by the browser where it can encode Opus, else by FFmpeg.', aliases: ['webm'] }),
  aud('mp3', 'MP3', 'mp3', 'libmp3lame', ['-c:a', 'libmp3lame', '-b:a', '192k']),
  aud('opus', 'Opus OGG', 'opus', 'libopus', ['-c:a', 'libopus', '-b:a', '160k']),
  aud('vorbis', 'Vorbis OGG', 'ogg', 'libvorbis', ['-c:a', 'libvorbis', '-q:a', '5']),
  aud('alac', 'ALAC M4A', 'm4a', 'alac', ['-c:a', 'alac']),
];

/** THE table: every output format with its route. */
export const CODEC_TABLE: readonly CodecRow[] = ROWS.map((r) => ({ ...r, route: r.route ?? (r.builtin ? 'builtin-webcodecs' : 'ffmpeg') }));

/* ---------------------------------------------------- lookups ---------------------------------------------------- */

const byValue = new Map(CODEC_TABLE.map((r) => [r.value, r]));
const byId = new Map(CODEC_TABLE.map((r) => [r.id, r]));

export function rowByValue(value: string): CodecRow | null {
  return byValue.get(value) ?? null;
}

/** A row by its CLI / endpoint id, its node value or any alias (case-insensitive; `_` and `-` are the same). */
export function rowById(name: string): CodecRow | null {
  const n = name.toLowerCase();
  const direct = byId.get(n) ?? byId.get(n.replace(/_/g, '-')) ?? byValue.get(n);
  if (direct) return direct;
  return CODEC_TABLE.find((r) => r.aliases?.includes(n)) ?? null;
}

/** Plain message when a picture is smaller than the codec accepts, else ''. */
export function minSizeMessage(label: string, minSize: readonly [number, number] | undefined, width: number, height: number): string {
  return minSize && (width < minSize[0] || height < minSize[1]) ? `${label} needs a picture of at least ${minSize[0]}x${minSize[1]} (this one is ${width}x${height}). Make the canvas bigger or use Pixel upscale.` : '';
}

/** Every encoder any row needs (what the probe reports on). */
export const ALL_ENCODERS: readonly string[] = [...new Set(CODEC_TABLE.flatMap((r) => r.encoders))].sort();

/** Rows offered in the app, in menu order. */
export const WIRED_ROWS: readonly CodecRow[] = CODEC_TABLE.filter((r) => r.wired);
/** The Output node's Video codec list (video and animated rows). */
export const VIDEO_ROWS: readonly CodecRow[] = WIRED_ROWS.filter((r) => r.kind === 'video' || r.kind === 'animated');
/** The Output node's Image format list (stills and image sequences). */
export const STILL_ROWS: readonly CodecRow[] = WIRED_ROWS.filter((r) => r.kind === 'still');
/** The Audio Output's Sound file list. */
export const AUDIO_ROWS: readonly CodecRow[] = WIRED_ROWS.filter((r) => r.kind === 'audio');

/** A still row by the Output node's `imageFormat` value, a CLI name or an extension alias. */
export function stillRow(name: string): CodecRow | null {
  const n = name.toLowerCase();
  return STILL_ROWS.find((r) => r.value === n || r.id === n || r.ext === n || r.aliases?.includes(n)) ?? null;
}

/** An audio row by its id, value or alias. */
export function audioRow(name: string): CodecRow | null {
  const n = name.toLowerCase();
  return AUDIO_ROWS.find((r) => r.value === n || r.id === n || r.aliases?.includes(n)) ?? null;
}

/** Row counts by route and by family, for the `formats` listing and the docs. */
export function registryCounts(rows: readonly CodecRow[] = WIRED_ROWS): { byRoute: Record<FormatRoute, number>; byKind: Record<CodecKind, number> } {
  const byRoute: Record<FormatRoute, number> = { 'builtin-webcodecs': 0, own: 0, ffmpeg: 0 };
  const byKind: Record<CodecKind, number> = { video: 0, animated: 0, still: 0, audio: 0 };
  for (const r of rows) {
    byRoute[r.route]++;
    byKind[r.kind]++;
  }
  return { byRoute, byKind };
}

/* ---------------------------------------------------- the FFmpeg command ---------------------------------------------------- */

export interface BuildOptions {
  width: number;
  height: number;
  fps: number;
  /** Output file (for a sequence a pattern such as frame_%04d.tiff). */
  out: string;
  bitrateMbps?: number;
  allKeys?: boolean;
  /** Raw f32le PCM file to mux (video rows) or to convert (audio rows). */
  audio?: { file: string; sampleRate: number; channels: number } | null;
  /** 'pipe': raw RGBA frames on stdin (the app). A file, pattern or lavfi source is for the check script. */
  input?: 'pipe' | { pattern: string; format?: string };
  /** Stop after this many frames. */
  frames?: number;
  encoders?: ReadonlySet<string> | null;
  dither?: ArgOpts['dither'];
}

/** The full ffmpeg argument list for a row. Used by the app, the CLI and scripts/check-ffmpeg-codecs.mjs. */
export function ffmpegArgsFor(id: string, o: BuildOptions): string[] {
  const row = rowById(id);
  if (!row) throw new Error(`Unknown codec "${id}".`);
  const ao: ArgOpts = { bitrateMbps: o.bitrateMbps ?? 12, allKeys: o.allKeys === true, encoders: o.encoders ?? null, dither: o.dither };
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  const audioIn = (a: NonNullable<BuildOptions['audio']>) => ['-f', 'f32le', '-ar', String(a.sampleRate), '-ac', String(a.channels), '-i', a.file];
  if (row.kind === 'audio') {
    if (!o.audio) throw new Error(`${row.label} needs audio.`);
    return [...head, ...audioIn(o.audio), '-vn', ...row.args(ao), o.out];
  }
  const input = o.input ?? 'pipe';
  const videoIn = input === 'pipe' ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0'] : [...(input.format ? ['-f', input.format] : []), '-i', input.pattern];
  const withAudio = !!o.audio && row.audio !== null && row.kind === 'video';
  const args = [...head, ...videoIn];
  if (withAudio) args.push(...audioIn(o.audio!));
  args.push('-map', '0:v');
  if (withAudio) args.push('-map', '1:a');
  args.push('-r', String(o.fps), ...row.args(ao));
  if (o.frames) args.push('-frames:v', String(o.frames));
  if (withAudio) args.push(...row.audio!, '-shortest');
  args.push(o.out);
  return args;
}

/* ---------------------------------------------------- what the Output node and the exporter use ---------------------------------------------------- */

export interface FfmpegCodec {
  /** Id the desktop export endpoint takes. */
  id: string;
  /** Name shown to the user in messages. */
  label: string;
  /** Needs an even width and height (the frame is padded with transparent texels). */
  even: boolean;
  /** Keeps transparency: frames are sent straight alpha. Others get the picture composited over black. */
  alpha: boolean;
  ext: string;
  /** Encoder(s) named in messages ("libsvtav1 or libaom-av1"). */
  encoder: string;
  /** Any one of these is enough. */
  encoders: readonly string[];
  /** Takes the Bitrate / All key frames settings. */
  bitrate: boolean;
  minSize?: readonly [number, number];
}

export const asCodec = (r: CodecRow): FfmpegCodec => ({ id: r.id, label: r.label, even: r.even, alpha: r.alpha, ext: r.ext, encoder: r.encoders.join(' or '), encoders: r.encoders, bitrate: r.bitrate, minSize: r.minSize });

/** The codec when it is an FFmpeg-only format (shows a "needs FFmpeg" tag), else null. */
export function ffmpegOnlyCodec(value: string): FfmpegCodec | null {
  const r = rowByValue(value);
  return r && r.wired && r.route === 'ffmpeg' ? asCodec(r) : null;
}

/** H.264 / H.265 through FFmpeg, used only when WebCodecs cannot encode them. */
export function ffmpegFallbackCodec(value: string): FfmpegCodec | null {
  const r = rowByValue(value);
  return r?.fallback ? asCodec(r) : null;
}

export function needsFfmpeg(value: string): boolean {
  return ffmpegOnlyCodec(value) !== null;
}

/** Output `codec` values that need FFmpeg, in menu order. */
export const FFMPEG_CODEC_VALUES: readonly string[] = VIDEO_ROWS.filter((r) => r.route === 'ffmpeg').map((r) => r.value);

/** Plain words for the case "an FFmpeg format is chosen but FFmpeg cannot be used". */
export function ffmpegMissingMessage(desktop: boolean): string {
  return desktop
    ? 'This video format needs FFmpeg, which is not set up yet. Open Plugins, then Official add-ons, and install FFmpeg (or choose one you already have).'
    : 'This video format needs the desktop app, or the free command-line tool (see docs/CLI.md). It is not available in the web version.';
}

export type VideoRoute = 'webcodecs' | 'own' | 'ffmpeg' | 'missing';

/**
 * Where a video Output goes: a format with an encoder of this app is written by the app (no FFmpeg needed, even when one exists); FFmpeg-only
 * formats need FFmpeg (or are reported missing); everything else stays on WebCodecs.
 */
export function videoRoute(codec: string, ffmpegAvailable: boolean): VideoRoute {
  const r = rowByValue(codec);
  if (r?.route === 'own') return 'own';
  if (!needsFfmpeg(codec)) return 'webcodecs';
  return ffmpegAvailable ? 'ffmpeg' : 'missing';
}

/** True when none of the codec's encoders is in the installed FFmpeg. `encoders` null = not known: nothing is claimed. */
export function encoderMissing(codec: { encoders: readonly string[] }, encoders: ReadonlySet<string> | readonly string[] | null | undefined): boolean {
  if (!encoders) return false;
  const has = (e: string) => (Array.isArray(encoders) ? (encoders as readonly string[]).includes(e) : (encoders as ReadonlySet<string>).has(e));
  return !codec.encoders.some(has);
}
