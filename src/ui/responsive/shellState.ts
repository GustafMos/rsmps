/**
 * State of the phone and tablet shells, as a pure reducer (tested without a DOM). Nothing here touches the project or the editor:
 * the tab, the docked viewer strip and the drawers are layout, remembered per user (a few flags) but never saved with a project.
 */
export type PhoneTab = 'view' | 'graph' | 'inspector' | 'media' | 'more';
export const PHONE_TABS: readonly PhoneTab[] = ['view', 'graph', 'inspector', 'media', 'more'];
export type Side = 'left' | 'right';

export interface ShellState {
  /** Phone: the one main area on show. */
  tab: PhoneTab;
  /** Phone: the viewer stays docked as a strip above Graph / Inspector (pin toggle). */
  dock: boolean;
  /** Phone: the docked strip is expanded (about 30 % of the height) rather than folded to its thin bar. */
  dockOpen: boolean;
  /** Phone, Graph tab: the outline (list of nodes) instead of the node canvas. */
  graphList: boolean;
  /** Touch: one-finger drag on empty graph space draws a selection box instead of panning. */
  selectMode: boolean;
  /** Tablet: a drawer that stays docked beside the work area (remembered). */
  pinned: Record<Side, boolean>;
  /** Tablet: a drawer that is open over the work area (not remembered). */
  open: Record<Side, boolean>;
}

export const DEFAULT_SHELL: ShellState = {
  tab: 'graph',
  dock: true,
  dockOpen: true,
  graphList: false,
  selectMode: false,
  pinned: { left: false, right: false },
  open: { left: false, right: false },
};

export type ShellAction =
  | { type: 'tab'; tab: PhoneTab }
  | { type: 'dock'; on?: boolean }
  | { type: 'dockOpen'; on?: boolean }
  | { type: 'list'; on?: boolean }
  | { type: 'select'; on?: boolean }
  | { type: 'panel'; side: Side; op: 'toggle' | 'open' | 'close' | 'pin' }
  | { type: 'closeOverlays' };

const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

export function shellReducer(s: ShellState, a: ShellAction): ShellState {
  switch (a.type) {
    case 'tab':
      return s.tab === a.tab ? s : { ...s, tab: a.tab };
    case 'dock': {
      const on = a.on ?? !s.dock;
      return on === s.dock ? s : { ...s, dock: on, dockOpen: on ? true : s.dockOpen };
    }
    case 'dockOpen': {
      const on = a.on ?? !s.dockOpen;
      return on === s.dockOpen ? s : { ...s, dockOpen: on };
    }
    case 'list': {
      const on = a.on ?? !s.graphList;
      return on === s.graphList ? s : { ...s, graphList: on };
    }
    case 'select': {
      const on = a.on ?? !s.selectMode;
      return on === s.selectMode ? s : { ...s, selectMode: on };
    }
    case 'closeOverlays':
      return s.open.left || s.open.right ? { ...s, open: { left: false, right: false } } : s;
    case 'panel': {
      const { side, op } = a;
      const shown = s.pinned[side] || s.open[side];
      if (op === 'pin') {
        // docked <-> floating: a floating drawer becomes docked; a docked one drops back to floating (still on screen)
        return s.pinned[side]
          ? { ...s, pinned: { ...s.pinned, [side]: false }, open: { ...s.open, [side]: true, [other(side)]: false } }
          : { ...s, pinned: { ...s.pinned, [side]: true }, open: { ...s.open, [side]: false } };
      }
      const wantOpen = op === 'open' ? true : op === 'close' ? false : !shown;
      if (!wantOpen) return { ...s, pinned: { ...s.pinned, [side]: false }, open: { ...s.open, [side]: false } };
      if (s.pinned[side]) return s;
      // only one floating drawer at a time
      return { ...s, open: { ...s.open, [side]: true, [other(side)]: false } };
    }
  }
}

/** Which tab the viewer strip shows above: only the editing tabs, and only while pinned. */
export function showsDock(s: ShellState): boolean {
  return s.dock && (s.tab === 'graph' || s.tab === 'inspector');
}

/** The viewer is full-size in the View tab, a strip in the editing tabs while docked, otherwise out of sight. */
export type ViewerMode = 'full' | 'dock' | 'dock-folded' | 'hidden';
export function viewerMode(s: ShellState): ViewerMode {
  if (s.tab === 'view') return 'full';
  if (!showsDock(s)) return 'hidden';
  return s.dockOpen ? 'dock' : 'dock-folded';
}

/** Keys persisted between visits. */
export const PERSISTED_SHELL = ['dock', 'dockOpen', 'graphList', 'pinned'] as const;
export const SHELL_KEY = 'rsmps.ui.shell';

export function loadShell(read: (key: string) => string | null): ShellState {
  try {
    const raw = read(SHELL_KEY);
    if (!raw) return DEFAULT_SHELL;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const pin = (p.pinned ?? {}) as Record<string, unknown>;
    return {
      ...DEFAULT_SHELL,
      dock: typeof p.dock === 'boolean' ? p.dock : DEFAULT_SHELL.dock,
      dockOpen: typeof p.dockOpen === 'boolean' ? p.dockOpen : DEFAULT_SHELL.dockOpen,
      graphList: typeof p.graphList === 'boolean' ? p.graphList : false,
      pinned: { left: pin.left === true, right: pin.right === true },
    };
  } catch {
    return DEFAULT_SHELL;
  }
}

export function serializeShell(s: ShellState): string {
  return JSON.stringify(Object.fromEntries(PERSISTED_SHELL.map((k) => [k, s[k]])));
}
