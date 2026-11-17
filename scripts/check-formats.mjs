// Real-export check of the format registry (src/io/export-codecs.ts): for EVERY row on EVERY route that is available on this machine, a tiny export
// goes through the real export code (the CLI, dist-cli/rsmps.mjs: run `npm run build:cli` first) and the file is validated with a full FFmpeg
// (used only to READ files): decodes cleanly, frame count, size, audio track, alpha (present when the row has it, absent otherwise) and the picture
// against the PNG export of the same frame. Prints a pass/fail table. Exit status 1 when any row fails.
//
//   node scripts/check-formats.mjs --ffmpeg <full ffmpeg to read files with> [--cli-ffmpeg <ffmpeg the CLI's FFmpeg routes use>]
//                                  [--only id,id] [--keep <dir>] [--hap] [--hap4k] [--skip-ffmpeg-rows]
//
//   --hap     also export a 2 s 1920x1080 clip as HAP / HAP Alpha / HAP Q (GPU path): frame count, size, alpha, PSNR vs the PNG sequence, ms per frame, file size
//   --hap4k   also a 3840x2160 HAP Alpha clip through the streaming sink, with the peak memory of the process
//   --browser <dir>   instead of exporting through the CLI, validate the files the APP exported in the browser (scripts/screenshots/format-scenes.mjs, f-exports,
//             saved to <preview dir>/formats/browser) with the same checks; --browser-only skips the CLI rows
//
// Nothing is downloaded; the graphs are generated here (test-assets/scene-1920x1080.png for the HAP clip).
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i < 0 ? undefined : argv[i + 1];
};
const has = (n) => argv.includes(n);
const FF = flag('--ffmpeg') ?? 'ffmpeg';
const CLI_FF = flag('--cli-ffmpeg') ?? FF;
const only = flag('--only')?.split(',');
const cli = join(root, 'dist-cli', 'rsmps.mjs');
if (!existsSync(cli)) {
  console.error('dist-cli/rsmps.mjs is missing: run `npm run build:cli` first.');
  process.exit(2);
}
const work = flag('--keep') ? resolve(flag('--keep')) : mkdtempSync(join(tmpdir(), 'rsmps-check-formats-'));
mkdirSync(work, { recursive: true });

