import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL, loadShell, serializeShell, shellReducer, showsDock, viewerMode, type ShellAction, type ShellState } from './shellState';

const run = (s: ShellState, ...as: ShellAction[]) => as.reduce(shellReducer, s);

describe('phone shell', () => {
  it('switches tabs and returns the same state for a no-op', () => {
    const s = run(DEFAULT_SHELL, { type: 'tab', tab: 'media' });
    expect(s.tab).toBe('media');
    expect(shellReducer(s, { type: 'tab', tab: 'media' })).toBe(s);
  });
  it('shows the picture behind the nodes in Graph, and the docked strip above the Inspector and the node list while pinned', () => {
    const base = { ...DEFAULT_SHELL, dock: true };
    expect(viewerMode({ ...base, tab: 'view' })).toBe('full');
    expect(viewerMode({ ...base, tab: 'graph' })).toBe('behind');
    expect(viewerMode({ ...base, tab: 'graph', dock: false })).toBe('behind');
    expect(viewerMode({ ...base, tab: 'graph', graphList: true })).toBe('dock');
    expect(viewerMode({ ...base, tab: 'inspector' })).toBe('dock');
    expect(viewerMode({ ...base, tab: 'inspector', dockOpen: false })).toBe('dock-folded');
    expect(viewerMode({ ...base, tab: 'media' })).toBe('hidden');
    expect(viewerMode({ ...base, tab: 'more' })).toBe('hidden');
    expect(viewerMode({ ...base, tab: 'inspector', dock: false })).toBe('hidden');
    expect(showsDock({ ...base, tab: 'graph' })).toBe(false);
    expect(showsDock({ ...base, tab: 'inspector' })).toBe(true);
  });
  it('hides and shows the nodes; the node list always shows them', () => {
    const s = run(DEFAULT_SHELL, { type: 'nodes' });
    expect(s.nodesHidden).toBe(true);
    expect(run(s, { type: 'nodes' }).nodesHidden).toBe(false);
    expect(run(s, { type: 'list', on: true }).nodesHidden).toBe(false);
  });
  it('keeps the dragged strip height inside its limits and remembers it', () => {
    expect(run(DEFAULT_SHELL, { type: 'dockSize', size: 0.95 }).dockSize).toBe(0.7);
    expect(run(DEFAULT_SHELL, { type: 'dockSize', size: 0.01 }).dockSize).toBe(0.18);
    const s = run({ ...DEFAULT_SHELL, dockOpen: false }, { type: 'dockSize', size: 0.5 });
    expect(s).toMatchObject({ dockSize: 0.5, dockOpen: true });
    expect(loadShell(() => serializeShell(s)).dockSize).toBe(0.5);
  });
  it('pinning the dock again re-opens a folded strip', () => {
    const s = run({ ...DEFAULT_SHELL, dock: false, dockOpen: false }, { type: 'dock', on: true });
    expect(s).toMatchObject({ dock: true, dockOpen: true });
  });
  it('toggles list and select mode', () => {
    expect(run(DEFAULT_SHELL, { type: 'list' }).graphList).toBe(true);
    expect(run(DEFAULT_SHELL, { type: 'select' }, { type: 'select' }).selectMode).toBe(false);
  });
});

describe('tablet drawers', () => {
  it('opens one floating drawer at a time', () => {
    const s = run(DEFAULT_SHELL, { type: 'panel', side: 'left', op: 'toggle' }, { type: 'panel', side: 'right', op: 'toggle' });
    expect(s.open).toEqual({ left: false, right: true });
  });
  it('toggling an open drawer closes it', () => {
    const s = run(DEFAULT_SHELL, { type: 'panel', side: 'left', op: 'open' }, { type: 'panel', side: 'left', op: 'toggle' });
    expect(s.open.left).toBe(false);
  });
  it('pin docks the drawer; toggling a docked drawer hides it; pin again floats it', () => {
    let s = run(DEFAULT_SHELL, { type: 'panel', side: 'right', op: 'open' }, { type: 'panel', side: 'right', op: 'pin' });
    expect(s.pinned.right).toBe(true);
    expect(s.open.right).toBe(false);
    expect(run(s, { type: 'panel', side: 'right', op: 'open' })).toBe(s); // already docked: nothing to float
    s = run(s, { type: 'panel', side: 'right', op: 'pin' });
    expect(s.pinned.right).toBe(false);
    expect(s.open.right).toBe(true);
    s = run(s, { type: 'panel', side: 'right', op: 'pin' }, { type: 'panel', side: 'right', op: 'toggle' });
    expect(s.pinned.right).toBe(false);
    expect(s.open.right).toBe(false);
  });
  it('closeOverlays leaves docked drawers alone', () => {
    const s = run({ ...DEFAULT_SHELL, pinned: { left: true, right: false }, open: { left: false, right: true } }, { type: 'closeOverlays' });
    expect(s).toMatchObject({ pinned: { left: true, right: false }, open: { left: false, right: false } });
  });
});

describe('persistence', () => {
  it('round-trips only the remembered flags', () => {
    const s: ShellState = { ...DEFAULT_SHELL, tab: 'media', dock: false, dockOpen: false, graphList: true, selectMode: true, pinned: { left: true, right: false }, open: { left: true, right: false } };
    const back = loadShell(() => serializeShell(s));
    expect(back).toMatchObject({ dock: false, dockOpen: false, graphList: true, pinned: { left: true, right: false } });
    expect(back.tab).toBe(DEFAULT_SHELL.tab);
    expect(back.selectMode).toBe(false);
    expect(back.open).toEqual({ left: false, right: false });
  });
  it('survives garbage and missing storage', () => {
    expect(loadShell(() => 'not json')).toEqual(DEFAULT_SHELL);
    expect(loadShell(() => null)).toEqual(DEFAULT_SHELL);
    expect(loadShell(() => JSON.stringify({ dock: 'yes', pinned: 3 }))).toEqual(DEFAULT_SHELL);
  });
});
