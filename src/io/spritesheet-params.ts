/**
 * The Output node's sprite sheet / game export parameters, read the same way by the app exporter and the CLI (pure).
 * The "For" preset is applied here, so both paths agree on what a preset means.
 */
import type { SheetTag } from '../engine/lib/sprite-sheet';
import type { SheetMetaFormat } from './spritesheet-meta';
import type { SheetBuildOptions, SheetLayoutMode, SheetBuild } from './spritesheet-pack';
import { applyPreset, isPreset, type EnginePreset, type SheetSettings } from './spritesheet-presets';
import type { SheetLayout } from './spritesheet';

export interface SheetParams extends SheetSettings {
  preset: EnginePreset;
  /** Animation name for the tag; empty = the source file name. */
  animName: string;
  /** 'clip': one sheet per batch item holding its frames. 'batch': ONE sheet holding every item, one tag per item. */
  from: 'clip' | 'batch';
  /** Pivot to write into the metadata, 0..1 in the original frame; null = not written. */
  pivot: [number, number] | null;
  /** The Output's own bleed switch also applies to stills (PNG only). */
  bleedStills: boolean;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function readSheetParams(p: Record<string, unknown>): SheetParams {
  const preset = isPreset(p.preset) ? p.preset : 'generic';
  const base: SheetSettings = {
    layout: oneOf<SheetLayoutMode>(p.sheetLayout, ['grid', 'row', 'column', 'pack'], 'grid'),
    columns: Math.max(0, Math.round(num(p.columns, 0))),
    padding: Math.max(0, Math.round(num(p.padding, 0))),
    extrude: Math.max(0, Math.round(num(p.extrude, 0))),
    trim: p.sheetTrim === true,
    powerOfTwo: p.powerOfTwo === true,
    maxSize: Math.max(0, Math.round(num(p.maxSheet, 0))),
    bleed: p.bleed === true,
    meta: oneOf<SheetMetaFormat>(p.sheetMeta, ['none', 'json', 'aseprite', 'texturepacker', 'css'], 'json'),
  };
  const s = applyPreset(preset, base);
  const pv = Array.isArray(p.pivot) && p.pivot.length >= 2 ? ([num(p.pivot[0], 0.5), num(p.pivot[1], 0.5)] as [number, number]) : ([0.5, 0.5] as [number, number]);
  return {
    ...s,
    preset,
    animName: typeof p.animName === 'string' ? p.animName.trim() : '',
    from: p.sheetFrom === 'batch' ? 'batch' : 'clip',
    pivot: p.pivotOn === true ? pv : null,
    bleedStills: s.bleed,
  };
}

export function buildOptionsOf(s: SheetParams): SheetBuildOptions {
  return { layout: s.layout, columns: s.columns, padding: s.padding, extrude: s.extrude, trim: s.trim, powerOfTwo: s.powerOfTwo, maxSize: s.maxSize, bleed: s.bleed };
}

/** True when the plain grid (GPU copy, no readback) cannot do what the settings ask. */
export function needsCpuSheet(s: SheetParams): boolean {
  return s.layout === 'row' || s.layout === 'column' || s.layout === 'pack' || s.extrude > 0 || s.trim || s.powerOfTwo || s.maxSize > 0 || s.bleed || s.from === 'batch';
}

/** The metadata description of a plain grid layout (no pixels), so the GPU path can use the same writers. */
export function buildOfLayout(layout: SheetLayout): SheetBuild {
  return {
    pages: [{ index: 0, width: layout.width, height: layout.height, data: new Uint8ClampedArray(0) }],
    frames: layout.rects.map((r, index) => ({ index, page: 0, x: r.x, y: r.y, w: r.w, h: r.h, offX: 0, offY: 0, srcW: r.w, srcH: r.h })),
    columns: layout.columns,
    rows: layout.rows,
    cellWidth: layout.frameWidth,
    cellHeight: layout.frameHeight,
  };
}

/** Tags of a sheet: one per clip (`clips`: name and frame count, in sheet order). */
export function tagsOfClips(clips: { name: string; frames: number }[]): SheetTag[] {
  const tags: SheetTag[] = [];
  let at = 0;
  for (const c of clips) {
    if (c.frames > 0) tags.push({ name: c.name, from: at, to: at + c.frames - 1, direction: 'forward' });
    at += c.frames;
  }
  return tags;
}
