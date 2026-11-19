/**
 * Render watchdog: notices a frame that will not finish. It watches the player's own "an evaluation is in flight since ..."
 * (`Player.renderingSince`), so it only ever counts time in which something is really being rendered:
 *   - about 1.5 s into one evaluation: "Rendering…" in the viewer;
 *   - about 5 s: the "Rendering is taking long" bar with Undo last change;
 *   - 15 s: rendering is paused (edits stay applied).
 * An idle player counts nothing, whatever was edited: moving a node, editing a branch that is not on screen, or switching
 * to another tab cannot trip it. Time spent in a hidden tab is not counted either (browsers stop drawing there).
 * It also clears the "pending edit" (kept in localStorage so a reload after a render that never finished can offer to revert it)
 * once a render has finished.
 */
import { useEffect } from 'react';
import { createStore } from './store/createStore';
import type { AppCtx } from './store/context';
import { PENDING_STORE_KEY, RENDER_LIMIT_MS, SLOW_NOTICE_MS, safetyStore, setPaused, undoLastChange } from './safety';

export const PENDING_KEY = PENDING_STORE_KEY; // localStorage: it must survive a restart (safe mode reads it)
export const watchStore = createStore<{ rendering: boolean }>({ rendering: false });
export const RENDERING_NOTICE_MS = 1500;
const TICK_MS = 500;

export interface PendingEdit {
  nodeId: string;
  key: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
  at: number;
}

export function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** What the watchdog remembers between looks. */
export interface WatchState {
  /** The evaluation being timed (its start, as the player reports it), or null. */
  job: number | null;
  /** Milliseconds of that evaluation seen while the tab was visible. */
  busyMs: number;
}

export type WatchLevel = 'idle' | 'working' | 'rendering' | 'slow' | 'stuck';

/**
 * One look at the player. `since` is `Player.renderingSince()`, `dt` the time since the last look. Pure.
 * A new evaluation starts the count again; no evaluation, paused rendering or a hidden tab count nothing.
 */
export function watchStep(prev: WatchState, input: { since: number | null; dt: number; hidden: boolean; paused: boolean }): { state: WatchState; level: WatchLevel } {
  if (input.since === null || input.paused) return { state: { job: null, busyMs: 0 }, level: 'idle' };
  const same = prev.job === input.since;
  const busyMs = (same ? prev.busyMs : 0) + (same && !input.hidden ? Math.max(0, input.dt) : 0);
  const level: WatchLevel = busyMs >= RENDER_LIMIT_MS ? 'stuck' : busyMs >= SLOW_NOTICE_MS ? 'slow' : busyMs >= RENDERING_NOTICE_MS ? 'rendering' : 'working';
  return { state: { job: input.since, busyMs }, level };
}

export function useRenderWatchdog(app: AppCtx): void {
  useEffect(() => {
    const { ed, io } = app;
    let state: WatchState = { job: null, busyMs: 0 };
    let last = performance.now();
    let seen = io.player.getState();

    const show = (rendering: boolean, slow: boolean) => {
      if (watchStore.get().rendering !== rendering) watchStore.set({ rendering });
      if (safetyStore.get().slow !== slow) safetyStore.set((s) => ({ ...s, slow }));
    };
    const timer = setInterval(() => {
      const now = performance.now();
      const step = watchStep(state, { since: io.player.renderingSince(), dt: now - last, hidden: typeof document !== 'undefined' && document.hidden, paused: safetyStore.get().paused });
      last = now;
      state = step.state;
      if (step.level === 'stuck') {
        // One frame has been rendering for 15 s with the page alive: stop rather than leave the owner waiting. Edits stay applied,
        // and the remembered edit is KEPT: "Undo last change" needs it.
        state = { job: null, busyMs: 0 };
        show(false, false);
        setPaused(app, true);
        ed.toast('One frame took more than 15 seconds to render, so rendering was paused. The last change may be too heavy.', 'error', [{ label: 'Undo last change', run: () => void undoLastChange(app) }]);
        return;
      }
      show(step.level === 'rendering' || step.level === 'slow', step.level === 'slow');
    }, TICK_MS);

    // A render finished (the player published fresh timings / errors): the last edit did not hang it.
    const offPlayer = io.player.subscribe((s) => {
      if ((s.timings !== seen.timings || s.errors !== seen.errors) && !safetyStore.get().paused) clearPending();
      seen = s;
    });
    return () => {
      clearInterval(timer);
      offPlayer();
      show(false, false);
    };
  }, [app]);
}
