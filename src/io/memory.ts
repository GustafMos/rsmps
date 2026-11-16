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
  allocatedBytes: number;
  budgetBytes: number;
  pressure: Pressure;
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

  constructor(
    private t: GovernorTargets,
    private autoBytes: number,
    private storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {
    const stored = readStoredBudget(storage);
    this.manual = stored !== null;
    this.total = stored ?? autoBytes;
    this.apply('paused');
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
    return { allocatedBytes, budgetBytes: this.total, pressure: pressureOf(allocatedBytes, this.total) };
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
    this.step = 0;
  }
}
