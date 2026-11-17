/**
 * "For" presets of the Output node: starting points, not promises about an engine's current UI. Each preset only sets the sheet fields below
 * (the file format is always PNG with straight alpha; the nearest-neighbour enlargement stays the user's choice because it depends on the art size).
 * `generic` leaves everything as the user set it.
 */
import type { SheetMetaFormat } from './spritesheet-meta';
import type { SheetLayoutMode } from './spritesheet-pack';

export type EnginePreset = 'generic' | 'godot' | 'unity' | 'gamemaker' | 'rpgmaker' | 'web';
export const ENGINE_PRESETS: readonly EnginePreset[] = ['generic', 'godot', 'unity', 'gamemaker', 'rpgmaker', 'web'];

export interface SheetSettings {
  layout: SheetLayoutMode;
  columns: number;
  padding: number;
  extrude: number;
  trim: boolean;
  powerOfTwo: boolean;
  maxSize: number;
  bleed: boolean;
  meta: SheetMetaFormat;
}

/** Fields a preset forces. Anything not listed keeps the Output node's own value. */
export const PRESET_FIELDS: Record<Exclude<EnginePreset, 'generic'>, Partial<SheetSettings>> = {
  // Godot reads a PNG as a texture; frames are cut with AtlasTexture regions (script in docs/GAME_ASSETS.md). No power of two needed.
  godot: { layout: 'grid', trim: false, powerOfTwo: false, padding: 0, extrude: 0, bleed: true, meta: 'json' },
  // Unity: power-of-two pages import without a resize prompt for compressed formats; slice with Grid By Cell Size or from the JSON.
  unity: { layout: 'grid', trim: false, powerOfTwo: true, padding: 0, extrude: 0, bleed: true, meta: 'json' },
  // GameMaker imports a strip (one row of equal frames).
  gamemaker: { layout: 'row', trim: false, powerOfTwo: false, padding: 0, extrude: 0, bleed: true, meta: 'none' },
  // RPG Maker MV / MZ character sheets are 3 columns (walk cycle) by 4 rows (down, left, right, up) of equal frames.
  rpgmaker: { layout: 'grid', columns: 3, trim: false, powerOfTwo: false, padding: 0, extrude: 0, bleed: false, meta: 'none' },
  // A web page: a stylesheet with one class per frame and one @keyframes per animation.
  web: { layout: 'grid', trim: false, powerOfTwo: false, padding: 0, extrude: 0, bleed: true, meta: 'css' },
};

export function applyPreset(preset: EnginePreset | string, s: SheetSettings): SheetSettings {
  if (preset === 'generic' || !(preset in PRESET_FIELDS)) return s;
  return { ...s, ...PRESET_FIELDS[preset as keyof typeof PRESET_FIELDS] };
}

export function isPreset(v: unknown): v is EnginePreset {
  return typeof v === 'string' && (ENGINE_PRESETS as readonly string[]).includes(v);
}
