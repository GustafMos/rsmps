/** Palette Lock helpers (pure): counting colors of an image against a palette, in the same 8-bit values the exported file will hold. */
import type { Rgb } from './pixel-color';

/** Packed 0xRRGGBB of an sRGB color, rounded like the 8-bit texture it is written to. */
export const pack8 = (c: readonly number[]): number => (Math.round(Math.min(1, Math.max(0, c[0])) * 255) << 16) | (Math.round(Math.min(1, Math.max(0, c[1])) * 255) << 8) | Math.round(Math.min(1, Math.max(0, c[2])) * 255);

export interface PaletteCount {
  /** Pixels with alpha above 0. */
  opaque: number;
  /** Of those, how many are not exactly a palette color. */
  off: number;
  /** Distinct colors among them. */
  colors: number;
}

/** Count over straight RGBA8. */
export function countAgainstPalette(rgba: ArrayLike<number>, palette: readonly Rgb[]): PaletteCount {
  const set = new Set(palette.map(pack8));
  const seen = new Set<number>();
  let opaque = 0;
  let off = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    opaque++;
    const k = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    seen.add(k);
    if (!set.has(k)) off++;
  }
  return { opaque, off, colors: seen.size };
}
