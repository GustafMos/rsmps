import { hexToRgb } from './pixel-color';
/** Built-in palettes (ported from the old engine, plus a few classics). Colours are hex. */
export interface BuiltinPalette {
  id: string;
  name: string;
  colors: string[];
}

const ramp = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const v = Math.round((i / (n - 1)) * 255).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  });

export const BUILTIN_PALETTES: BuiltinPalette[] = [
  {
    id: 'pico-8',
    name: 'PICO-8',
    colors: [
      '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
      '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
    ],
  },
  { id: 'gameboy-dmg', name: 'Game Boy DMG', colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  {
    id: 'sweetie-16',
    name: 'Sweetie 16',
    colors: [
      '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
      '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
    ],
  },
  {
    id: 'endesga-32',
    name: 'Endesga 32',
    colors: [
      '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
      '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
      '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
      '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
    ],
  },
  {
    id: 'dawnbringer-16',
    name: 'DawnBringer 16',
    colors: [
      '#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161',
      '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6',
    ],
  },
  {
    id: 'cga-16',
    name: 'CGA 16',
    colors: [
      '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
      '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
    ],
  },
  { id: 'grayscale-16', name: 'Grayscale 16', colors: ramp(16) },
  { id: 'one-bit', name: '1-bit Ink', colors: ['#0b0c10', '#f5f0e6'] },
  // Additions
  { id: 'grayscale-4', name: 'Grayscale 4', colors: ramp(4) },
  {
    id: 'arne-16',
    name: 'Arne 16',
    colors: [
      '#000000', '#9d9d9d', '#ffffff', '#be2633', '#e06f8b', '#493c2b', '#a46422', '#eb8931',
      '#f7e26b', '#2f484e', '#44891a', '#a3ce27', '#1b2632', '#005784', '#31a2f2', '#b2dcef',
    ],
  },
  {
    id: 'c64',
    name: 'Commodore 64',
    colors: [
      '#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
      '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#aaff66', '#0088ff', '#bbbbbb',
    ],
  },
];

export function builtinPalette(id: string): BuiltinPalette | undefined {
  return BUILTIN_PALETTES.find((p) => p.id === id);
}

export const FALLBACK_PARAM = {
  type: 'enum' as const,
  default: 'sweetie-16',
  label: 'Palette',
  group: 'Fallback palette',
  hint: 'Used when none is connected. Used only when no palette is wired in. Wire a Palette node to use your own or an extracted one.',
  options: BUILTIN_PALETTES.map((p) => ({ value: p.id, label: p.name })),
};

/** Colours to use: the wired palette, else the chosen built-in. */
export function resolvePalette(wired: { colors: [number, number, number][] } | null, fallbackId: string): [number, number, number][] {
  if (wired && wired.colors.length) return wired.colors;
  return (builtinPalette(fallbackId) ?? BUILTIN_PALETTES[0]).colors.map(hexToRgb);
}

export function paletteSummary(wired: boolean, fallbackId: string): string {
  // The summary cannot see wires, so it names the fallback that applies when nothing is connected.
  return wired ? 'palette wired' : `no palette wired → ${builtinPalette(fallbackId)?.name ?? fallbackId}`;
}
