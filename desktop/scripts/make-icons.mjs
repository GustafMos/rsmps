// Generates every desktop icon / installer image into desktop/build/ from desktop/icon-source.png (2000x2000 scorpion,
// transparent background). Outputs:
//   icon.png (1024) and icon-512.png, icon-256.png  transparent, trimmed, ~8 % margin (Windows, Linux, window icon)
//   icon.ico                                         16..256; 16/24/32 use a version with the soft halo cut away
//   icon-mac.png (1024)                              dark rounded tile (#101114, 22 % radius), logo at 70 % (macOS)
//   installerSidebar.bmp, installerHeader.bmp        NSIS wizard images
// electron-builder derives icon.icns from icon-mac.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'desktop', 'build');
mkdirSync(outDir, { recursive: true });
const source = join(root, 'desktop', 'icon-source.png');

/** The art with pixels below `minAlpha` made fully transparent, cropped to its bounding box. */
async function trimmed(minAlpha) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (data[i] < minAlpha) data[i] = 0;
      else {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .png()
    .toBuffer();
}

const full = await trimmed(6); // keeps the soft halo
const core = await trimmed(110); // halo cropped, for tiny sizes
const clear = { r: 0, g: 0, b: 0, alpha: 0 };

/** Fits the art into a size x size canvas, centred, with `fraction` of the canvas as the art's longest side. */
async function place(art, size, fraction) {
  const inner = Math.max(1, Math.round(size * fraction));
  const fitted = await sharp(art).resize(inner, inner, { fit: 'contain', background: clear, kernel: 'lanczos3' }).png().toBuffer();
  const pad = size - inner;
  return sharp(fitted)
    .extend({ top: Math.floor(pad / 2), bottom: Math.ceil(pad / 2), left: Math.floor(pad / 2), right: Math.ceil(pad / 2), background: clear })
    .png()
    .toBuffer();
}

const plain = (size) => place(size <= 32 ? core : full, size, size <= 32 ? 0.94 : 0.84); // 8 % margin each side; tiny sizes need the room

async function macTile(size = 1024) {
  const r = Math.round(size * 0.22);
  const tile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#101114"/></svg>`);
  const logo = await place(full, size, 0.7);
  return sharp(tile).composite([{ input: logo }]).png().toBuffer();
}

writeFileSync(join(outDir, 'icon.png'), await plain(1024));
writeFileSync(join(outDir, 'icon-512.png'), await plain(512));
writeFileSync(join(outDir, 'icon-256.png'), await plain(256));
writeFileSync(join(outDir, 'icon-mac.png'), await macTile());

// Windows .ico: a directory of PNG-compressed images (supported since Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((s) => plain(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));

// Preview strip of the small sizes, enlarged, for eyeballing (not used by the build).
const small = [16, 24, 32, 48];
const lefts = small.map((_, i) => small.slice(0, i).reduce((n, s) => n + s * 6 + 10, 0));
const strip = await Promise.all(small.map(async (s) => sharp(await plain(s)).resize(s * 6, s * 6, { kernel: 'nearest' }).png().toBuffer()));
writeFileSync(
  join(outDir, 'preview-small.png'),
  await sharp({ create: { width: lefts[3] + 48 * 6, height: 48 * 6, channels: 3, background: '#2b2d33' } })
    .composite(strip.map((input, i) => ({ input, left: lefts[i], top: 0 })))
    .png()
    .toBuffer(),
);

/** 24-bit BMP from raw RGB (NSIS wizard images must be BMP). */
function bmp(rgb, w, h) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const data = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 3; // bottom-up, BGR
      const d = y * rowBytes + x * 3;
      data[d] = rgb[s + 2];
      data[d + 1] = rgb[s + 1];
      data[d + 2] = rgb[s];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}
async function wizardImage(w, h, logoSize, logoTop) {
  const logo = await place(full, logoSize, 0.95);
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: '#101114' } })
    .composite([{ input: logo, left: Math.round((w - logoSize) / 2), top: logoTop }])
    .removeAlpha()
    .raw()
    .toBuffer();
  return bmp(png, w, h);
}
writeFileSync(join(outDir, 'installerSidebar.bmp'), await wizardImage(164, 314, 140, 40));
writeFileSync(join(outDir, 'installerHeader.bmp'), await wizardImage(150, 57, 50, 4));

console.log(`icons written to ${outDir}`);
