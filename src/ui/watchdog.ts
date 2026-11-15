/**
 * Render watchdog. A graph edit starts a timer; the player finishing an evaluation (it publishes a fresh timings/errors
 * map) stops it. Slow: show "Rendering…" in the viewer after ~1.5 s and offer to undo the last change after ~5 s.
 * It also keeps a "pending edit" in sessionStorage so a reload after a render that never finished can offer to revert it.
 */
import { useEffect } from 'react';
import { createStore } from './store/createStore';
import type { AppCtx } from './store/context';
import type { GraphDoc } from '../engine/types';

export const PENDING_KEY = 'rsmps.pendingEdit';
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
    sessionStorage.removeItem(PENDING_KEY);
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
    let waiting = false;
    let seen = io.player.getState();

    const done = () => {
      waiting = false;
      clearTimeout(t1);
      clearTimeout(t2);
      if (watchStore.get().rendering) watchStore.set({ rendering: false });
      clearPending();
    };
    const start = () => {
      done();
      if (!ed.state.viewedNodeId) return;
      waiting = true;
      t1 = setTimeout(() => waiting && watchStore.set({ rendering: true }), 1500);
      t2 = setTimeout(() => {
        if (!waiting) return;
        ed.toast('Rendering is taking a long time. The last change may be too heavy.', 'error', [
          { label: 'Undo last change', run: () => { ed.undo(); done(); } },
        ]);
      }, 5000);
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
