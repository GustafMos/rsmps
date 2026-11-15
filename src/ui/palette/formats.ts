import { findHexColors, toHex, type RGB } from '../lib/colorMath';

export type ExportFormat = 'hex-list' | 'hex-file' | 'gpl' | 'pal' | 'lospec';
export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'hex-list', label: 'Hex list (#RRGGBB per line)', ext: 'txt' },
  { id: 'hex-file', label: '.hex (RRGGBB per line)', ext: 'hex' },
  { id: 'gpl', label: '.gpl (GIMP)', ext: 'gpl' },
  { id: 'pal', label: '.pal (JASC)', ext: 'pal' },
  { id: 'lospec', label: 'Comma list', ext: 'txt' },
];

const b255 = (c: RGB) => c.map((v) => Math.round(v * 255)) as [number, number, number];

export function exportPalette(colors: RGB[], fmt: ExportFormat, name = 'RSMPS palette'): string {
  switch (fmt) {
    case 'hex-list':
      return colors.map((c) => toHex(c)).join('\n');
    case 'hex-file':
      return colors.map((c) => toHex(c).slice(1).toLowerCase()).join('\n');
    case 'lospec':
      return colors.map((c) => toHex(c)).join(', ');
    case 'gpl':
      return `GIMP Palette\nName: ${name}\nColumns: 8\n#\n` + colors.map((c, i) => `${b255(c).map((n) => String(n).padStart(3)).join(' ')}\tColor ${i + 1}`).join('\n') + '\n';
    case 'pal':
      return `JASC-PAL\n0100\n${colors.length}\n` + colors.map((c) => b255(c).join(' ')).join('\n') + '\n';
  }
}

/** Reads hex lists (any separators), GIMP .gpl and JASC .pal. */
export function parsePalette(text: string): RGB[] {
  const t = text.replace(/^﻿/, '').trim();
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  if (/^JASC-PAL/i.test(t)) {
    const n = parseInt(lines[2] ?? '0', 10);
    return lines
      .slice(3, 3 + (Number.isFinite(n) ? n : 0))
      .map((l) => l.split(/\s+/).map(Number))
      .filter((p) => p.length >= 3 && p.every((v) => Number.isFinite(v)))
      .map((p) => [p[0] / 255, p[1] / 255, p[2] / 255] as RGB);
  }
  if (/^GIMP Palette/i.test(t)) {
    const out: RGB[] = [];
    for (const l of lines) {
      const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(\s|$)/.exec(l);
      if (m) out.push([+m[1] / 255, +m[2] / 255, +m[3] / 255]);
    }
    return out;
  }
  return findHexColors(t.replace(/[,;]/g, ' ').replace(/\s+/g, '\n'));
}

export function download(name: string, data: Blob | string, type = 'text/plain'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function swatchStripBlob(colors: RGB[], cell = 32): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = Math.max(1, colors.length) * cell;
  c.height = cell;
  const ctx = c.getContext('2d')!;
  colors.forEach((col, i) => {
    ctx.fillStyle = toHex(col);
    ctx.fillRect(i * cell, 0, cell, cell);
  });
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

/* ---------------------------- saved palettes ----------------------------- */

export interface SavedPalette {
  id: string;
  name: string;
  colors: string[];
}
const KEY = 'rsmps.ui.palettes';
export function loadSaved(): SavedPalette[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function storeSaved(list: SavedPalette[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
