/**
 * What is known about each camera of this device, and the short plain names built from it.
 *
 * A web page is told very little: a label (on Android Chrome something like "camera2 0, facing back"), and, once a camera
 * has been opened, what it reports about itself (zoom range, largest picture, top frame rate, torch). It is NOT told which
 * lens a camera is (ultra wide, main, tele), so no name here claims one. The owner can name a camera after looking at its picture.
 * Measurements and names are kept in localStorage per camera id, so the names stay informative on later visits.
 */

export type Facing = 'front' | 'back' | 'unknown';

/** What a camera reported about itself (all optional: only what was measured). */
export interface CameraRecord {
  facing?: Facing;
  zoomMin?: number;
  zoomMax?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFps?: number;
  torch?: boolean;
  /** The label the browser gave it (kept so a later visit without permission can still name it). */
  label?: string;
  /** The name the owner gave it. */
  name?: string;
}

export type Catalogue = Record<string, CameraRecord>;

const KEY = 'rsmps.cameras.v1';

/** Facing from a browser label: Android Chrome says "camera2 0, facing back". */
export function facingOfLabel(label: string): Facing {
  const text = label || '';
  const m = /facing\s+(back|front|rear|environment|user)/i.exec(text);
  if (m) {
    const w = m[1].toLowerCase();
    return w === 'back' || w === 'rear' || w === 'environment' ? 'back' : 'front';
  }
  if (/\b(back|rear)\s+camera\b/i.test(text)) return 'back';
  if (/\b(front|selfie|facetime)\b/i.test(text)) return 'front';
  return 'unknown';
}

/** True for the machine-made Android labels ("camera2 0, facing back"), which say nothing a person would use. */
export function isMachineLabel(label: string): boolean {
  return /^camera2?\s*\d+\s*,/i.test((label || '').trim());
}

export function facingOfSettings(settings: Record<string, unknown> | null | undefined, caps: Record<string, unknown> | null | undefined): Facing {
  const s = settings?.facingMode;
  const c = caps?.facingMode;
  const w = String(typeof s === 'string' ? s : Array.isArray(c) ? (c[0] ?? '') : (c ?? '')).toLowerCase();
  return w === 'environment' ? 'back' : w === 'user' ? 'front' : 'unknown';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const maxOf = (v: unknown): number | undefined => num((v as { max?: unknown } | null | undefined)?.max);
const minOf = (v: unknown): number | undefined => num((v as { min?: unknown } | null | undefined)?.min);

/** What an open camera track reports. Returns only what it said. */
export function recordFromTrack(caps: Record<string, unknown> | null | undefined, settings: Record<string, unknown> | null | undefined): CameraRecord {
  const out: CameraRecord = {};
  const facing = facingOfSettings(settings, caps);
  if (facing !== 'unknown') out.facing = facing;
  const z = caps?.zoom;
  if (z && typeof z === 'object') {
    out.zoomMin = minOf(z);
    out.zoomMax = maxOf(z);
  }
  out.maxWidth = maxOf(caps?.width);
  out.maxHeight = maxOf(caps?.height);
  out.maxFps = maxOf(caps?.frameRate);
  if (caps && 'torch' in caps) out.torch = !!caps.torch;
  for (const k of Object.keys(out) as (keyof CameraRecord)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/* ---------------------------------------- storage ---------------------------------------- */

let cache: Catalogue | null = null;
const listeners = new Set<() => void>();

export function loadCatalogue(): Catalogue {
  if (cache) return cache;
  let out: Catalogue = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out = parsed as Catalogue;
  } catch {
    /* storage blocked or damaged: start empty */
  }
  cache = out;
  return out;
}

function save(): void {
  try {
    if (typeof localStorage !== 'undefined' && cache) localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private window or full: the names just do not persist */
  }
  listeners.forEach((l) => l());
}

/** For tests: forget the in-memory copy so the next read goes to storage again. */
export function resetCatalogueCache(): void {
  cache = null;
}

export function onCatalogueChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Merge what a camera reported into its record (refreshes on every open). */
export function noteCamera(id: string, patch: CameraRecord): void {
  if (!id) return;
  const cat = loadCatalogue();
  const old = cat[id] ?? {};
  const next: CameraRecord = { ...old, ...patch };
  if (JSON.stringify(next) === JSON.stringify(old)) return;
  cat[id] = next;
  save();
}

/** Give a camera a name of the owner's choosing (empty clears it). */
export function renameCamera(id: string, name: string): void {
  if (!id) return;
  const cat = loadCatalogue();
  const clean = name.trim().slice(0, 40);
  const next: CameraRecord = { ...(cat[id] ?? {}) };
  if (clean) next.name = clean;
  else delete next.name;
  cat[id] = next;
  save();
}

/** The side of a camera by id, from what is known (the label the browser gave, or a measurement). */
export function facingOfId(id: string, cat: Catalogue = loadCatalogue()): Facing {
  const r = cat[id];
  if (!r) return 'unknown';
  return r.facing && r.facing !== 'unknown' ? r.facing : facingOfLabel(r.label ?? '');
}

/* ----------------------------------------- names ----------------------------------------- */

const fmtX = (v: number): string => String(Math.round(v * 100) / 100);

/** "12 MP" from the largest picture, or '' when not measured. */
export function megapixels(r: CameraRecord | undefined): string {
  if (!r?.maxWidth || !r.maxHeight) return '';
  const mp = (r.maxWidth * r.maxHeight) / 1e6;
  return mp >= 1 ? `${Math.round(mp)} MP` : '';
}

/** "zoom 0.6x–10x" when the camera reported a zoom range (a range, not a claim about the lens). */
export function zoomRange(r: CameraRecord | undefined): string {
  if (r?.zoomMin === undefined || r.zoomMax === undefined || r.zoomMax <= r.zoomMin) return '';
  return `zoom ${fmtX(r.zoomMin)}x–${fmtX(r.zoomMax)}x`;
}

export interface NamedDevice {
  id: string;
  /** The browser's own label ('' before permission). */
  label: string;
}

/**
 * Short plain names for a list of cameras, in the order given.
 * - the owner's own name wins;
 * - a camera whose side is known: "Back · zoom 0.6x–10x · 12 MP" (measured) or "Back camera 2" (not measured yet);
 *   the number only appears when more than one camera faces that way;
 * - a camera with a real label (desktop webcams): the label;
 * - otherwise "Camera 1", "Camera 2", ...
 */
export function nameCameras(devices: NamedDevice[], cat: Catalogue = loadCatalogue()): { id: string; label: string }[] {
  const facingOf = (d: NamedDevice): Facing => {
    const f = facingOfLabel(d.label);
    return f !== 'unknown' ? f : facingOfId(d.id, cat);
  };
  const count: Record<string, number> = {};
  for (const d of devices) count[facingOf(d)] = (count[facingOf(d)] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return devices.map((d, i) => {
    const rec = cat[d.id];
    const facing = facingOf(d);
    seen[facing] = (seen[facing] ?? 0) + 1;
    if (rec?.name) return { id: d.id, label: rec.name };
    if (facing !== 'unknown') {
      const side = facing === 'back' ? 'Back' : 'Front';
      const n = count[facing] > 1 ? ` ${seen[facing]}` : '';
      const details = [zoomRange(rec), megapixels(rec)].filter(Boolean);
      return { id: d.id, label: details.length ? `${side}${n} · ${details.join(' · ')}` : `${side} camera${n}` };
    }
    const label = d.label || rec?.label || '';
    if (label && !isMachineLabel(label)) return { id: d.id, label };
    return { id: d.id, label: `Camera ${i + 1}` };
  });
}
