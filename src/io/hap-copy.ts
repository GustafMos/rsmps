/**
 * "Fast copy" as HAP, in the desktop app only.
 *
 * The ordinary fast copy (fast-copy.ts) is H.264 with every frame a key frame: quick to seek, but every frame still goes
 * through a video decoder, and a computer runs only a few of those at once. A HAP frame needs no decoder at all: it is a
 * texture the graphics card reads as it is (hap-video.ts). That pays off when several clips play at the same time, when a
 * clip has transparency (H.264 has none) and on a desktop graphics card. The price is size: about 30 MB a second at 1080p,
 * twice that for HAP Q and HAP Alpha.
 *
 * No browser can encode HAP, so the desktop app's FFmpeg does it (desktop/addons/hap-convert.mjs): the clip is handed over
 * in pieces, converted, and read back in pieces.
 */
import type { FastCopyFormat } from './api';
import type { DesktopClient, HapKind } from './desktop';

/** The formats a fast copy can be made in, as offered in the Fast copy panel. */
export const FAST_COPY_FORMATS: readonly { value: FastCopyFormat; label: string }[] = [
  { value: 'h264', label: 'H.264' },
  { value: 'hap', label: 'HAP' },
  { value: 'hap_q', label: 'HAP Q, better colour' },
  { value: 'hap_alpha', label: 'HAP Alpha, transparency' },
];

/**
 * Which of them to offer here. HAP only in the desktop app, and only when its FFmpeg can write HAP; everywhere else just
 * H.264, and then the panel shows no choice at all (it looks as it did before HAP existed).
 */
export function fastCopyChoices(desktop: boolean, hapEncoder: boolean): readonly { value: FastCopyFormat; label: string }[] {
  return desktop && hapEncoder ? FAST_COPY_FORMATS : FAST_COPY_FORMATS.slice(0, 1);
}

/** Shown under the panel when HAP is on offer: when it is worth it, and what it costs. */
export const HAP_COPY_HINT =
  'HAP stores every frame the way the graphics card reads it, so it needs no video decoder. Choose it when several clips play at once, when a clip has transparency (HAP Alpha keeps it, H.264 cannot) or when you have a desktop graphics card. HAP Q has cleaner colours. The files are large: about 30 MB a second at 1080p for HAP, twice that for HAP Q and HAP Alpha.';

/** True for a clip that already is a fast copy: named like one, or a HAP clip (every HAP frame stands alone). */
export function isFastCopy(asset: { name: string; codec?: string }): boolean {
  return / fast\.(mp4|webm)$/i.test(asset.name) || /^HAP\b/.test(asset.codec ?? '');
}

/** Pieces the clip is uploaded and the result downloaded in. Small enough to cancel quickly, large enough to be few. */
const PIECE = 16 * 1024 * 1024;
const POLL_MS = 250;

export interface HapCopyOptions {
  format: HapKind;
  maxSide: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** For tests: the client to talk to and how to wait between progress checks. */
  client?: Pick<DesktopClient, 'hapStart' | 'hapChunk' | 'hapRun' | 'hapStatus' | 'hapRead' | 'hapCancel'>;
  wait?: (ms: number) => Promise<void>;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Convert a clip to HAP through the desktop app and return the new file ("clip fast.mov"). Progress covers the three
 * stages: handing the clip over (a tenth), encoding (most of it), reading the result back. Throws a readable error; an
 * AbortError when `signal` fires. The work folder in the desktop app is removed in every case.
 */
export async function makeHapCopy(blob: Blob, name: string, info: { width: number; height: number; fps: number; duration: number }, opts: HapCopyOptions): Promise<File> {
  const client = opts.client ?? new (await import('./desktop')).DesktopClient();
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = opts.signal;
  const stop = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const progress = (f: number) => opts.onProgress?.(Math.max(0, Math.min(1, f)));
  stop();
  if (!(info.width > 0 && info.height > 0)) throw new Error('The size of this clip is not known, so it cannot be converted.');
  const job = await client.hapStart({ format: opts.format, width: Math.round(info.width), height: Math.round(info.height), maxSide: opts.maxSide, duration: Math.max(0, info.duration || 0), fps: info.fps > 0 ? info.fps : 30, ext: extOf(name) }, signal);
  try {
    for (let at = 0; at < blob.size; at += PIECE) {
      stop();
      await client.hapChunk(job.id, await blob.slice(at, at + PIECE).arrayBuffer(), signal);
      progress((0.1 * Math.min(blob.size, at + PIECE)) / blob.size);
    }
    stop();
    let status = await client.hapRun(job.id, signal);
    while (status.state === 'running') {
      progress(0.1 + 0.75 * status.fraction);
      await wait(POLL_MS);
      stop();
      status = await client.hapStatus(job.id, signal);
    }
    if (status.state !== 'done') throw new Error(status.error ?? 'The conversion failed.');
    if (!(status.bytes > 0)) throw new Error('The HAP copy came out empty.');
    const parts: BlobPart[] = [];
    for (let at = 0; at < status.bytes; at += PIECE) {
      stop();
      const piece = await client.hapRead(job.id, at, Math.min(PIECE, status.bytes - at), signal);
      if (piece.length === 0) throw new Error('The converted clip could not be read.');
      parts.push(piece as BlobPart);
      progress(0.85 + (0.15 * Math.min(status.bytes, at + PIECE)) / status.bytes);
    }
    // named like every fast copy ("clip fast.mov"); loaded here so the panel, which imports this file, does not pull the H.264 encoder in early
    const { fastCopyName } = await import('./fast-copy');
    return new File(parts, fastCopyName(name, 'mov'), { type: 'video/quicktime' });
  } catch (err) {
    // a fetch cut off by the signal rejects with its own error: report every abort the same way
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  } finally {
    await client.hapCancel(job.id);
  }
}
