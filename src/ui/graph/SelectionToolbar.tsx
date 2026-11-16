import { useLayoutEffect, useMemo, useRef } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { nodeRect } from '../lib/layout';
import { useApp, useEd } from '../store/context';
import { bakeSelection } from '../store/bake';
import { bindingsOf } from '../keymap';

/**
 * Floating toolbar above the selected nodes: the mouse / touch way to the common shortcuts. It lives outside the scaled node
 * layer (constant on-screen size), follows pan and zoom, stays inside the graph view and hides while a gesture is running.
 */
export function SelectionToolbar() {
  const app = useApp();
  const { ed, graphCtl: ctl } = app;
  const selection = useEd((s) => s.selection);
  const graph = useEd((s) => s.graph);
  const el = useRef<HTMLDivElement>(null);
  const single = selection.length === 1 ? graph.nodes.find((n) => n.id === selection[0]) : undefined;

  const bounds = useMemo(() => {
    const picked = graph.nodes.filter((n) => selection.includes(n.id));
    if (!picked.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of picked) {
      const r = nodeRect(graph, n, ed.registry.get(n.type));
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    return { x0, y0, x1, y1 };
  }, [graph, selection, ed]);

  const place = () => {
    const t = el.current;
    if (!t || !bounds) return;
    const { x, y, zoom } = ctl.view;
    const W = ctl.root?.clientWidth ?? 800;
    const H = ctl.root?.clientHeight ?? 600;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const cx = ((bounds.x0 + bounds.x1) / 2) * zoom + x;
    let top = bounds.y0 * zoom + y - h - 8;
    if (top < 4) top = bounds.y1 * zoom + y + 8; // no room above: go below, never over the header
    const left = Math.max(4, Math.min(cx - w / 2, W - w - 4));
    top = Math.max(4, Math.min(top, H - h - 4));
    t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    t.style.visibility = bounds.x1 * zoom + x < 0 || bounds.x0 * zoom + x > W || bounds.y1 * zoom + y < 0 || bounds.y0 * zoom + y > H ? 'hidden' : 'visible';
  };
  useLayoutEffect(() => {
    place();
    ctl.viewListeners.add(place);
    return () => void ctl.viewListeners.delete(place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, selection.length]);

  if (!bounds || !selection.length) return null;
  const btn = (icon: IconName, label: string, tip: string, run: () => void, on = false) => (
    <button key={label} className={`rs-seltb__btn${on ? ' is-on' : ''}`} title={tip} aria-label={label} onClick={run}>
      <Icon name={icon} size={16} />
    </button>
  );
  return (
    <div ref={el} className="rs-seltb" role="toolbar" aria-label="Selected nodes" data-nodrag onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {btn('copy', 'Duplicate', 'Duplicate (Ctrl+D)', () => ed.duplicate())}
      {btn('trash', 'Delete', 'Delete (Del)', () => ed.deleteSelection())}
      {btn('bypass', 'Bypass', 'Bypass (B)', () => selection.forEach((id) => ed.toggleBypass(id)), !!single?.bypass)}
      {single && btn('monitor', 'View', 'View this node (Ctrl+Shift+click)', () => ed.setViewed(single.id), ed.state.viewedNodeId === single.id)}
      {btn('save', 'Bake', `Bake selection: freeze these nodes into a stored sequence${bindingsOf('graph.bake')[0] ? ` (${bindingsOf('graph.bake')[0]})` : ''}`, () => void bakeSelection(app))}
      {selection.length > 1 && btn('frame', 'Group', 'Group into frame (Ctrl+G)', () => ed.groupSelection())}
      <button
        className="rs-seltb__btn"
        title="More"
        aria-label="More"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ed.openContextMenu({ clientX: r.left, clientY: r.bottom + 4, nodeId: selection[0] });
        }}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  );
}
