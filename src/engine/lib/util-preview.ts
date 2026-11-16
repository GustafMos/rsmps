/**
 * Test-only: write rendered pixels to a PNG so a human can LOOK at them. Does nothing unless the environment variable
 * RSMPS_PREVIEW_DIR names a folder. Transparent pixels are shown over a grey checkerboard. Several images are laid out side by side.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../../io/print/png';

interface PixelsLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export async function savePreview(name: string, images: PixelsLike | PixelsLike[], gap = 4, scale = 4): Promise<void> {
  const dir = process.env.RSMPS_PREVIEW_DIR;
  if (!dir) return;
  const list = Array.isArray(images) ? images : [images];
  const w = list.reduce((s, i) => s + i.width * scale, 0) + gap * (list.length - 1);
  const h = Math.max(...list.map((i) => i.height)) * scale;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set([40, 40, 40, 255], (y * w + x) * 4);
  let ox = 0;
  for (const img of list) {
    for (let y = 0; y < img.height * scale; y++)
      for (let x = 0; x < img.width * scale; x++) {
        const i = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
        const a = img.data[i + 3] / 255;
        const bg = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 150 : 110;
        const o = (y * w + ox + x) * 4;
        out[o] = img.data[i] * a + bg * (1 - a);
        out[o + 1] = img.data[i + 1] * a + bg * (1 - a);
        out[o + 2] = img.data[i + 2] * a + bg * (1 - a);
        out[o + 3] = 255;
      }
    ox += img.width * scale + gap;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), encodePng({ width: w, height: h, data: out }));
}
