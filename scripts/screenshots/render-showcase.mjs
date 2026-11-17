// Renders the showcase images through the engine (the CLI renderer, so real WebGPU output, not UI screenshots):
//   docs/screenshots/looks.png      the base picture next to eight looks, composed with sharp
//   docs/screenshots/anim-crt.webp  a short looping animation of the pixel-art + CRT look (animated WebP)
// Run:  node scripts/screenshots/make-graphs.mjs && node scripts/screenshots/render-showcase.mjs
// Needs the CLI build (this script runs `npm run build:cli` first) and, for the animation, nothing else (PNG sequences need no ffmpeg).
// Source picture: scripts/screenshots/assets/base-scene.png (the author's own render, 16:9). Intermediate renders go to the OS temp folder.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const graphs = join(root, 'scripts', 'screenshots', 'graphs');
const outDir = join(root, 'docs', 'screenshots');
const scene = join(root, 'scripts', 'screenshots', 'assets', 'base-scene.png');
const work = mkdtempSync(join(tmpdir(), 'rsmps-showcase-'));
mkdirSync(outDir, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
run('npm', ['run', 'build:cli']);

function pngs(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...pngs(p));
    else if (e.endsWith('.png')) out.push(p);
  }
  return out.sort();
}
function render(file) {
  const dir = join(work, file.replace('.rsmps.json', ''));
  mkdirSync(dir, { recursive: true });
  run('node', ['dist-cli/rsmps.mjs', 'render', join(graphs, file), scene, '--out', dir, '--quiet']);
  const list = pngs(dir);
  if (!list.length) throw new Error('no output for ' + file);
  return list;
}

const TILE_W = 640, TILE_H = 360, GUT = 6;
const looks = [
  ['Original picture', null],
  ['Pixelate + dither, Endesga 32', 'look-pixel-dither.rsmps.json'],
  ['CRT display', 'look-crt.rsmps.json'],
  ['Analog video (VHS)', 'look-analog.rsmps.json'],
  ['Scan line relief', 'look-relief.rsmps.json'],
  ['Echo trail on a moving 3D object', 'look-echo.rsmps.json', 14],
  ['Lens blur from a depth gradient', 'look-lens-blur.rsmps.json'],
  ['Halftone (CMYK)', 'look-halftone.rsmps.json'],
  ['3D objects, two cameras', 'look-3d.rsmps.json'],
];
const tiles = [];
const full = {}; // full-resolution renders, reused for the store assets
for (const [caption, file, frame = 0] of looks) {
  let buf;
  if (!file) buf = readFileSync(scene);
  else {
    console.log('render', file);
    const list = render(file);
    buf = readFileSync(list[frame] ?? list[0]);
    full[file] = buf;
  }
  const img = await sharp(buf).resize(TILE_W, TILE_H, { fit: 'cover', kernel: file && /pixel|crt/.test(file) ? 'lanczos3' : 'lanczos3' }).flatten({ background: '#000' }).png().toBuffer();
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">
    <rect x="0" y="${TILE_H - 34}" width="${TILE_W}" height="34" fill="#0b0c10" fill-opacity="0.78"/>
    <text x="12" y="${TILE_H - 11}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="18" fill="#f2f4f8">${caption.replace(/&/g, '&amp;')}</text></svg>`);
  tiles.push({ input: await sharp(img).composite([{ input: label }]).png().toBuffer() });
}
const W = 3 * TILE_W + 4 * GUT, H = 3 * TILE_H + 4 * GUT;
const composite = tiles.map((t, i) => ({ ...t, left: GUT + (i % 3) * (TILE_W + GUT), top: GUT + Math.floor(i / 3) * (TILE_H + GUT) }));
const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: '#0b0c10' } }).composite(composite).png({ palette: true, quality: 90, effort: 10, dither: 0.7 }).toBuffer();
writeFileSync(join(outDir, 'looks.png'), sheet);
console.log(`looks.png ${W}x${H}, ${Math.round(sheet.length / 1024)} KB`);

