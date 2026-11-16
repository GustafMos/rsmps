/**
 * Render watchdog. A graph edit starts a timer; the player finishing an evaluation (it publishes a fresh timings/errors
 * map) stops it. Slow: show "Rendering…" in the viewer after ~1.5 s and offer to undo the last change after ~5 s.
 * It also keeps a "pending edit" in localStorage so a reload after a render that never finished can offer to revert it.
 */
import { useEffect } from 'react';
import { createStore } from './store/createStore';
import type { AppCtx } from './store/context';
import type { GraphDoc } from '../engine/types';
import { PENDING_STORE_KEY, RENDER_LIMIT_MS, SLOW_NOTICE_MS, safetyStore, setPaused, undoLastChange } from './safety';

export const PENDING_KEY = PENDING_STORE_KEY; // localStorage: it must survive a restart (safe mode reads it)
export const watchStore = createStore<{ rendering: boolean }>({ rendering: false });

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

export function useRenderWatchdog(app: AppCtx): void {
  useEffect(() => {
    const { ed, io } = app;
    let lastGraph: GraphDoc = ed.state.graph;
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    let t3: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    let seen = io.player.getState();

    const done = () => {
      waiting = false;
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      if (safetyStore.get().slow) safetyStore.set((s) => ({ ...s, slow: false }));
      if (watchStore.get().rendering) watchStore.set({ rendering: false });
      clearPending();
    };
    const start = () => {
      done();
      if (safetyStore.get().paused || !ed.state.viewedNodeId || !io.player.getState().imageSize) return;
      waiting = true;
      t1 = setTimeout(() => waiting && watchStore.set({ rendering: true }), 1500);
      t2 = setTimeout(() => {
        if (!waiting) return;
        safetyStore.set((s) => (s.slow ? s : { ...s, slow: true })); // the "Rendering is taking long" bar (SafetyBar in App.tsx)
      }, SLOW_NOTICE_MS);
      t3 = setTimeout(() => {
        // Past the limit with the page still alive: stop rendering rather than leave the owner waiting. Edits stay applied.
        if (!waiting) return;
        setPaused(app, true);
        ed.toast('Rendering took more than 15 seconds and was paused. The last change may be too heavy.', 'error', [
          { label: 'Undo last change', run: () => void undoLastChange(app) },
        ]);
        // stop waiting but KEEP the remembered edit: "Undo last change" needs it
        waiting = false;
        clearTimeout(t1);
        clearTimeout(t2);
        if (watchStore.get().rendering) watchStore.set({ rendering: false });
        if (safetyStore.get().slow) safetyStore.set((s) => ({ ...s, slow: false }));
      }, RENDER_LIMIT_MS);
    };

    const offStore = ed.store.subscribe(() => {
      const g = ed.state.graph;
      if (g !== lastGraph) {
        lastGraph = g;
        start();
      }
    });
    const offPlayer = io.player.subscribe((s) => {
      if (waiting && (s.timings !== seen.timings || s.errors !== seen.errors)) done();
      seen = s;
    });
    return () => {
      offStore();
      offPlayer();
      done();
    };
  }, [app]);
}
