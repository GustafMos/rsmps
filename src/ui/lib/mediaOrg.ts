/**
 * Media bins: the pure model behind the folders in the media panel. A project keeps `MediaOrg` (bins plus asset id -> bin id) in
 * its document, so bins travel with the project file. The asset library itself is shared by every project tab and knows nothing
 * of bins. Every function returns the SAME object when nothing changed, and ignores ids that no longer exist.
 */
import type { MediaBin, MediaOrg } from '../../engine/types';

/** Small accent palette for the bin dot. Index 0 is plain grey; the rest stay quiet next to the greyscale chrome. */
export const BIN_COLORS = ['#8a909b', '#c9ced8', '#7b8dff', '#5fd68a', '#f5c542', '#f28b4b', '#ef6f9c', '#2ec4b6'] as const;

export const EMPTY_ORG: MediaOrg = { bins: [], assign: {} };

export const binColor = (i: number): string => BIN_COLORS[((i % BIN_COLORS.length) + BIN_COLORS.length) % BIN_COLORS.length];

/** Name that is not used by another bin ("Bin", "Bin 2", ...). */
export function uniqueBinName(org: MediaOrg, base: string, ignoreId?: string): string {
  const clean = base.trim() || 'Bin';
  const taken = new Set(org.bins.filter((b) => b.id !== ignoreId).map((b) => b.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const name = `${clean} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function createBin(org: MediaOrg, id: string, name = 'New bin'): { org: MediaOrg; bin: MediaBin } {
  const bin: MediaBin = { id, name: uniqueBinName(org, name), color: org.bins.length % BIN_COLORS.length };
  return { org: { ...org, bins: [...org.bins, bin] }, bin };
}

export function renameBin(org: MediaOrg, id: string, name: string): MediaOrg {
  const bin = org.bins.find((b) => b.id === id);
  const clean = name.trim();
  if (!bin || !clean || clean === bin.name) return org;
  const next = uniqueBinName(org, clean, id);
  return { ...org, bins: org.bins.map((b) => (b.id === id ? { ...b, name: next } : b)) };
}

export function recolorBin(org: MediaOrg, id: string, color: number): MediaOrg {
  const bin = org.bins.find((b) => b.id === id);
  if (!bin || bin.color === color) return org;
  return { ...org, bins: org.bins.map((b) => (b.id === id ? { ...b, color } : b)) };
}

/** Delete a bin. Its assets are NOT deleted: they fall back to Unsorted. */
export function deleteBin(org: MediaOrg, id: string): MediaOrg {
  if (!org.bins.some((b) => b.id === id)) return org;
  const assign: Record<string, string> = {};
  for (const [a, b] of Object.entries(org.assign)) if (b !== id) assign[a] = b;
  return { bins: org.bins.filter((b) => b.id !== id), assign };
}

/** Put assets in a bin, or back to Unsorted with `null`. A bin id that does not exist counts as Unsorted. */
export function moveToBin(org: MediaOrg, ids: readonly string[], binId: string | null): MediaOrg {
  const target = binId && org.bins.some((b) => b.id === binId) ? binId : null;
  let changed = false;
  const assign = { ...org.assign };
  for (const id of ids) {
    if (target) {
      if (assign[id] !== target) {
        assign[id] = target;
        changed = true;
      }
    } else if (id in assign) {
      delete assign[id];
      changed = true;
    }
  }
  return changed ? { ...org, assign } : org;
}

/** The bin an asset sits in, or null (Unsorted; also when the recorded bin is gone). */
export function binOf(org: MediaOrg | undefined, assetId: string): string | null {
  const b = org?.assign[assetId];
  return b && org!.bins.some((x) => x.id === b) ? b : null;
}

/** Forget assignments of assets that are no longer in the library (and of bins that are gone). */
export function pruneOrg(org: MediaOrg, existing: ReadonlySet<string>): MediaOrg {
  const bins = new Set(org.bins.map((b) => b.id));
  let dirty = false;
  const assign: Record<string, string> = {};
  for (const [a, b] of Object.entries(org.assign)) {
    if (existing.has(a) && bins.has(b)) assign[a] = b;
    else dirty = true;
  }
  return dirty ? { ...org, assign } : org;
}

/** Make a loaded value safe: a damaged `media` field becomes an empty one. */
export function normalizeOrg(raw: unknown): MediaOrg {
  if (!raw || typeof raw !== 'object') return EMPTY_ORG;
  const r = raw as { bins?: unknown; assign?: unknown };
  const bins = Array.isArray(r.bins) ? r.bins.filter((b): b is MediaBin => !!b && typeof (b as MediaBin).id === 'string' && typeof (b as MediaBin).name === 'string').map((b) => ({ id: b.id, name: b.name, color: Number.isFinite(b.color) ? b.color : 0 })) : [];
  const assign: Record<string, string> = {};
  if (r.assign && typeof r.assign === 'object') for (const [a, b] of Object.entries(r.assign)) if (typeof b === 'string') assign[a] = b;
  return bins.length || Object.keys(assign).length ? { bins, assign } : EMPTY_ORG;
}
