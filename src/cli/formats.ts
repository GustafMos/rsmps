/** `rsmps formats`: the format registry (src/io/export-codecs.ts) with the route each format takes in THIS CLI and whether it works on this machine. */
import sharp from 'sharp';
import { WIRED_ROWS, registryCounts, type CodecKind, type CodecRow, type FormatRoute } from '../io/export-codecs';
import { availableEncoders } from './encode';
import { findFfmpeg } from './ffmpeg';

export interface FormatListing {
  id: string;
  label: string;
  kind: CodecKind;
  group: string;
  ext: string;
  /** Route in the format registry (the app: browser, desktop). */
  route: FormatRoute;
  /** What writes it in this CLI. */
  via: 'own' | 'sharp' | 'ffmpeg';
  available: boolean;
  note: string;
}

let avifOk: Promise<boolean> | null = null;
function sharpAvif(): Promise<boolean> {
  avifOk ??= sharp(Buffer.alloc(4 * 4 * 4, 128), { raw: { width: 4, height: 4, channels: 4 } })
    .avif({ quality: 50 })
    .toBuffer()
    .then(() => true, () => false);
  return avifOk;
}

export async function listFormats(): Promise<{ formats: FormatListing[]; ffmpeg: string | null }> {
  const bin = await findFfmpeg();
  const have = bin ? await availableEncoders() : new Set<string>();
  const rows: FormatListing[] = [];
  for (const r of WIRED_ROWS) {
    let via: FormatListing['via'];
    let available = true;
    let note = '';
    if (r.route === 'own') via = 'own';
    else if (r.route === 'builtin-webcodecs' && r.kind === 'still') {
      via = 'sharp';
      if (r.value === 'avif') {
        available = await sharpAvif();
        if (!available) note = 'this sharp build cannot write AVIF';
      }
    } else via = 'ffmpeg';
    if (via === 'ffmpeg') {
      if (!bin) {
        available = false;
        note = 'needs FFmpeg (not found: install it, put it on PATH or set FFMPEG_PATH)';
      } else if (have.size > 0 && !r.encoders.some((e) => have.has(e))) {
        available = false;
        note = `needs the ${r.encoders.join(' or ')} encoder, which this FFmpeg lacks`;
      }
    }
    rows.push({ id: r.id, label: r.label, kind: r.kind, group: r.group, ext: r.ext, route: r.route, via, available, note });
  }
  return { formats: rows, ffmpeg: bin };
}

export function formatText(list: FormatListing[], ffmpeg: string | null, rows: readonly CodecRow[] = WIRED_ROWS): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  const out: string[] = [];
  out.push(`FFmpeg: ${ffmpeg ?? 'not found'}`);
  for (const kind of ['video', 'animated', 'still', 'audio'] as const) {
    const part = list.filter((f) => f.kind === kind);
    if (!part.length) continue;
    out.push('', { video: 'Video (--codec, or --format)', animated: 'Animated pictures (--codec, or --format)', still: 'Pictures and image sequences (--format)', audio: 'Sound only (--format)' }[kind]);
    out.push(`  ${pad('id', 16)}${pad('label', 26)}${pad('ext', 6)}${pad('route', 18)}${pad('here', 8)}`);
    for (const f of part) out.push(`  ${pad(f.id, 16)}${pad(f.label, 26)}${pad(f.ext, 6)}${pad(f.route, 18)}${pad(f.available ? `yes (${f.via})` : 'no', 8)}${f.note ? ` ${f.note}` : ''}`);
  }
  const c = registryCounts(rows);
  out.push('', `${rows.length} formats: ${c.byRoute.own} written by the app itself, ${c.byRoute['builtin-webcodecs']} by the browser's encoders (sharp or FFmpeg in this CLI), ${c.byRoute.ffmpeg} by FFmpeg. ${list.filter((f) => f.available).length} work on this machine.`);
  return out.join('\n');
}