// Animated WebP: 12 fps, 24 frames, 640x360, loops forever.
console.log('render anim-crt');
const frames = render('anim-crt.rsmps.json');
const AW = 640, AH = 360;
const raw = [];
for (const f of frames) raw.push(await sharp(f).resize(AW, AH).ensureAlpha().raw().toBuffer());
const anim = await sharp(Buffer.concat(raw), { raw: { width: AW, height: AH * raw.length, channels: 4, pageHeight: AH } })
  .webp({ loop: 0, delay: raw.map(() => 83), quality: 72, effort: 5, smartSubsample: true })
  .toBuffer();
writeFileSync(join(outDir, 'anim-crt.webp'), anim);
console.log(`anim-crt.webp ${frames.length} frames, ${Math.round(anim.length / 1024)} KB`);

// Store assets (private/store/assets, not in git): crops of the renders and screenshots at the sizes the store pages ask for.
const storeDir = join(root, 'private', 'store', 'assets');
mkdirSync(storeDir, { recursive: true });
const FONT = 'Segoe UI, Helvetica, Arial, sans-serif';
const banner = (w, h, title, sub, size) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0c10" stop-opacity="0"/><stop offset="1" stop-color="#0b0c10" stop-opacity="0.92"/></linearGradient></defs>
  <rect x="0" y="${h * 0.52}" width="${w}" height="${h * 0.48}" fill="url(#g)"/>
  <text x="${w * 0.05}" y="${h * 0.80}" font-family="${FONT}" font-weight="700" font-size="${size}" fill="#ffffff" letter-spacing="1">${title}</text>
  <text x="${w * 0.05}" y="${h * 0.80 + size * 0.95}" font-family="${FONT}" font-size="${Math.round(size * 0.46)}" fill="#c9d1dc">${sub}</text></svg>`);
async function cover(buf, w, h, title, sub, size, file, pos = 'centre') {
  const img = await sharp(buf).resize(w, h, { fit: 'cover', position: pos }).png().toBuffer();
  const out = await sharp(img).composite([{ input: banner(w, h, title, sub, size) }]).png({ palette: true, quality: 92, effort: 10, dither: 0.6 }).toBuffer();
  writeFileSync(join(storeDir, file), out);
  console.log(file, Math.round(out.length / 1024) + ' KB');
}
await cover(full['look-crt.rsmps.json'], 630, 500, 'RSMPS', 'Media Processing Suite', 64, 'itch-cover-630x500.png');
await cover(full['look-pixel-dither.rsmps.json'], 600, 600, 'RSMPS', 'Pixel art, video and sound', 70, 'gumroad-thumbnail-600x600.png', 'centre');
const shots = [['01-hero.png', 'hero'], ['02-generate.png', 'generators'], ['03-audio.png', 'audio'], ['04-track.png', 'detect-track'], ['05-add-menu.png', 'add-menu'], ['06-palette.png', 'palette-studio'], ['07-scan.png', 'scan']];
for (const [f, name] of shots) {
  const out = await sharp(join(outDir, f)).resize(1280, 800).png({ palette: true, quality: 92, effort: 10, dither: 0.6 }).toBuffer();
  writeFileSync(join(storeDir, `screenshot-${name}-1280x800.png`), out);
}
const wide = await sharp(join(outDir, 'looks.png')).resize(1280, 727).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
writeFileSync(join(storeDir, 'looks-1280x727.png'), wide);
const gcover = await sharp(join(outDir, '01-hero.png')).extract({ left: 0, top: 50, width: 1600, height: 900 }).resize(1280, 720).png({ palette: true, quality: 92, effort: 10 }).toBuffer();
writeFileSync(join(storeDir, 'gumroad-cover-1280x720.png'), gcover);
rmSync(work, { recursive: true, force: true });
