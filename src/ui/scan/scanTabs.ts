/**
 * The state of each scan project, kept OUTSIDE the Scan screen so it survives leaving it.
 *
 * The Scan screen is unmounted when another project tab (or the node graph) is shown. Its state used to live in the component,
 * so leaving cancelled a running scan and threw the analysed pages away, and coming back analysed every photo again. A `ScanTab`
 * holds what the screen shows for one scan project: the analysed result, the progress of a running scan, the saved session and
 * the timing. A scan started in a tab keeps running while another tab is open and its result is waiting when the owner returns.
 * A tab's state is dropped (and a running scan cancelled) only when its project is closed.
 *
 * The fields mirror what the component used (`{ current }` holders and setters that take a value or an updater), so the screen
 * reads and writes them exactly as it did its own state.
 */
import type { ScanPageState, ScanResult } from '../../io/api';
import { emptySession, type ScanSession } from './session';

export interface ScanProgress {
  names: string[];
  states: ScanPageState[];
  completed: number;
  total: number;
  concurrency: number;
}

type Update<T> = T | ((prev: T) => T);
const apply = <T>(prev: T, u: Update<T>): T => (typeof u === 'function' ? (u as (p: T) => T)(prev) : u);

export class ScanTab {
  /** What the progress bar says ("Looking for the page markers…"), or null when nothing runs. */
  busy: string | null = null;
  progress: ScanProgress | null = null;
  result: ScanResult | null = null;
  /** The same result, for code that must read the latest one from a callback. */
  readonly ref: { current: ScanResult | null } = { current: null };
  readonly session: { current: ScanSession } = { current: emptySession() };
  readonly timing: { current: { shootOn: number; holds: (number | null)[] } } = { current: { shootOn: 1, holds: [] } };
  readonly abortRef: { current: AbortController | null } = { current: null };
  /** The saved session was loaded (and the scan restored) for this tab: done once, not on every visit. */
  loaded = false;
  /** A project length the scan wants (the frames' running time), waiting until this project is the open one. */
  pendingDuration: number | null = null;
  private listeners = new Set<() => void>();

  constructor(readonly id: string) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  setBusy = (u: Update<string | null>): void => {
    this.busy = apply(this.busy, u);
    this.emit();
  };
  setProgress = (u: Update<ScanProgress | null>): void => {
    this.progress = apply(this.progress, u);
    this.emit();
  };
  /** Show another result; the one it replaces is disposed (its object URLs released) once the screen has let go of it. */
  setResult = (r: ScanResult | null): void => {
    const old = this.ref.current;
    this.ref.current = r;
    this.result = r;
    this.emit();
    if (old && old !== r) setTimeout(() => old.dispose(), 0);
  };

  /** The project was closed: cancel what runs and release the result. */
  dispose(): void {
    this.abortRef.current?.abort();
    this.abortRef.current = null;
    this.ref.current?.dispose();
    this.ref.current = null;
    this.result = null;
    this.listeners.clear();
  }
}

const tabs = new Map<string, ScanTab>();

/** The state of scan project `id` (made on first use). */
export function scanTab(id: string): ScanTab {
  let t = tabs.get(id);
  if (!t) tabs.set(id, (t = new ScanTab(id)));
  return t;
}

/** Drop the state of scan projects that are no longer open. Returns the ids dropped. */
export function pruneScanTabs(openIds: readonly string[]): string[] {
  const open = new Set(openIds);
  const dropped: string[] = [];
  for (const [id, t] of [...tabs]) {
    if (open.has(id)) continue;
    t.dispose();
    tabs.delete(id);
    dropped.push(id);
  }
  return dropped;
}

/** True while the scan of project `id` is working. */
export const scanBusy = (id: string): boolean => !!tabs.get(id)?.busy;

/**
 * What the progress bar shows. While photos are still being read it counts them; once every photo is read the scan is not
 * finished yet (the frames are cut out, straightened and stored), so it says so with a moving bar instead of standing at 100 %.
 */
export function scanBarState(busy: string | null, progress: ScanProgress | null): { percent: number | null; text: string } | null {
  if (!busy) return null;
  if (!progress) return { percent: null, text: busy };
  if (progress.completed >= progress.total) return { percent: null, text: `All ${progress.total} photo${progress.total === 1 ? '' : 's'} read. Putting the frames together…` };
  return { percent: Math.round((100 * progress.completed) / Math.max(1, progress.total)), text: `Scanning ${progress.completed} of ${progress.total} (${progress.concurrency} at a time)` };
}
