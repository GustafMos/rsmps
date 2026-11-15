/**
 * ONE table of every keyboard command: id, label, group, default bindings and handler.
 * It drives the key handling, the cheat-sheet and the key-binding editor. Node hotkeys
 * ("add:<node id>") are generated from the user's assignments and the registry.
 */
import { useEffect } from 'react';
import { frameGraph } from './graph/gestures';
import { isTypingTarget } from './lib/drag';
import { NODE_DEFAULTS, NODE_PREFIX, bindingsOf, eventToBinding, overrideIds, setDefaultsLookup } from './keymap';
import type { AppCtx } from './store/context';

export interface KeyCtx {
  app: AppCtx;
  e: KeyboardEvent;
  /** The pointer is over the node graph. */
  hover: boolean;
  binding: string;
}

export interface Command {
  id: string;
  label: string;
  group: 'Add nodes' | 'Edit' | 'Graph' | 'Playback' | 'View' | 'File';
  defaults: string[];
  run: (c: KeyCtx) => void;
  /** Fires on key release (used by Space, which pans the graph while held). */
  up?: (c: { app: AppCtx; e: KeyboardEvent }) => void;
}

const sel = (a: AppCtx) => a.ed.state.selection;

function openAdd(c: KeyCtx, quick: boolean) {
  const { ed, graphCtl: ctl } = c.app;
  const r = ctl.rect();
  const cx = c.hover ? ctl.pointer.x : r.left + r.width / 2;
  const cy = c.hover ? ctl.pointer.y : r.top + r.height / 2;
  ed.openAddMenu({ clientX: cx, clientY: cy, world: ctl.toWorld(cx, cy), quick });
}