const bundled = await build({ entryPoints: [join(root, 'src', 'io', 'export-codecs.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
const { WIRED_ROWS } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

/* ------------------------------------------------------------------ helpers ------------------------------------------------------------------ */

const text = (b) => (b ? b.toString('utf8') : '');
const ff = (args, opts = {}) => spawnSync(FF, ['-hide_banner', ...args], { maxBuffer: 1 << 30, windowsHide: true, ...opts });

function run(args, extra = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, 'render', ...args, '--quiet'], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, env: { ...process.env, FFMPEG_PATH: CLI_FF }, ...extra });
  return { ok: r.status === 0, ms: Date.now() - t0, err: `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 220) };
}

function mkGraphs() {
  const proj = (w, h, fps, duration) => ({ width: w, height: h, fps, duration, loop: true, lengthMode: 'relative', referenceSide: h });
  const e = (id, a, ap, b, bp) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });
  // half transparent ellipse moving over a transparent canvas, plus a sine: alpha, over-black and sound all have something to show
  const shapes = {
    schema: 'rsmps/graph', version: 2, name: 'shapes', project: proj(640, 360, 25, 1),
    nodes: [
      { id: 's', type: 'shape', x: 0, y: 0, params: { kind: 'ellipse', width: 0.5, height: 0.6, fill: [1, 0.3, 0.1, 0.55] } },
      { id: 'a', type: 'animate', x: 0, y: 200, params: { from: 0.3, to: 0.7, wave: 'sine' } },
      { id: 'out', type: 'image-out', x: 300, y: 0, params: { name: 'shapes', kind: 'video' }, label: 'Out' },
      { id: 'o', type: 'oscillator', x: 0, y: 400, params: {} },
      { id: 'ao', type: 'audio-out', x: 300, y: 400, params: {} },
    ],
    edges: [e('e1', 's', 'image', 'out', 'image'), e('e2', 'a', 'value', 's', 'x'), e('e3', 'o', 'audio', 'ao', 'audio')],
  };
  const scene = {
    schema: 'rsmps/graph', version: 2, name: 'scene', project: proj(1920, 1080, 25, 2),
    nodes: [
      { id: 'm', type: 'media-in', x: 0, y: 0, params: { assets: [join(root, 'test-assets', 'scene-1920x1080.png')] } },
      { id: 'sc', type: 'scroll', x: 200, y: 0, params: {} },
      { id: 'out', type: 'image-out', x: 400, y: 0, params: { name: 'scene', kind: 'video' }, label: 'Out' },
    ],
    edges: [e('e1', 'm', 'image', 'sc', 'image'), e('e2', 'sc', 'image', 'out', 'image')],
  };
  writeFileSync(join(work, 'shapes.rsmps.json'), JSON.stringify(shapes));
  writeFileSync(join(work, 'scene.rsmps.json'), JSON.stringify(scene));
  return { shapes: join(work, 'shapes.rsmps.json'), scene: join(work, 'scene.rsmps.json') };
}

/** Width, height, audio stream and duration of a file, from `ffmpeg -i`. */
function probe(file) {
  const t = text(ff(['-i', file]).stderr);
  const v = /Video: .*?, (\d+)x(\d+)/.exec(t);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(t);
  return { w: v ? +v[1] : 0, h: v ? +v[2] : 0, hasVideo: !!v, hasAudio: /Audio:/.test(t), seconds: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0, text: t };
}

/** Decode every video frame of a file to raw bytes in `pix` (all frames, no duplication or dropping). */
function decode(file, pix = 'rgba', extra = [], o = {}) {
  const p = probe(file);
  // animated pictures merge identical neighbours into one longer frame: they are read at the project's constant rate (25 fps)
  const timing = o.cfr ? ['-fps_mode', 'cfr', '-r', '25'] : ['-fps_mode', 'passthrough'];
  const r = ff(['-v', 'error', ...extra, '-i', file, '-map', `0:v:${o.stream ?? 0}`, ...timing, '-f', 'rawvideo', '-pix_fmt', pix, '-'], { encoding: 'buffer' });
  const bpp = { rgba: 4, rgb24: 3, rgba64le: 8, gbrapf32le: 16, gbrpf32le: 12 }[pix];
  return { ok: r.status === 0 && !text(r.stderr).trim(), err: text(r.stderr).trim().split('\n').slice(-2).join(' | '), w: p.w, h: p.h, data: r.stdout, frameBytes: p.w * p.h * bpp, count: p.w && bpp ? Math.floor(r.stdout.length / (p.w * p.h * bpp)) : 0 };
}

/** Quiet decode check: exit 0 and nothing on stderr. */
function decodesCleanly(file, extra = []) {
  const r = ff(['-v', 'error', ...extra, '-i', file, '-f', 'null', '-'], { encoding: 'buffer' });
  return { ok: r.status === 0 && !text(r.stderr).trim(), err: text(r.stderr).trim().split('\n').slice(-2).join(' | ') };
}

function frameCount(file, o = {}) {
  const timing = o.cfr ? ['-fps_mode', 'cfr', '-r', '25'] : ['-fps_mode', 'passthrough'];
  const r = ff(['-v', 'error', '-stats', '-i', file, '-map', `0:v:${o.stream ?? 0}`, ...timing, '-f', 'null', '-'], { encoding: 'buffer' });
  const m = [...text(r.stderr).matchAll(/frame=\s*(\d+)/g)].pop();
  return m ? +m[1] : 0;
}

/** PSNR (dB) of two straight RGBA frames after placing both over black; 99 when identical. `mask`: only pixels whose reference alpha is >= this. */
function psnrOverBlack(a, b, mask = 0) {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (mask && b[i + 3] < mask) continue;
    const ka = mask ? 1 : a[i + 3] / 255;
    const kb = mask ? 1 : b[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] * ka - b[i + c] * kb;
      se += d * d;
    }
    n += 3;
  }
  if (!n || se === 0) return 99;
  return 10 * Math.log10((255 * 255) / (se / n));
}
const pixel = (frame, w, x, y) => Array.from(frame.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

const results = [];
const add = (id, kind, route, status, note) => results.push({ id, kind, route, status, note });

/* ------------------------------------------------------------------ references ------------------------------------------------------------------ */

const graphs = mkGraphs();
const refDir = join(work, '_ref');
let refFrames = null; // straight RGBA of every frame of the shapes graph, from the PNG sequence
{
  const r = run([graphs.shapes, '--format', 'png', '--kind', 'sequence', '--out', refDir]);
  if (!r.ok) {
    console.error('Cannot make the PNG reference: ' + r.err);
    process.exit(2);
  }
  const dir = join(refDir, readdirSync(refDir).find((d) => statSync(join(refDir, d)).isDirectory()) ?? '');
  refFrames = readdirSync(dir).sort().map((f) => decode(join(dir, f)).data);
}
const REF_W = 640;
const REF_H = 360;
const FRAMES = 25;
// the sound reference: the engine's own 32-bit float WAV
const refWavDir = join(work, '_refwav');
run([graphs.shapes, '--format', 'wav32f', '--out', refWavDir]);
const refWav = join(refWavDir, 'shapes.wav');
const refPcm = existsSync(refWav) ? ff(['-v', 'error', '-i', refWav, '-f', 'f32le', '-ac', '1', '-'], { encoding: 'buffer' }).stdout : null;

/* ------------------------------------------------------------------ thresholds ------------------------------------------------------------------ */

const LOSSLESS_VIDEO = new Set(['png', 'raw-mov', 'apng', 'qtrle', 'ffv1', 'utvideo', 'rawvideo']);
/** Minimum PSNR (over black) per row; rows not listed use the lossy default. */
const MIN_PSNR = { hap: 35, 'hap-alpha': 35, 'hap-q': 35, mjpeg: 33, gif: 28, 'webp-anim': 30, 'avif-anim': 28, 'prores-proxy': 30, 'prores-lt': 30, 'prores-standard': 30, mpeg2: 25, mpeg4: 25, vp8: 25, h264: 25, hevc: 25, vp9: 25, av1: 25, 'h264-crf': 28, 'h264-intra': 28, 'hevc-crf': 28, 'hevc-intra': 28, 'av1-ffmpeg': 25 };

/* ------------------------------------------------------------------ video / animated rows ------------------------------------------------------------------ */

function checkVideo(row, route, given) {
  const dir = join(work, row.id);
  const r = given ? { ok: true, ms: 0, err: '' } : run([graphs.shapes, '--codec', row.id, '--out', dir]);
  const file = given?.file ?? join(dir, `shapes.${row.ext}`);
  const label = given?.tag ?? row.id;
  const add = (id, kind, route, status, note) => results.push({ id: label, kind, route, status, note });
  if (!r.ok || !existsSync(file)) return add(row.id, row.kind, route, 'FAIL', `export: ${r.err}`);
  const clean = decodesCleanly(file);
  if (!clean.ok) return add(row.id, row.kind, route, 'FAIL', `decode: ${clean.err}`);
  const p = probe(file);
  if (p.w !== REF_W || p.h !== REF_H) return add(row.id, row.kind, route, 'FAIL', `size ${p.w}x${p.h}, expected ${REF_W}x${REF_H}`);
  const dopt = { cfr: row.kind === 'animated', stream: row.id === 'avif-anim' ? 1 : 0 };
  const count = frameCount(file, dopt);
  if (count !== FRAMES) return add(row.id, row.kind, route, 'FAIL', `${count} frames, expected ${FRAMES}`);
  if (row.audio && row.kind === 'video') {
    if (!p.hasAudio) return add(row.id, row.kind, route, 'FAIL', 'audio track missing');
    if (Math.abs(p.seconds - 1) > 0.08) return add(row.id, row.kind, route, 'FAIL', `duration ${p.seconds}s, expected 1s`);
  }
  const d = decode(file, 'rgba', row.id === 'webm-alpha' ? ['-c:v', 'libvpx-vp9'] : [], dopt);
  if (d.count !== FRAMES) return add(row.id, row.kind, route, 'FAIL', `decoded ${d.count} frames, expected ${FRAMES}`);
  const f = (k) => d.data.subarray(k * d.frameBytes, (k + 1) * d.frameBytes);
  const alphaSeen = (() => {
    const px = f(12);
    let min = 255;
    let mid = 0;
    for (let i = 3; i < px.length; i += 4) {
      min = Math.min(min, px[i]);
      if (px[i] > 20 && px[i] < 235) mid++;
    }
    return { min, mid };
  })();
  if (row.alpha) {
    if (alphaSeen.min > 10) return add(row.id, row.kind, route, 'FAIL', 'claims alpha but nothing is transparent after decoding');
    if (row.id !== 'gif' && alphaSeen.mid === 0 && !/^(webm-alpha)$/.test(row.id)) return add(row.id, row.kind, route, 'FAIL', 'the half transparent ellipse lost its partial alpha');
  } else if (alphaSeen.min < 255) return add(row.id, row.kind, route, 'FAIL', 'no-alpha format decodes with transparency');
  // the corner of an opaque format is black (placed over black), never white or the shape color
  const corner = pixel(f(12), REF_W, 2, 2);
  if (!row.alpha && corner[0] + corner[1] + corner[2] > 30) return add(row.id, row.kind, route, 'FAIL', `opaque format: corner is ${corner.slice(0, 3)} instead of black`);
  const psnr = psnrOverBlack(f(12), refFrames[12], row.id === 'gif' ? 128 : 0);
  const need = LOSSLESS_VIDEO.has(row.id) ? 55 : (MIN_PSNR[row.id] ?? 25);
  if (psnr < need) return add(row.id, row.kind, route, 'FAIL', `PSNR ${psnr.toFixed(1)} dB < ${need}`);
  if (row.id === 'gif') {
    const odd = [...f(12)].filter((v, i) => i % 4 === 3 && v !== 0 && v !== 255).length;
    if (odd) return add(row.id, row.kind, route, 'FAIL', 'GIF alpha is not binary');
  }
  add(row.id, row.kind, route, 'PASS', `${(statSync(file).size / 1024).toFixed(0)} KB, ${count} frames${row.audio && row.kind === 'video' ? ' +audio' : ''}${row.alpha ? ' alpha' : ''}, PSNR ${psnr >= 99 ? 'exact' : psnr.toFixed(1)} dB, ${(r.ms / 1000).toFixed(1)} s`);
}

/* ------------------------------------------------------------------ still rows ------------------------------------------------------------------ */

const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

async function decodeWithSharp(file) {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ok: true, err: '', w: info.width, h: info.height, data, count: 1, frameBytes: data.length };
}

async function checkStill(row, route, given) {
  const dir = join(work, 'still-' + row.id);
  const r = given ? { ok: true, err: '' } : run([graphs.shapes, '--format', row.id, '--kind', 'image', '--out', dir]);
  const file = given?.file ?? join(dir, `shapes.${row.ext}`);
  const add = (id, kind, route, status, note) => results.push({ id: given?.tag ?? id, kind, route, status, note });
  if (!r.ok || !existsSync(file)) return add(row.id, 'still', route, 'FAIL', `export: ${r.err}`);
  const ref = refFrames[0];
  const refW = REF_W;
  const refH = REF_H;
  const size = (statSync(file).size / 1024).toFixed(0);
  if (row.id === 'exr' || row.id === 'hdr') {
    const pix = row.id === 'exr' ? 'gbrapf32le' : 'gbrpf32le';
    const d = decode(file, pix);
    if (!d.ok || d.count !== 1) return add(row.id, 'still', route, 'FAIL', `decode: ${d.err || d.count + ' frames'}`);
    if (d.w !== refW || d.h !== refH) return add(row.id, 'still', route, 'FAIL', `size ${d.w}x${d.h}`);
    const planes = row.id === 'exr' ? 4 : 3;
    const f32 = new Float32Array(d.data.buffer, d.data.byteOffset, (d.data.length / 4) | 0);
    const n = refW * refH;
    let maxErr = 0;
    for (let i = 0; i < n; i += 7) {
      const a = ref[i * 4 + 3] / 255;
      const g = f32[i], b = f32[n + i], rr = f32[2 * n + i];
      for (const [c, got] of [[0, rr], [1, g], [2, b]]) {
        // EXR: premultiplied linear of the straight color; HDR: the picture over black, linearised
        const want = row.id === 'exr' ? srgbToLin(ref[i * 4 + c] / 255) * a : srgbToLin((ref[i * 4 + c] / 255) * a);
        maxErr = Math.max(maxErr, Math.abs(got - want));
      }
      if (planes === 4) maxErr = Math.max(maxErr, Math.abs(f32[3 * n + i] - a));
    }
    if (maxErr > 0.02) return add(row.id, 'still', route, 'FAIL', `linear values differ by up to ${maxErr.toFixed(3)}`);
    return add(row.id, 'still', route, 'PASS', `${size} KB, linear float, max error ${maxErr.toFixed(4)}`);
  }
  if (row.id === 'tiff16') {
    const d = decode(file, 'rgba64le');
    if (!d.ok || d.count !== 1) return add(row.id, 'still', route, 'FAIL', `decode: ${d.err}`);
    const u = new Uint16Array(d.data.buffer, d.data.byteOffset, d.data.length / 2);
    let maxErr = 0;
    for (let i = 0; i < refW * refH; i += 5) if (ref[i * 4 + 3] > 0) for (let c = 0; c < 4; c++) maxErr = Math.max(maxErr, Math.abs(u[i * 4 + c] / 257 - ref[i * 4 + c]));
    if (maxErr > 1.01) return add(row.id, 'still', route, 'FAIL', `differs by ${maxErr.toFixed(2)} / 255`);
    return add(row.id, 'still', route, 'PASS', `${size} KB, 16-bit, max error ${maxErr.toFixed(2)} / 255`);
  }
  // FFmpeg does not read the alpha channel of AVIF stills: sharp (libvips + libheif) does
  const d = row.id === 'avif' ? await decodeWithSharp(file) : decode(file, 'rgba');
  if (!d.ok || d.count !== 1) return add(row.id, 'still', route, 'FAIL', `decode: ${d.err || d.count + ' frames'}`);
  if (row.id === 'ico') {
    // ICO holds the picture centred in a square at 16..256: check it decodes with alpha, the shape is there and the corner is transparent
    let minA = 255;
    for (let i = 3; i < d.data.length; i += 4) minA = Math.min(minA, d.data[i]);
    return minA < 10 ? add(row.id, 'still', route, 'PASS', `${size} KB, ${d.w}x${d.h}, alpha ok`) : add(row.id, 'still', route, 'FAIL', 'no transparency in the icon');
  }
  if (d.w !== refW || d.h !== refH) return add(row.id, 'still', route, 'FAIL', `size ${d.w}x${d.h}`);
  const lossy = new Set(['webp', 'jpeg', 'avif', 'jp2']);
  const px = d.data;
  if (lossy.has(row.id)) {
    const psnr = psnrOverBlack(px, ref);
    const need = { webp: 35, jpeg: 33, avif: 30, jp2: 40 }[row.id];
    return psnr >= need ? add(row.id, 'still', route, 'PASS', `${size} KB, PSNR ${psnr.toFixed(1)} dB`) : add(row.id, 'still', route, 'FAIL', `PSNR ${psnr.toFixed(1)} < ${need}`);
  }
  // lossless 8-bit: exact where something is visible (the color under alpha 0 is not stored by every format)
  let maxErr = 0;
  const tol = row.id === 'dpx' ? 3 : 1;
  for (let i = 0; i < refW * refH; i++) {
    const a = ref[i * 4 + 3];
    if (row.alpha) {
      maxErr = Math.max(maxErr, Math.abs(px[i * 4 + 3] - a));
      if (a > 0) for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(px[i * 4 + c] - ref[i * 4 + c]));
    } else for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(px[i * 4 + c] - Math.round((ref[i * 4 + c] * a) / 255)));
  }
  if (!row.alpha && Math.max(...[...px].filter((_, i) => i % 4 === 3).slice(0, 1000)) !== 255) return add(row.id, 'still', route, 'FAIL', 'opaque format decoded with transparency');
  return maxErr <= tol ? add(row.id, 'still', route, 'PASS', `${size} KB, max error ${maxErr} / 255${row.alpha ? ', alpha ok' : ', over black'}`) : add(row.id, 'still', route, 'FAIL', `differs by ${maxErr} / 255`);
}

/** A short sequence in one own format and one FFmpeg or browser format: the name tokens and the frame count. */
function checkSequence(row, route) {
  const dir = join(work, 'seq-' + row.id);
  const r = run([graphs.shapes, '--format', row.id, '--kind', 'sequence', '--out', dir]);
  if (!r.ok) return add(row.id + ' (sequence)', 'still', route, 'FAIL', `export: ${r.err}`);
  const sub = readdirSync(dir).find((d) => statSync(join(dir, d)).isDirectory());
  const files = sub ? readdirSync(join(dir, sub)).filter((f) => f.endsWith('.' + row.ext)) : [];
  if (files.length !== FRAMES) return add(row.id + ' (sequence)', 'still', route, 'FAIL', `${files.length} files, expected ${FRAMES}`);
  const d = decode(join(dir, sub, files[12]));
  const psnr = d.count === 1 && (row.id === 'exr' || row.id === 'hdr') ? 99 : psnrOverBlack(d.data, refFrames[12]);
  if (!(psnr >= 30) && row.id !== 'ico') return add(row.id + ' (sequence)', 'still', route, 'FAIL', `frame 13 PSNR ${psnr.toFixed(1)} dB`);
  add(row.id + ' (sequence)', 'still', route, 'PASS', `${files.length} files, ${files[0]} ... ${files[files.length - 1]}`);
}

/* ------------------------------------------------------------------ sound rows ------------------------------------------------------------------ */

function checkAudio(row, route, given) {
  const dir = join(work, 'snd-' + row.id);
  const r = given ? { ok: true, err: '' } : run([graphs.shapes, '--format', row.id, '--out', dir]);
  const file = given?.file ?? join(dir, `shapes.${row.ext}`);
  const add = (id, kind, route, status, note) => results.push({ id: given?.tag ?? id, kind, route, status, note });
  if (!r.ok || !existsSync(file)) return add(row.id, 'audio', route, 'FAIL', `export: ${r.err}`);
  const clean = decodesCleanly(file);
  if (!clean.ok) return add(row.id, 'audio', route, 'FAIL', `decode: ${clean.err}`);
  const p = probe(file);
  if (!p.hasAudio) return add(row.id, 'audio', route, 'FAIL', 'no audio stream');
  if (Math.abs(p.seconds - 1) > 0.1) return add(row.id, 'audio', route, 'FAIL', `duration ${p.seconds}s, expected 1s`);
  const pcm = ff(['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { encoding: 'buffer' }).stdout;
  const got = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const want = refPcm ? new Float32Array(refPcm.buffer, refPcm.byteOffset, refPcm.length / 4) : null;
  const size = (statSync(file).size / 1024).toFixed(0);
  if (!want) return add(row.id, 'audio', route, 'PASS', `${size} KB, ${p.seconds}s (no reference)`);
  const lossless = { wav32f: 1e-6, wav24: 2e-7 * 8, wav: 1 / 32768 + 1e-6, aiff24: 2e-7 * 8, aiff: 1 / 32768 + 1e-6, flac24: 2e-7 * 8, flac: 1 / 32768 + 1e-6, alac: 1 / 32768 + 1e-6 }[row.id];
  const n = Math.min(got.length, want.length);
  if (lossless !== undefined) {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(got[i] - want[i]));
    if (Math.abs(got.length - want.length) > 2) return add(row.id, 'audio', route, 'FAIL', `${got.length} samples, expected ${want.length}`);
    return max <= lossless ? add(row.id, 'audio', route, 'PASS', `${size} KB, samples equal (max diff ${max.toExponential(1)})`) : add(row.id, 'audio', route, 'FAIL', `samples differ by ${max.toExponential(2)} > ${lossless.toExponential(1)}`);
  }
  // lossy: same loudness (RMS within 15 %)
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
  const ratio = rms(got.subarray(0, n)) / Math.max(1e-9, rms(want.subarray(0, n)));
  return ratio > 0.85 && ratio < 1.15 ? add(row.id, 'audio', route, 'PASS', `${size} KB, ${p.seconds}s, loudness ${(ratio * 100).toFixed(0)} %`) : add(row.id, 'audio', route, 'FAIL', `loudness ratio ${ratio.toFixed(2)}`);
}

/* ------------------------------------------------------------------ the loop ------------------------------------------------------------------ */

const listing = JSON.parse(spawnSync(process.execPath, [cli, 'formats', '--json'], { encoding: 'utf8', env: { ...process.env, FFMPEG_PATH: CLI_FF } }).stdout);
const here = new Map(listing.formats.map((f) => [f.id, f]));
for (const row of has('--browser-only') ? [] : WIRED_ROWS) {
  if (only && !only.includes(row.id)) continue;
  const l = here.get(row.id);
  const route = `${row.route}${l && l.via !== row.route ? ` > ${l.via}` : ''}`;
  if (!l || !l.available) {
    add(row.id, row.kind, route, 'SKIP', l?.note ?? 'not available here');
    continue;
  }
  if (has('--skip-ffmpeg-rows') && l.via === 'ffmpeg') {
    add(row.id, row.kind, route, 'SKIP', 'FFmpeg rows skipped');
    continue;
  }
  try {
    if (row.kind === 'video' || row.kind === 'animated') checkVideo(row, route);
    else if (row.kind === 'still') {
      await checkStill(row, route);
      if (['qoi', 'tiff', 'exr', 'png-image', 'dpx'].includes(row.id)) checkSequence(row, route);
    } else checkAudio(row, route);
  } catch (err) {
    add(row.id, row.kind, route, 'FAIL', `script error: ${err?.message ?? err}`);
  }
}

/* ------------------------------------------------------------------ files exported by the app in the browser ------------------------------------------------------------------ */

if (flag('--browser')) {
  const dir = resolve(flag('--browser'));
  const manifest = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const rowOf = (tag) => {
    const t = tag.replace(/^(still_|sound_|seq_)/, '');
    const map = { hap_alpha: 'hap-alpha', hap_q: 'hap-q', hap_better: 'hap', hap_nosnappy: 'hap', png_mov: 'png', raw_mov: 'raw-mov', gif_shared_floyd: 'gif', png: 'png-image', h264: 'h264' };
    const id = map[t] ?? t;
    return WIRED_ROWS.find((r) => r.id === id);
  };
  for (const m of manifest) {
    const row = rowOf(m.tag);
    if (m.error || !row) {
      add(m.tag, 'browser', 'browser', 'FAIL', m.error ?? 'no matching row');
      continue;
    }
    const files = m.files ?? [];
    const first = files.find((f) => !/errors\.txt$/.test(f.name));
    const file = first ? join(dir, first.name) : '';
    const noted = files.find((f) => /errors\.txt$/.test(f.name));
    try {
      if (m.tag.startsWith('seq_')) {
        const n = files.filter((f) => f.name.endsWith('.' + row.ext)).length;
        add(m.tag, 'still', 'browser', n === FRAMES ? 'PASS' : 'FAIL', `${n} files`);
      } else if (m.tag === 'still_avif' && noted) {
        add(m.tag, 'still', 'browser', 'PASS', 'this browser cannot encode AVIF: PNG written instead, with a note (the format is hidden in the list here)');
      } else if (m.tag === 'sound_mp3' && noted) {
        add(m.tag, 'audio', 'browser', 'PASS', 'no FFmpeg in the web version: WAV written instead, with a note');
      } else if (m.tag.startsWith('still_')) await checkStill(row, 'browser', { file, tag: m.tag });
      else if (m.tag.startsWith('sound_')) checkAudio(row, 'browser', { file, tag: m.tag });
      else checkVideo(row, 'browser', { file, tag: m.tag });
    } catch (err) {
      add(m.tag, 'browser', 'browser', 'FAIL', `script error: ${err?.message ?? err}`);
    }
  }
  const big = join(dir, 'big_4k_hap_alpha.mov');
  if (existsSync(big)) {
    const info = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'big.json'), 'utf8'));
    const p = probe(big);
    const count = frameCount(big);
    const ok = count === 25 && p.w === 3840 && p.h === 2160 && decodesCleanly(big).ok && info.files[0]?.blobSize === 0;
    add('big 4K hap (sink)', 'video', 'browser', ok ? 'PASS' : 'FAIL', `${count} frames ${p.w}x${p.h}, ${(info.fileSize / 1048576).toFixed(0)} MB written through the file sink, JS heap peak ${info.peakHeapMB} MB (base ${info.baseHeapMB} MB), ${(info.ms / 25).toFixed(0)} ms/frame`);
  }
}

/* ------------------------------------------------------------------ HAP at 1080p and 4K ------------------------------------------------------------------ */

const extra = [];
if (has('--hap')) {
  const refScene = join(work, '_scene');
  const rr = run([graphs.scene, '--format', 'png', '--kind', 'sequence', '--out', refScene]);
  if (!rr.ok) extra.push(`HAP reference failed: ${rr.err}`);
  else {
    const sub = readdirSync(refScene).find((d) => statSync(join(refScene, d)).isDirectory());
    const files = readdirSync(join(refScene, sub)).sort();
    const ref = (k) => decode(join(refScene, sub, files[k])).data;
    const picks = [0, 24, 49];
    const refs = picks.map(ref);
    for (const id of ['hap', 'hap-alpha', 'hap-q']) {
      const dir = join(work, 'hap1080-' + id);
      const r = run([graphs.scene, '--codec', id, '--out', dir]);
      const file = join(dir, 'scene.mov');
      if (!r.ok || !existsSync(file)) {
        extra.push(`${id}: export failed: ${r.err}`);
        add(`${id} 1080p`, 'video', 'own', 'FAIL', r.err);
        continue;
      }
      const p = probe(file);
      const count = frameCount(file);
      const d = decode(file);
      const psnrs = picks.map((k, i) => psnrOverBlack(d.data.subarray(k * d.frameBytes, (k + 1) * d.frameBytes), refs[i]));
      const alphaOk = id === 'hap-alpha' ? /rgba/.test(p.text) : true;
      const ok = count === 50 && p.w === 1920 && p.h === 1080 && alphaOk && Math.min(...psnrs) >= 35 && decodesCleanly(file).ok;
      add(`${id} 1080p`, 'video', 'own', ok ? 'PASS' : 'FAIL', `${count} frames ${p.w}x${p.h}${id === 'hap-alpha' ? ' rgba' : ''}, ${(statSync(file).size / 1048576).toFixed(1)} MB, ${(r.ms / 50).toFixed(0)} ms/frame whole export, PSNR ${psnrs.map((v) => v.toFixed(1)).join('/')} dB`);
    }
  }
}
if (has('--hap4k')) {
  const dir = join(work, 'hap4k');
  const t0 = Date.now();
  const child = spawn(process.execPath, [cli, 'render', graphs.scene, '--codec', 'hap-alpha', '--set', 'Out.scale=2', '--set', 'Out.hapSnappy=false', '--duration', '4', '--out', dir, '--quiet'], { env: { ...process.env, FFMPEG_PATH: CLI_FF }, windowsHide: true });
  let peak = 0;
  const poll = setInterval(() => {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /"([\d,. ]+) K"/.exec(r.stdout ?? '');
    if (m) peak = Math.max(peak, parseInt(m[1].replace(/\D/g, ''), 10) / 1024);
  }, 250);
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((res) => child.on('close', res));
  clearInterval(poll);
  const file = join(dir, 'scene.mov');
  if (code !== 0 || !existsSync(file)) add('hap-alpha 4K', 'video', 'own', 'FAIL', `export: ${err.trim().slice(-200)}`);
  else {
    const p = probe(file);
    const count = frameCount(file);
    const ok = count === 100 && p.w === 3840 && p.h === 2160 && decodesCleanly(file).ok;
    add('hap-alpha 4K', 'video', 'own', ok ? 'PASS' : 'FAIL', `${count} frames ${p.w}x${p.h}, ${(statSync(file).size / 1048576).toFixed(0)} MB on disk, peak memory ${peak.toFixed(0)} MB (polled), ${((Date.now() - t0) / 100).toFixed(0)} ms/frame`);
  }
}

/* ------------------------------------------------------------------ report ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
console.log(text(ff(['-version']).stdout).split('\n')[0]);
console.log(`CLI FFmpeg routes use: ${CLI_FF}`);
console.log('');
console.log(`${pad('id', 22)}${pad('kind', 9)}${pad('route', 24)}${pad('result', 7)}note`);
for (const r of results) console.log(`${pad(r.id, 22)}${pad(r.kind, 9)}${pad(r.route, 24)}${pad(r.status, 7)}${r.note}`);
for (const e of extra) console.log(e);
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped (not available on this machine).`);
if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
process.exit(count('FAIL') ? 1 : 0);
