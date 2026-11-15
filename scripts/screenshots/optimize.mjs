// Shrinks the PNGs in docs/screenshots/ to palette PNGs (lossless for flat UI colours, visually identical) so each stays
// under ~400 KB. Run after capture:  node scripts/screenshots/optimize.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'screenshots');
const LIMIT = 400 * 1024;
for (const f of readdirSync(dir).filter((n) => /^\d.*\.png$/.test(n))) {
  const p = join(dir, f);
  const src = readFileSync(p);
  if (src.length <= LIMIT) continue;
  const out = await sharp(src).png({ palette: true, quality: 92, effort: 10, colours: 256, dither: 0.6 }).toBuffer();
  writeFileSync(p, out);
  console.log(`${f}: ${Math.round(src.length / 1024)} KB -> ${Math.round(out.length / 1024)} KB`);
}
