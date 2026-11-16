/**
 * One GPU memory budget for everything that holds textures: the engine's node-result cache, the player's RAM frame cache,
 * decoded media, the idle pool and the working textures of an evaluation. `gpu.stats()` says what is really allocated; the
 * governor keeps allocated bytes under the budget by, in order: trimming idle pooled textures, shrinking the player's frame
 * cache, shrinking decoded media, and finally clearing the engine cache. All trimming goes through the evaluation gate, so it
 * never happens in the middle of an evaluation.
 */
import type { Gpu } from '../engine/gpu/gpu';

const MB = 1024 * 1024;
const STORAGE_KEY = 'rsmpsMemoryBudgetMB';

export type Mode = 'paused' | 'playing' | 'export';
export type Pressure = 'ok' | 'high' | 'critical';

export interface MemoryState {
  /** Everything this app has live on the GPU (textures of every kind, buffers). */
  allocatedBytes: number;
  budgetBytes: number;
  pressure: Pressure;
  /** System RAM used by the spill caches (compressed rendered frames, RAM tier of expensive results). */
  ramBytes?: number;
  /** System-RAM budget of those caches. */
  ramBudgetBytes?: number;
}

export interface AdapterHints {
  vendor?: string;
  architecture?: string;
  description?: string;
  /** navigator.deviceMemory in GB (rounded, max 8), if the browser reports it. */
  deviceMemoryGB?: number;
}

/** A conservative default: 768 MB for what looks like a discrete GPU, 384 MB for integrated or unknown. */
export function defaultBudget(h: AdapterHints): number {
  const text = `${h.vendor ?? ''} ${h.architecture ?? ''} ${h.description ?? ''}`.toLowerCase();
  const integrated = /intel|uhd|iris|apple|adreno|mali|powervr|integrated|graphics \d/.test(text) && !/arc|rtx|gtx|radeon rx|geforce/.test(text);
  const discrete = /nvidia|geforce|rtx|gtx|radeon rx|radeon pro|arc a/.test(text);
  if (h.deviceMemoryGB !== undefined && h.deviceMemoryGB <= 4) return 384 * MB;
  if (discrete && !integrated) return 768 * MB;
  return 384 * MB;
}

const STORAGE_RAM_KEY = 'rsmpsRamBudgetMB';

/**
 * System RAM the spill caches may use: 1.5 GB by default, less on machines that report little memory
 * (navigator.deviceMemory exists in Chromium only, capped at 8 GB by the browser; Firefox reports nothing and gets 1.5 GB).
 */
export function defaultRamBudget(deviceMemoryGB?: number): number {
  if (deviceMemoryGB === undefined) return 1536 * MB;
  return Math.max(256, Math.min(1536, Math.round(deviceMemoryGB * 1024 * 0.2))) * MB;
}

/** How the RAM budget is shared: finished frames for playback, and expensive node results demoted from the GPU. */
export function splitRam(total: number, mode: Mode): { frames: number; cold: number } {
  if (mode === 'export') return { frames: 0, cold: Math.round(total * 0.7) };
  return { frames: Math.round(total * 0.6), cold: Math.round(total * 0.4) };
}

export interface Split {
  /** Engine node-result cache. */
  engine: number;
  /** Player RAM frame cache of final frames. */
  player: number;
  /** Decoded media frames. */
  media: number;
  /** Idle textures the pool may keep. */
  idle: number;
}

/**
 * How the total is divided. The rest of the budget is the reserve for working textures of an evaluation.
 * Playing a heavy graph shrinks the RAM frame cache first; paused gives the engine cache the room.
 */
export function splitBudget(total: number, mode: Mode): Split {
  const f = (engine: number, player: number, media: number, idle: number): Split => ({
    engine: Math.round(total * engine),
    player: Math.round(total * player),
    media: Math.round(total * media),
    idle: Math.round(total * idle),
  });
  switch (mode) {
    case 'playing':
      return f(0.25, 0.12, 0.18, 0.12);
    case 'export':
      return f(0.3, 0, 0.15, 0.1);
    default:
      return f(0.4, 0.1, 0.12, 0.1);
  }
}

export function pressureOf(allocated: number, budget: number): Pressure {
  const r = allocated / Math.max(1, budget);
  return r >= 1 ? 'critical' : r >= 0.75 ? 'high' : 'ok';
}

