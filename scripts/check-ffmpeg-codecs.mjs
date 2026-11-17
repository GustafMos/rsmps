// Walks the codec table (src/io/export-codecs.ts) and, for every row whose encoder is in the given FFmpeg, encodes a tiny generated test
// clip with the app's own argument list, then re-reads the file with `ffmpeg -v error -i out -f null -`. Rows that claim alpha are also
// checked for an alpha channel (the file is decoded to rgba and the alpha plane must not be all 255). Prints a pass/fail table.
//
//   node scripts/check-ffmpeg-codecs.mjs <path-to-ffmpeg> [--only id,id] [--keep <dir>] [--size 64x48]
//
// No ffprobe is used. Nothing is downloaded. Exit status 1 when any row fails.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const ffmpeg = argv.find((a) => !a.startsWith('--') && a !== flag('--only') && a !== flag('--keep') && a !== flag('--size'));
if (!ffmpeg) {
  console.error('usage: node scripts/check-ffmpeg-codecs.mjs <path-to-ffmpeg> [--only id,id] [--keep <dir>] [--size WxH]');
  process.exit(2);
}
const only = flag('--only')?.split(',');
const [W, H] = (flag('--size') ?? '64x48').split('x').map(Number);
const SIZE_W = W;
const SIZE_H = H;
const FPS = 12;
const FRAMES = 12; // one second

const bundled = await build({ entryPoints: [join(root, 'src', 'io', 'export-codecs.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
const table = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const { CODEC_TABLE, ffmpegArgsFor } = table;

const run = (args, opts = {}) => spawnSync(ffmpeg, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });
const text = (b) => (b ? b.toString('utf8') : '');

const v = run(['-hide_banner', '-version']);
if (v.status !== 0) {
  console.error(`Cannot run ${ffmpeg}`);
  process.exit(2);
}
console.log(text(v.stdout).split('\n')[0]);

const enc = new Set();
for (const line of text(run(['-hide_banner', '-encoders']).stdout).split('\n')) {
  const m = /^\s*([VAS][.A-Z]{5})\s+(\S+)\s/.exec(line + ' ');
  if (m && m[2] !== '=') enc.add(m[2]);
}

const dir = flag('--keep') ? resolve(flag('--keep')) : mkdtempSync(join(tmpdir(), 'rsmps-codec-check-'));
mkdirSync(dir, { recursive: true });

// Raw RGBA test frames: a moving gradient; the left third is fully transparent and the middle third half transparent, so alpha is visible.
function frames(W = SIZE_W, H = SIZE_H) {
  const buf = Buffer.alloc(W * H * 4 * FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = ((f * H + y) * W + x) * 4;
        buf[o] = ((x + f * 3) * 255) / W;
        buf[o + 1] = (y * 255) / H;
        buf[o + 2] = 128 + 100 * Math.sin((x + y + f * 4) / 9);
        buf[o + 3] = x < W / 3 ? 0 : x < (2 * W) / 3 ? 128 : 255;
      }
    }
  }
  return buf;
}
const video = frames();
// f32le stereo sine, one second
const SR = 48000;
const pcm = Buffer.alloc(SR * 2 * 4);
for (let i = 0; i < SR; i++) {
  const s = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  pcm.writeFloatLE(s, i * 8);
  pcm.writeFloatLE(s, i * 8 + 4);
}
const pcmFile = join(dir, 'tone.f32');
writeFileSync(pcmFile, pcm);

const results = [];
for (const row of CODEC_TABLE) {
  if (only && !only.includes(row.id)) continue;
  const present = row.encoders.filter((e) => enc.has(e));
  if (!present.length) {
    results.push({ id: row.id, kind: row.kind, status: 'SKIP', note: `no ${row.encoders.join(' / ')} in this FFmpeg` });
    continue;
  }
  const w = Math.max(row.minSize?.[0] ?? 0, row.even ? W + (W % 2) : W);
  const h = Math.max(row.minSize?.[1] ?? 0, H);
  const base = join(dir, row.id);
  const out = row.kind === 'sequence' ? `${base}_%03d.${row.ext}` : `${base}.${row.ext}`;
  const args = ffmpegArgsFor(row.id, {
    width: w, height: h, fps: FPS, out, bitrateMbps: 4, allKeys: false, encoders: enc,
    audio: row.kind === 'audio' || (row.audio && row.kind === 'video') ? { file: pcmFile, sampleRate: SR, channels: 2 } : null,
  });
  // Rows that carry no alpha get the picture over black, like the app does.
  let input = w === W && h === H ? video : frames(w, h);
  if (!row.alpha) {
    input = Buffer.from(input);
    for (let i = 0; i < input.length; i += 4) {
      const a = input[i + 3] / 255;
      input[i] *= a;
      input[i + 1] *= a;
      input[i + 2] *= a;
      input[i + 3] = 255;
    }
  }
  const r = row.kind === 'audio' ? run(args) : run(args, { input });
  if (r.status !== 0) {
    results.push({ id: row.id, kind: row.kind, status: 'FAIL', note: `encode: ${text(r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`, args: args.join(' ') });
    continue;
  }
  const first = row.kind === 'sequence' ? `${base}_001.${row.ext}` : out;
  if (!existsSync(first) || statSync(first).size === 0) {
    results.push({ id: row.id, kind: row.kind, status: 'FAIL', note: 'no output file' });
    continue;
  }
  const re = run(['-v', 'error', '-i', first, '-f', 'null', '-']);
  const err = text(re.stderr).trim();
  if (re.status !== 0 || err) {
    results.push({ id: row.id, kind: row.kind, status: 'FAIL', note: `re-read: ${err.split('\n').slice(-2).join(' | ').slice(0, 160)}`, args: args.join(' ') });
    continue;
  }
  let note = `${(statSync(first).size / 1024).toFixed(0)} KB`;
  if (row.audio && row.kind === 'video') {
    const a = text(run(['-hide_banner', '-i', first]).stderr);
    if (!/Audio:/.test(a)) {
      results.push({ id: row.id, kind: row.kind, status: 'FAIL', note: 'audio track missing', args: args.join(' ') });
      continue;
    }
    note += ' +audio';
  }
  if (row.alpha && row.kind !== 'audio') {
    const d = run([...(row.id === 'webm-alpha' ? ['-c:v', 'libvpx-vp9'] : []), '-v', 'error', '-i', first, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const px = d.stdout;
    const W = w, H = h;
    let min = 255;
    for (let i = 3; i < px.length; i += 4) min = Math.min(min, px[i]);
    if (!(px.length >= W * H * 4) || min === 255) {
      results.push({ id: row.id, kind: row.kind, status: 'FAIL', note: 'claims alpha but every pixel is opaque after decoding', args: args.join(' ') });
      continue;
    }
    note += ' alpha ok';
  }
  results.push({ id: row.id, kind: row.kind, status: 'PASS', note });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`${pad('id', 16)}${pad('kind', 10)}${pad('result', 7)}note`);
for (const r of results) console.log(`${pad(r.id, 16)}${pad(r.kind, 10)}${pad(r.status, 7)}${r.note}`);
const failed = results.filter((r) => r.status === 'FAIL');
for (const f of failed) console.log(`\n${f.id}: ${f.args ?? ''}`);
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped (encoder not in this FFmpeg).`);
if (!flag('--keep')) rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