export const COMMANDS: Command[] = [
  { id: 'add.menu', label: 'Add node menu', group: 'Add nodes', defaults: ['Shift+A'], run: (c) => openAdd(c, false) },
  { id: 'add.quick', label: 'Quick add: search and add a node', group: 'Add nodes', defaults: ['Shift+Space'], run: (c) => openAdd(c, true) },

  { id: 'edit.undo', label: 'Undo', group: 'Edit', defaults: ['Ctrl+Z'], run: (c) => c.app.ed.undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', defaults: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: (c) => c.app.ed.redo() },
  { id: 'edit.copy', label: 'Copy nodes', group: 'Edit', defaults: ['Ctrl+C'], run: (c) => c.app.ed.copy() },
  {
    id: 'edit.paste',
    label: 'Paste nodes',
    group: 'Edit',
    defaults: ['Ctrl+V'],
    run: (c) => c.app.ed.paste(c.hover ? c.app.graphCtl.toWorld(c.app.graphCtl.pointer.x, c.app.graphCtl.pointer.y) : undefined),
  },
  { id: 'edit.duplicate', label: 'Duplicate nodes', group: 'Edit', defaults: ['Ctrl+D'], run: (c) => c.app.ed.duplicate() },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', defaults: ['Ctrl+A'], run: (c) => c.app.ed.selectAll() },
  { id: 'edit.delete', label: 'Delete selection (heals the chain)', group: 'Edit', defaults: ['Delete', 'Backspace'], run: (c) => c.app.ed.deleteSelection() },
  {
    id: 'edit.deselect',
    label: 'Close menus / clear selection',
    group: 'Edit',
    defaults: ['Escape'],
    run: ({ app }) => {
      app.ed.openAddMenu(null);
      app.ed.openContextMenu(null);
      if (sel(app).length) app.ed.select([]);
    },
  },

  { id: 'graph.group', label: 'Group selection in a frame', group: 'Graph', defaults: ['Ctrl+G'], run: (c) => c.app.ed.groupSelection() },
  {
    id: 'graph.ungroup',
    label: 'Ungroup the selected frame',
    group: 'Graph',
    defaults: ['Ctrl+Shift+G'],
    run: ({ app }) => app.ed.state.selectedFrame && app.ed.ungroup(app.ed.state.selectedFrame),
  },
  { id: 'graph.unframe', label: 'Remove selection from its frame', group: 'Graph', defaults: ['Ctrl+Alt+G'], run: (c) => c.app.ed.removeFromFrame(sel(c.app)) },
  { id: 'graph.frame', label: 'Frame all (or selection)', group: 'Graph', defaults: ['F', 'Home'], run: ({ app }) => frameGraph(app, sel(app).length > 0) },
  { id: 'graph.bypass', label: 'Bypass selected nodes', group: 'Graph', defaults: ['B'], run: ({ app }) => sel(app).forEach((id) => app.ed.toggleBypass(id)) },
  { id: 'graph.collapse', label: 'Collapse / expand selected nodes', group: 'Graph', defaults: ['H'], run: ({ app }) => sel(app).length && app.ed.toggleCollapse(sel(app)) },
  { id: 'graph.layout', label: 'Auto-layout', group: 'Graph', defaults: ['L'], run: (c) => c.app.ed.autoLayout(true) },

  {
    id: 'play.toggle',
    label: 'Play / pause (hold over the graph to pan)',
    group: 'Playback',
    defaults: ['Space'],
    run: ({ app, hover, binding }) => {
      const { io, graphCtl: ctl } = app;
      if (hover) {
        ctl.spaceDown = true;
        ctl.spaceUsed = false;
        ctl.spaceKey = binding;
        ctl.root?.classList.add('is-space');
      } else io.player.toggle();
    },
    up: ({ app }) => {
      const ctl = app.graphCtl;
      if (!ctl.spaceDown) return;
      ctl.spaceDown = false;
      ctl.root?.classList.remove('is-space');
      if (!ctl.spaceUsed) app.io.player.toggle();
    },
  },
  { id: 'play.back', label: 'Previous frame', group: 'Playback', defaults: ['ArrowLeft'], run: (c) => c.app.io.player.step(-1) },
  { id: 'play.fwd', label: 'Next frame', group: 'Playback', defaults: ['ArrowRight'], run: (c) => c.app.io.player.step(1) },
  { id: 'play.itemPrev', label: 'Previous batch item', group: 'Playback', defaults: ['Ctrl+ArrowLeft'], run: ({ app }) => app.ed.setItem(app.ed.state.item - 1) },
  { id: 'play.itemNext', label: 'Next batch item', group: 'Playback', defaults: ['Ctrl+ArrowRight'], run: ({ app }) => app.ed.setItem(app.ed.state.item + 1) },

  {
    id: 'view.maximise',
    label: 'Maximise the panel under the cursor',
    group: 'View',
    defaults: ['`'],
    run: ({ app }) => {
      const m = app.ed.state.prefs.maximized;
      if (m) return app.ed.setPrefs({ maximized: null });
      const el = document.elementFromPoint(lastMouse.x, lastMouse.y) as HTMLElement | null;
      const panel = el?.closest<HTMLElement>('[data-panel]')?.dataset.panel;
      if (panel === 'viewer' || panel === 'graph') app.ed.setPrefs({ maximized: panel });
    },
  },
  { id: 'view.shortcuts', label: 'Show the shortcut cheat-sheet', group: 'View', defaults: ['?'], run: (c) => c.app.ed.openDialog('shortcuts') },
  { id: 'view.keymap', label: 'Edit keyboard shortcuts', group: 'View', defaults: [], run: (c) => c.app.ed.openDialog('keymap') },
  { id: 'view.palette', label: 'Palette Studio', group: 'View', defaults: [], run: ({ app }) => { app.ed.studioTarget = null; app.ed.openDialog('palette'); } },

  { id: 'file.export', label: 'Export…', group: 'File', defaults: ['Ctrl+E'], run: (c) => c.app.ed.openDialog('export') },
  {
    id: 'file.save',
    label: 'Save project…',
    group: 'File',
    defaults: ['Ctrl+S'],
    run: ({ app }) => {
      app.io.projects
        .saveToFile(app.ed.state.graph)
        .then(() => app.ed.toast('Project saved', 'ok'))
        .catch((err) => {
          if (!(err instanceof DOMException && err.name === 'AbortError')) app.ed.toast(`Could not save: ${String(err)}`, 'error');
        });
    },
  },
  {
    id: 'file.open',
    label: 'Open project…',
    group: 'File',
    defaults: ['Ctrl+O'],
    run: ({ app }) => {
      app.io.projects
        .openFromFile()
        .then((g) => g && app.ed.loadGraph(g, true))
        .catch((err) => app.ed.toast(`Could not open: ${String(err)}`, 'error'));
    },
  },
];

const lastMouse = { x: 0, y: 0 };
const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
setDefaultsLookup((id) => BY_ID.get(id)?.defaults);

export function nodeTypeOf(id: string): string | null {
  return id.startsWith(NODE_PREFIX) ? id.slice(NODE_PREFIX.length) : null;
}
export const nodeCommandId = (type: string) => NODE_PREFIX + type;

/** Ids of node-hotkey commands: shipped defaults plus anything the user assigned. */
export function nodeCommandIds(): string[] {
  return [...new Set([...Object.keys(NODE_DEFAULTS), ...overrideIds().filter((i) => i.startsWith(NODE_PREFIX))])];
}
export function allCommandIds(): string[] {
  return [...COMMANDS.map((c) => c.id), ...nodeCommandIds()];
}
export function commandLabel(id: string, titleOf?: (type: string) => string | undefined): string {
  const t = nodeTypeOf(id);
  if (t) return `Add ${titleOf?.(t) ?? t}`;
  return BY_ID.get(id)?.label ?? id;
}
export function commandGroup(id: string): string {
  return nodeTypeOf(id) ? 'Add nodes' : (BY_ID.get(id)?.group ?? 'Other');
}

/** binding -> command id, built from the current key map. */
function buildIndex(app: AppCtx): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of allCommandIds()) {
    const t = nodeTypeOf(id);
    if (t && !app.io.registry.get(t)) continue;
    for (const b of bindingsOf(id)) if (!m.has(b)) m.set(b, id);
  }
  return m;
}

/** Global keyboard handling. Typing in any field is never intercepted. */
export function useShortcuts(app: AppCtx): void {
  useEffect(() => {
    const { ed, graphCtl: ctl } = app;
    const track = (e: PointerEvent) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
    };
    const keydown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.rs-dlg')) return;
      const binding = eventToBinding(e);
      if (!binding) return;
      const id = buildIndex(app).get(binding);
      if (!id) return;
      e.preventDefault();
      if (e.repeat && id !== 'play.back' && id !== 'play.fwd') return;
      const nodeType = nodeTypeOf(id);
      if (nodeType) {
        const r = ctl.rect();
        const x = ctl.hovering ? ctl.pointer.x : r.left + r.width / 2;
        const y = ctl.hovering ? ctl.pointer.y : r.top + r.height / 2;
        const w = ctl.toWorld(x, y);
        ed.addNodeAt(nodeType, { x: Math.round(w.x), y: Math.round(w.y - 14) });
        return;
      }
      BY_ID.get(id)?.run({ app, e, hover: ctl.hovering, binding });
    };
    const keyup = (e: KeyboardEvent) => {
      if (!ctl.spaceDown) return;
      const base = (ctl.spaceKey ?? '').split('+').pop();
      const k = e.key === ' ' ? 'Space' : e.key.toUpperCase();
      if (k === base?.toUpperCase()) BY_ID.get('play.toggle')?.up?.({ app, e });
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [app]);
}
