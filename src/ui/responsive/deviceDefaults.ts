/**
 * Conservative performance defaults for small and weak devices. Pure decisions (tested) plus one `applyDeviceDefaults` that hands them
 * to the existing knobs: the player's preview scale (`io.player.setProxy`) and the memory governor's budgets (`io.memoryBudget`).
 * Nothing here overrides a choice the user made: a stored preview scale or memory budget always wins, and the defaults are applied
 * once per device.
 */
import type { Io } from '../../io/api';
import type { ViewportClass } from './breakpoints';

export type DeviceTier = 'low' | 'mid' | 'high';

export interface DeviceFacts {
  /** navigator.deviceMemory in GB (Chromium only, rounded, capped at 8). */
  deviceMemory?: number;
  cores?: number;
  cls: ViewportClass;
  coarse: boolean;
}

export function deviceTier(f: DeviceFacts): DeviceTier {
  const small = f.cls === 'phone';
  if (f.deviceMemory !== undefined && f.deviceMemory <= 2) return 'low';
  if (f.deviceMemory !== undefined && f.deviceMemory <= 4) return small || f.coarse ? 'low' : 'mid';
  if (f.cores !== undefined && f.cores <= 4) return small ? 'low' : 'mid';
  // a phone that tells us nothing (Safari, Firefox) is treated as mid-range at best
  if (small || f.coarse) return f.deviceMemory !== undefined && f.deviceMemory >= 8 && (f.cores ?? 0) >= 8 ? 'high' : 'mid';
  return 'high';
}

export type PreviewScale = 'auto' | number;

export interface DeviceDefaults {
  /** What the player's preview scale starts at. 'auto' = the player's own policy (lower only while playing). */
  previewScale: PreviewScale;
  /** GPU memory budget in MB, or null to keep the detected default. */
  gpuBudgetMB: number | null;
  /** System-RAM budget of the spill caches in MB, or null to keep the detected default. */
  ramBudgetMB: number | null;
}

export function deviceDefaults(tier: DeviceTier, cls: ViewportClass): DeviceDefaults {
  if (cls === 'phone') {
    return tier === 'low'
      ? { previewScale: 0.5, gpuBudgetMB: 256, ramBudgetMB: 384 }
      : { previewScale: 0.75, gpuBudgetMB: null, ramBudgetMB: tier === 'mid' ? 640 : null }; // even a strong phone starts below full scale (heat, battery); the sheet raises it
  }
  if (cls === 'tablet' && tier !== 'high') return { previewScale: tier === 'low' ? 0.5 : 0.75, gpuBudgetMB: tier === 'low' ? 256 : null, ramBudgetMB: tier === 'low' ? 512 : null };
  return { previewScale: 'auto', gpuBudgetMB: null, ramBudgetMB: null };
}

/** The choices the user can make in the "…" sheet. */
export const PREVIEW_SCALES: readonly PreviewScale[] = ['auto', 0.25, 0.5, 0.75, 1];
export const PREVIEW_KEY = 'rsmps.ui.previewScale';
const APPLIED_KEY = 'rsmps.ui.deviceDefaults';
const GPU_KEY = 'rsmpsMemoryBudgetMB'; // the governor's own storage keys (src/io/memory.ts)
const RAM_KEY = 'rsmpsRamBudgetMB';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function parsePreviewScale(raw: string | null | undefined): PreviewScale | null {
  if (raw === 'auto') return 'auto';
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0.05 && n <= 1 ? n : null;
}

export function loadPreviewScale(s: Pick<Storage, 'getItem'> | null): PreviewScale | null {
  try {
    return parsePreviewScale(s?.getItem(PREVIEW_KEY));
  } catch {
    return null;
  }
}

export function savePreviewScale(io: Pick<Io, 'player'>, scale: PreviewScale, s: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  io.player.setProxy(scale);
  try {
    s?.setItem(PREVIEW_KEY, String(scale));
  } catch {
    /* lasts for this session */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const MB = 1024 * 1024;

/**
 * At start-up: apply the user's preview scale if they chose one; otherwise, once, the device default. Memory budgets are set only
 * when the user never set one (the governor stores a chosen budget under its own key) and only once. Returns what was applied.
 */
export function applyDeviceDefaults(io: Pick<Io, 'player' | 'memoryBudget'>, facts: DeviceFacts, storage: Store | null = safeStorage()): { scale: PreviewScale; budgets: boolean } {
  const chosen = loadPreviewScale(storage);
  const tier = deviceTier(facts);
  const d = deviceDefaults(tier, facts.cls);
  const scale = chosen ?? d.previewScale;
  if (scale !== 'auto') io.player.setProxy(scale);
  let budgets = false;
  try {
    const done = storage?.getItem(APPLIED_KEY);
    if (!done && storage) {
      if (d.gpuBudgetMB !== null && storage.getItem(GPU_KEY) === null) {
        io.memoryBudget.set(d.gpuBudgetMB * MB);
        budgets = true;
      }
      if (d.ramBudgetMB !== null && storage.getItem(RAM_KEY) === null) {
        io.memoryBudget.ramBudget.set(d.ramBudgetMB * MB);
        budgets = true;
      }
      storage.setItem(APPLIED_KEY, JSON.stringify({ v: 1, tier, cls: facts.cls }));
    }
  } catch {
    /* no storage: the defaults apply on every start, which is harmless */
  }
  return { scale, budgets };
}
