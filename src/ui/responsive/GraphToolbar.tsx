import { useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon';
import { MenuButton, type MenuItem } from '../components/Menu';
import { wireStore } from '../graph-touch/graphTouch';
import { frameLegible, toggleCompactAll } from '../graph-touch/phoneGraph';
import { useApp, useEd } from '../store/context';
import { dispatchShell, useShell } from './shellStore';

/** Says which wire is waiting for its second tap, with a Cancel. Shown over the graph while tap-tap wiring is under way. */
export function GraphTouchChip() {
  const pending = useSyncExternalStore(wireStore.subscribe, () => wireStore.get().pending);
  if (!pending) return null;
  return (
    <div className="rs-wirechip rs-graph__touchbar" role="status" data-nodrag>
      <span className="rs-wirechip__dot" style={{ background: `var(--sock-${pending.type}, var(--sock-unknown))` }} />
      <span className="rs-wirechip__text">
        <strong>{pending.label}</strong>
        <span>{pending.side === 'out' ? 'Tap an input to connect' : 'Tap an output to connect'}</span>
      </span>
      <button className="rs-btn" onClick={() => wireStore.set({ pending: null })}>
        <Icon name="close" size={14} /> Cancel
      </button>
    </div>
  );
}

/** The "Select" switch: on, a one-finger drag on empty space draws a selection box instead of panning. */
export function SelectToggle({ className = '' }: { className?: string }) {
  const on = useShell((s) => s.selectMode);
  return (
    <button className={`rs-btn rs-btn--icon rs-selecttoggle${on ? ' is-on' : ''} ${className}`} onClick={() => dispatchShell({ type: 'select' })} role="switch" aria-checked={on} aria-label="Select mode" title="Select mode: drag on empty space to draw a selection box. Off: drag pans, two fingers pinch.">
      <Icon name="selectAll" size={18} />
    </button>
  );
}

/** Opens the add menu in the middle of the graph. */
export function useAddNode() {
  const { ed, graphCtl: ctl } = useApp();
  return () => {
    const r = ctl.rect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    ed.openAddMenu({ clientX: cx, clientY: cy, world: ctl.toWorld(cx, cy) });
  };
}

/** Phone: the bar above the graph / list. */
export function GraphToolbar() {
  const app = useApp();
  const { ed } = app;
  const list = useShell((s) => s.graphList);
  const path = useEd((s) => s.path);
  const gridSnap = useEd((s) => s.prefs.gridSnap !== false);
  const addNode = useAddNode();
  const items: MenuItem[] = [
    { label: 'Auto-layout (arranges the selection, or everything)', icon: 'layout', onClick: () => ed.autoLayout(true) },
    { label: 'Collapse / expand all nodes', icon: 'fit', onClick: () => toggleCompactAll(app) },
    { label: `${gridSnap ? '✓ ' : ''}Snap dropped nodes to a grid`, icon: 'grid', onClick: () => ed.setPrefs({ gridSnap: !gridSnap }) },
    { label: 'Undo', icon: 'undo', onClick: () => ed.undo() },
    { label: 'Duplicate selection', icon: 'copy', onClick: () => ed.duplicate() },
    { label: 'Delete selection', icon: 'trash', onClick: () => ed.deleteSelection() },
  ];
  return (
    <div className="rs-gtb">
      {path.length > 0 && (
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.exitGroup(path.length - 1)} aria-label="Back out of the group" title="Back out of the group">
          <Icon name="chevronLeft" size={18} />
        </button>
      )}
      <div className="rs-gtb__seg" role="group" aria-label="Graph or list">
        <button className={`rs-btn${!list ? ' is-on' : ''}`} onClick={() => dispatchShell({ type: 'list', on: false })} aria-pressed={!list}>Graph</button>
        <button className={`rs-btn${list ? ' is-on' : ''}`} onClick={() => dispatchShell({ type: 'list', on: true })} aria-pressed={list}>List</button>
      </div>
      <button className="rs-btn rs-btn--primary" onClick={addNode}><Icon name="plus" size={16} /> Add</button>
      {!list && (
        <>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => frameLegible(app)} aria-label="Frame the graph" title="Frame the graph at a readable size"><Icon name="focus" size={18} /></button>
          <SelectToggle />
        </>
      )}
      <span className="rs-gtb__spacer" />
      <MenuButton className="rs-btn rs-btn--icon rs-btn--ghost" title="More graph actions" items={items}><Icon name="more" size={18} /></MenuButton>
    </div>
  );
}
