/**
 * Export report: one entry per written image file, as JSON or plain text. Pure (the CLI collects the entries; `distinctColors` counts them).
 * `offPalette` comes from a Palette Lock node in "report" mode somewhere upstream of the Output (null when the graph has none).
 */

export interface ReportEntry {
  file: string;
  kind: 'image' | 'sequence' | 'spritesheet';
  item: number;
  width: number;
  height: number;
  /** Frames in the file (a sheet) or 1. */
  frames: number;
  bytes: number;
  /** Distinct RGB colors among pixels with alpha above 0. */
  colors: number;
  /** Fraction of opaque pixels that are not exactly on the palette (Palette Lock report), or null. */
  offPalette: number | null;
  pages?: number;
}

/** Count of distinct RGB colors among the pixels whose alpha is above 0 (straight RGBA8). */
export function distinctColors(rgba: ArrayLike<number>, into?: Set<number>): number {
  const set = into ?? new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 0) set.add(((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0);
  return set.size;
}

export function formatReport(entries: ReportEntry[], format: 'json' | 'text'): string {
  if (format === 'json') return JSON.stringify({ files: entries }, null, 2) + '\n';
  const lines = ['file | kind | size | frames | colors | off palette | bytes'];
  for (const e of entries) {
    lines.push([e.file, e.kind, `${e.width}x${e.height}`, e.frames, e.colors, e.offPalette === null ? '-' : `${(e.offPalette * 100).toFixed(2)}%`, e.bytes].join(' | '));
  }
  return lines.join('\n') + '\n';
}
