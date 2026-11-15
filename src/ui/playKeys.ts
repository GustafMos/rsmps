/**
 * Computer keyboard as a MIDI keyboard for the selected `playable` node. Capture-phase, so these keys win over
 * the global shortcuts, but ONLY while exactly one playable node is selected (the UI shows a chip saying so).
 */
import { useEffect } from 'react';
import { clampOctave, keyAction, octaveBaseNote, stepVelocity } from '../engine/audio/keyboard-map';
import { isTypingTarget } from './lib/drag';
import { createStore } from './store/createStore';
import { useApp, useEd, type AppCtx } from './store/context';

export const pianoStore = createStore<{ node: string | null; notes: ReadonlySet<number> }>({ node: null, notes: new Set() });

/** Id of the selected playable node, or null. */
export function useKeyboardTarget(): string | null {
  const { io } = useApp();
  return useEd((s) => {
    if (s.selection.length !== 1) return null;
    const n = s.graph.nodes.find((x) => x.id === s.selection[0]);
    return n && io.registry.get(n.type)?.playable ? n.id : null;
  });
}

const held = new Map<string, { note: number; node: string }>();

function setLit(node: string, note: number, on: boolean) {
  const cur = pianoStore.get();
  const notes = new Set(cur.node === node ? cur.notes : []);
  if (on) notes.add(note);
  else notes.delete(note);
  pianoStore.set({ node: notes.size || on ? node : null, notes });
}

/** Note on/off from either the computer keyboard or the on-screen piano (`source` identifies the holder). */
export function playNote(app: AppCtx, source: string, node: string, note: number, on: boolean): void {
  if (on) {
    if (held.has(source)) return;
    held.set(source, { note, node });
    app.io.audio.sendNote(node, note, 1, true);
    setLit(node, note, true);
  } else {
    const h = held.get(source);
    if (!h) return;
    held.delete(source);
    app.io.audio.sendNote(h.node, h.note, 1, false);
    setLit(h.node, h.note, false);
  }
}

export function releaseAll(app: AppCtx): void {
  for (const source of [...held.keys()]) playNote(app, source, '', 0, false);
}

export function usePlayKeys(app: AppCtx): void {
  useEffect(() => {
    const { ed, io } = app;
    const target = (): string | null => {
      const s = ed.state;
      if (s.selection.length !== 1) return null;
      const n = s.graph.nodes.find((x) => x.id === s.selection[0]);
      return n && io.registry.get(n.type)?.playable ? n.id : null;
    };
    const keydown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || document.querySelector('.rs-dlg')) return;
      const id = target();
      if (!id) return;
      const action = keyAction(e.code);
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const node = ed.state.graph.nodes.find((n) => n.id === id)!;
      const def = io.registry.get(node.type)!;
      const octave = clampOctave(Number(node.params.baseOctave ?? 5));
      if (action.kind === 'note') {
        const note = octaveBaseNote(octave) + action.semitone;
        if (note <= 127) playNote(app, e.code, id, note, true);
      } else if (action.kind === 'octave' || action.kind === 'octave-step') {
        if ('baseOctave' in def.params) ed.setParam(id, 'baseOctave', clampOctave(action.kind === 'octave' ? action.value : octave + action.delta));
      } else if ('velocity' in def.params) {
        ed.setParam(id, 'velocity', stepVelocity(Number(node.params.velocity ?? 0.8), action.delta));
      }
    };
    const keyup = (e: KeyboardEvent) => playNote(app, e.code, '', 0, false);
    const blur = () => releaseAll(app);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', blur);
    // deselecting (or selecting another node) releases everything: no stuck notes
    let last = target();
    const unsub = ed.store.subscribe(() => {
      const t = target();
      if (t !== last) {
        last = t;
        releaseAll(app);
      }
    });
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', blur);
      unsub();
      releaseAll(app);
    };
  }, [app]);
}
