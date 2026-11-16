/**
 * Boot guard: tells the next start whether the last run died or hung while it was starting or rendering.
 *
 * A small marker is written to localStorage when the app starts and whenever a render begins; it is removed when the first
 * frame (or any later render) finished, and when the page is left normally. A marker that is still there at the next start
 * means the last session never got to finish: the app then starts in SAFE MODE (rendering paused), so a value that makes
 * rendering hang cannot trap the owner in a freeze-on-open loop.
 *
 * Everything here is pure over a storage-like object and a clock, so it is unit-tested without a browser.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const GUARD_KEY = 'rsmps.guard';
/** Set by "Reload in safe mode": the next start is a safe start, once. */
export const FORCE_SAFE_KEY = 'rsmps.forceSafe';

export type SafeReason = 'unclean' | 'shift' | 'url' | 'manual';

export interface GuardMarker {
  /** ms since epoch when it was written. */
  at: number;
  /** 'boot' until the first frame, 'render' while an edit is being evaluated. */
  phase: 'boot' | 'render';
  /** Active project id when known. */
  project: string | null;
  session: string;
}

export interface BootDecision {
  safe: boolean;
  reason: SafeReason | null;
  /** The leftover marker of the previous run, if any (for the banner text). */
  previous: GuardMarker | null;
}

export function parseMarker(raw: string | null): GuardMarker | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<GuardMarker>;
    if (!m || typeof m.at !== 'number') return null;
    return { at: m.at, phase: m.phase === 'render' ? 'render' : 'boot', project: typeof m.project === 'string' ? m.project : null, session: typeof m.session === 'string' ? m.session : '' };
  } catch {
    return null;
  }
}

/** True for `?safe`, `?safe=1`, `&safe=true`; false for `?safe=0` / `?safe=false`. */
export function urlWantsSafe(search: string): boolean {
  const m = /[?&]safe(?:=([^&#]*))?/.exec(search);
  if (!m) return false;
  const v = (m[1] ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Pure decision. Precedence for the reported reason: URL, Shift, manual request, then an unclean previous run. */
export function decideBoot(input: { marker: GuardMarker | null; shift: boolean; urlSafe: boolean; manual: boolean }): BootDecision {
  const reason: SafeReason | null = input.urlSafe ? 'url' : input.shift ? 'shift' : input.manual ? 'manual' : input.marker ? 'unclean' : null;
  return { safe: reason !== null, reason, previous: input.marker };
}

export type GuardState = 'idle' | 'booting' | 'rendering' | 'safe';

export class BootGuard {
  state: GuardState = 'idle';
  private project: string | null = null;

  constructor(
    private storage: StorageLike,
    private now: () => number = () => Date.now(),
    private session: string = `s${Math.floor(Math.random() * 1e9).toString(36)}`,
  ) {}

  /** Read the previous run's marker, decide, and either stay safe (marker removed: nothing is rendering) or write the boot marker. */
  begin(input: { shift: boolean; urlSafe: boolean; project?: string | null }): BootDecision {
    const marker = parseMarker(this.read(GUARD_KEY));
    const manual = this.read(FORCE_SAFE_KEY) !== null;
    this.remove(FORCE_SAFE_KEY);
    const d = decideBoot({ marker, shift: input.shift, urlSafe: input.urlSafe, manual });
    this.project = input.project ?? null;
    if (d.safe) {
      this.state = 'safe';
      this.remove(GUARD_KEY);
    } else {
      this.state = 'booting';
      this.write('boot');
    }
    return d;
  }

  /** The active project became known (after the session was read). */
  setProject(id: string | null): void {
    this.project = id;
    if (this.state === 'booting') this.write('boot');
    else if (this.state === 'rendering') this.write('render');
  }

  /** An evaluation of changed content is about to run. Cheap when already marked. */
  renderStart(): void {
    if (this.state === 'idle') {
      this.state = 'rendering';
      this.write('render');
    }
  }

  /** An evaluation finished (first frame included). */
  renderDone(): void {
    if (this.state === 'booting' || this.state === 'rendering') {
      this.state = 'idle';
      this.remove(GUARD_KEY);
    }
  }

  /** The user left safe mode (Resume rendering). */
  resume(): void {
    if (this.state === 'safe') {
      this.state = 'idle';
      this.remove(GUARD_KEY);
    }
  }

  /** Back into safe mode without a reload (the user paused after a slow render). */
  enterSafe(): void {
    this.state = 'safe';
    this.remove(GUARD_KEY);
  }

  /** The page is being left in an orderly way (pagehide): not a crash. */
  leave(): void {
    this.remove(GUARD_KEY);
  }

  /** Make the next start a safe start (then reload). */
  requestSafeStart(): void {
    this.put(FORCE_SAFE_KEY, '1');
  }

  private write(phase: GuardMarker['phase']): void {
    const m: GuardMarker = { at: this.now(), phase, project: this.project, session: this.session };
    this.put(GUARD_KEY, JSON.stringify(m));
  }
  private read(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }
  private put(key: string, v: string): void {
    try {
      this.storage.setItem(key, v);
    } catch {
      /* storage blocked: the guard just does nothing */
    }
  }
  private remove(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