export function readStoredBudget(storage: Pick<Storage, 'getItem'> | null): number | null {
  try {
    const v = Number(storage?.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v >= 64 ? Math.round(v) * MB : null;
  } catch {
    return null;
  }
}

export interface GovernorTargets {
  gpu: Gpu;
  /** Runs trimming between evaluations. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  setEngineBudget(bytes: number): void;
  clearEngine(): Promise<void>;
  setPlayerBudget(bytes: number): void;
  dropPlayerFrames(): void;
  setMediaBudget(bytes: number): void;
  dropMediaFrames(): void;
  isPlaying(): boolean;
  /** System-RAM caches (optional so older targets keep working). */
  setRamBudgets?(frames: number, cold: number): void;
  ramUsed?(): number;
  dropRam?(): void;
}

export class MemoryGovernor {
  private total: number;
  private manual: boolean;
  private mode: Mode = 'paused';
  private forced: Mode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private step = 0;
  private ramTotal: number;
  private ramManual: boolean;

  constructor(
    private t: GovernorTargets,
    private autoBytes: number,
    private storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
    private autoRamBytes: number = defaultRamBudget(),
  ) {
    const stored = readStoredBudget(storage);
    this.manual = stored !== null;
    this.total = stored ?? autoBytes;
    let ram: number | null = null;
    try {
      const v = Number(storage?.getItem(STORAGE_RAM_KEY));
      if (Number.isFinite(v) && v >= 64) ram = Math.round(v) * MB;
    } catch {
      /* storage blocked */
    }
    this.ramManual = ram !== null;
    this.ramTotal = ram ?? autoRamBytes;
    this.apply('paused');
  }

  /** System-RAM budget for the spill caches. */
  getRam(): number {
    return this.ramTotal;
  }

  setRam(bytes: number): void {
    this.ramTotal = Math.max(64 * MB, Math.round(bytes));
    this.ramManual = true;
    try {
      this.storage?.setItem(STORAGE_RAM_KEY, String(Math.round(this.ramTotal / MB)));
    } catch {
      /* the setting lasts for this session */
    }
    this.apply(this.mode);
  }

  autoRam(): void {
    this.ramTotal = this.autoRamBytes;
    this.ramManual = false;
    try {
      this.storage?.removeItem(STORAGE_RAM_KEY);
    } catch {
      /* ignore */
    }
    this.apply(this.mode);
  }

  get(): number {
    return this.total;
  }

  set(bytes: number): void {
    this.total = Math.max(64 * MB, Math.round(bytes));
    this.manual = true;
    try {
      this.storage?.setItem(STORAGE_KEY, String(Math.round(this.total / MB)));
    } catch {
      /* storage blocked: the setting lasts for this session */
    }
    this.apply(this.mode);
    void this.enforce();
  }

  auto(): void {
    this.total = this.autoBytes;
    this.manual = false;
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.apply(this.mode);
  }

  snapshot(): MemoryState {
    const allocatedBytes = this.t.gpu.allocatedBytes;
    return {
      allocatedBytes,
      budgetBytes: this.total,
      pressure: pressureOf(allocatedBytes, this.total),
      ramBytes: this.t.ramUsed?.() ?? 0,
      ramBudgetBytes: this.ramTotal,
    };
  }

  /** An export (or anything else heavy) asks for a mode for its duration. Returns the function that ends it. */
  enter(mode: Mode): () => void {
    this.forced.push(mode);
    this.apply(mode);
    return () => {
      const i = this.forced.lastIndexOf(mode);
      if (i >= 0) this.forced.splice(i, 1);
      this.apply(this.currentMode());
    };
  }

  private currentMode(): Mode {
    return this.forced[this.forced.length - 1] ?? (this.t.isPlaying() ? 'playing' : 'paused');
  }

  private apply(mode: Mode): void {
    this.mode = mode;
    const s = splitBudget(this.total, mode);
    this.t.setEngineBudget(s.engine);
    this.t.setPlayerBudget(s.player);
    this.t.setMediaBudget(s.media);
    const lim = (this.t.gpu as { limits?: { idleBytes: number; scratchBytes: number } }).limits;
    if (lim) {
      lim.idleBytes = Math.max(32 * MB, s.idle);
      lim.scratchBytes = Math.max(32 * MB, s.idle);
    }
    const r = splitRam(this.ramTotal, mode);
    this.t.setRamBudgets?.(r.frames, r.cold);
  }

  /** Start watching: rebalance when playback starts/stops, enforce the budget, free memory when the tab stays hidden. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const mode = this.currentMode();
      if (mode !== this.mode) this.apply(mode);
      void this.enforce();
    }, 1000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
        this.hiddenTimer = null;
        // A tab in the background for more than ~10 s gives its caches back.
        if (document.visibilityState === 'hidden') this.hiddenTimer = setTimeout(() => void this.freeMemory(), 10_000);
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Keep `allocated` under the budget: idle textures first, then the frame cache, decoded media, the engine cache. */
  async enforce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const idleCap = splitBudget(this.total, this.mode).idle;
      if (this.t.gpu.stats().idleBytes > idleCap) await this.t.exclusive(() => this.t.gpu.trimIdleTo(idleCap));
      if (this.t.gpu.allocatedBytes <= this.total) {
        this.step = 0;
        return;
      }
      await this.t.exclusive(() => this.t.gpu.trimIdleTo(0));
      if (this.t.gpu.allocatedBytes <= this.total) return;
      const steps = [
        () => this.t.dropPlayerFrames(),
        () => this.t.dropMediaFrames(),
        () => this.t.clearEngine(),
      ];
      // One step per tick, so a heavy graph is not thrashed: each gives memory back, then the pool is trimmed again.
      const fn = steps[Math.min(this.step, steps.length - 1)];
      this.step++;
      await fn();
      await this.t.exclusive(() => this.t.gpu.trimIdleTo(0));
    } finally {
      this.busy = false;
    }
  }

  /** Give everything back that can be rebuilt: frame caches, engine cache, idle textures. The picture on screen stays. */
  async freeMemory(): Promise<void> {
    this.t.dropPlayerFrames();
    this.t.dropMediaFrames();
    await this.t.clearEngine();
    await this.t.exclusive(() => this.t.gpu.trim());
    // The RAM tier is kept: it is what makes freeing GPU memory cheap (results come back from RAM instead of being recomputed).
    this.step = 0;
  }
}
