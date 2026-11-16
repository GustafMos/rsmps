/**
 * `rsmps print-blank`: blank animation sheets (frame boxes, scan markers, numbers, guides; no picture) as PDF / PNG files,
 * from the same code as the app's "Print blank sheets" dialog. See docs/CLI.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { numberOpt, one, parseArgs, type OptionSpec } from './args';
import { beatFrames, detectBeats } from '../io/print/beats';
import { exportBlankSheets, planBlankSheets, type BlankSheetOptions } from '../io/print/blank';
import { FRAME_GUIDES, type FrameGuide } from '../io/print/layout';
import { PAPER_CODES, type PaperId } from '../io/print/format';

export const PRINT_BLANK_HELP = `rsmps print-blank - blank sheets for animation drawn on paper

Usage
  rsmps print-blank --out <dir> (--frames <n> | --seconds <s>) [options]

Frames
  --frames <n>              number of frames, or
  --seconds <s>             seconds (with --fps, default 12)
  --fps <n>                 frame rate (default 12)
  --aspect <a>              project | 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 4:5 | 2:3 | 21:9 | W:H (default 16:9)
  --size WxH                the project canvas when --aspect is "project"
  --per-sheet <n>           frames per sheet (the largest frames that fit), or
  --columns <c> --rows <r>  exact grid

Paper
  --paper <a4|a3|letter|a5|legal>   (default a4)
  --landscape | --portrait          (default portrait)
  --margin <mm>  --gutter <mm>  --dpi <n>

Marks (all optional)
  --guides <list>           inside every frame: ${FRAME_GUIDES.join(', ')} (comma separated)
  --ghost                   faint big frame numbers inside the boxes
  --no-numbers  --no-boxes  leave out frame numbers / frame boxes
  --shoot-on <n>            shoot on ones / twos / threes (prints hold counts and time code)
  --beats <f,f,...>         beat marks on these timeline frames (1-based)
  --beats-from <file.wav>   find beats in a PCM or float WAV with the onset detector
  --exposure-sheet          add an exposure sheet page

Output
  --format <pdf|png|both>   (default pdf)
  --name <text>             title and file name (default blank-sheets)
  --out, -o <dir>           output folder (default ./out)
`;

const SPEC: Record<string, OptionSpec> = {
  out: { value: true, alias: 'o' },
  frames: { value: true },
  seconds: { value: true },
  fps: { value: true },
  aspect: { value: true },
  size: { value: true },
  'per-sheet': { value: true },
  columns: { value: true },
  rows: { value: true },
  paper: { value: true },
  landscape: {},
  portrait: {},
  margin: { value: true },
  gutter: { value: true },
  dpi: { value: true },
  guides: { value: true },
  ghost: {},
  'no-numbers': {},
  'no-boxes': {},
  'shoot-on': { value: true },
  beats: { value: true },
  'beats-from': { value: true },
  'exposure-sheet': {},
  format: { value: true },
  name: { value: true },
  quiet: { alias: 'q' },
  help: { alias: 'h' },
};

/** Minimal RIFF/WAVE reader: PCM 8/16/24/32 bit and 32-bit float. Returns channels as floats. */
export function readWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file (--beats-from needs PCM or float WAV).');
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data' && fmt) {
      const bps = fmt.bits / 8;
      const n = Math.floor(Math.min(size, bytes.length - body) / (bps * fmt.channels));
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (i * fmt.channels + c) * bps;
          let v: number;
          if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
          else if (fmt.bits === 8) v = (bytes[o] - 128) / 128;
          else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
          else if (fmt.bits === 24) v = (((bytes[o + 2] << 24) | (bytes[o + 1] << 16) | (bytes[o] << 8)) >> 8) / 8388608;
          else if (fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
          else throw new Error(`Unsupported WAV sample size (${fmt.bits} bit).`);
          chans[c][i] = v;
        }
      return { sampleRate: fmt.rate, channels: chans };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('The WAV file has no readable audio data.');
}

export async function cmdPrintBlank(argv: string[]): Promise<number> {
  const p = parseArgs(argv, SPEC);
  if (p.flags.has('help') || argv.length === 0) {
    console.log(PRINT_BLANK_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const fps = numberOpt(p, 'fps', 1) ?? 12;
  const frames = numberOpt(p, 'frames', 1);
  const seconds = numberOpt(p, 'seconds', 0.01);
  if (!frames && !seconds) throw new Error('Give --frames <n> or --seconds <s>.');
  const paper = (one(p, 'paper') ?? 'a4').toLowerCase();
  if (!PAPER_CODES.includes(paper as PaperId)) throw new Error(`Unknown --paper "${paper}" (${PAPER_CODES.join(', ')}).`);
  const guides = (one(p, 'guides') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const g of guides) if (!FRAME_GUIDES.includes(g as FrameGuide)) throw new Error(`Unknown guide "${g}" (${FRAME_GUIDES.join(', ')}).`);
  const format = (one(p, 'format') ?? 'pdf').toLowerCase();
  if (!['pdf', 'png', 'both'].includes(format)) throw new Error('--format must be pdf, png or both.');
  const size = one(p, 'size')?.match(/^(\d+)x(\d+)$/i);
  let beats: number[] | undefined;
  const beatList = one(p, 'beats');
  if (beatList) beats = beatList.split(',').map((s) => Number(s.trim()) - 1).filter((n) => Number.isFinite(n) && n >= 0);
  const wav = one(p, 'beats-from');
  if (wav) {
    const audio = readWav(new Uint8Array(readFileSync(resolve(wav))));
    beats = beatFrames(detectBeats(audio.channels, audio.sampleRate), fps);
  }
  const opts: BlankSheetOptions = {
    frames,
    seconds,
    fps,
    aspect: one(p, 'aspect') ?? '16:9',
    project: size ? { width: +size[1], height: +size[2] } : undefined,
    perSheet: numberOpt(p, 'per-sheet', 1),
    columns: numberOpt(p, 'columns', 1),
    rows: numberOpt(p, 'rows', 1),
    paper: paper as PaperId,
    orientation: p.flags.has('landscape') ? 'landscape' : 'portrait',
    marginMm: numberOpt(p, 'margin', 0),
    gutterMm: numberOpt(p, 'gutter', 0),
    dpi: numberOpt(p, 'dpi', 72),
    guides: guides as FrameGuide[],
    ghostNumbers: p.flags.has('ghost'),
    numbers: !p.flags.has('no-numbers'),
    boxes: !p.flags.has('no-boxes'),
    shootOn: numberOpt(p, 'shoot-on', 1),
    beats,
    exposureSheet: p.flags.has('exposure-sheet'),
    output: format as 'pdf' | 'png' | 'both',
    name: one(p, 'name') ?? 'blank-sheets',
  };
  const plan = planBlankSheets(opts);
  const files = await exportBlankSheets(opts);
  const out = resolve(one(p, 'out') ?? 'out');
  mkdirSync(out, { recursive: true });
  for (const f of files) writeFileSync(join(out, f.name), Buffer.from(await f.blob.arrayBuffer()));
  if (!p.flags.has('quiet')) {
    console.log(`${plan.frames} frame(s), ${plan.columns} x ${plan.rows} per sheet, ${plan.pages} sheet(s) -> ${out}`);
    for (const f of files) console.log(`  ${f.name}`);
  }
  return 0;
}
