import { MenuPopup, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';
import { setPin } from '../store/nodeView';
import { effectivePins } from '../lib/layout';

export function NodeContextMenu() {
  const { ed, graphCtl } = useApp();
  const req = useEd((s) => s.contextMenu);
  const sel = useEd((s) => s.selection);
  if (!req) return null;
  if (req.edgeId) {
    const edgeId = req.edgeId;
    const e = ed.state.graph.edges.find((x) => x.id === edgeId);
    const items: MenuItem[] = [
      { label: 'Insert node…', icon: 'plus', onClick: () => e && ed.openAddMenu({ clientX: req.clientX, clientY: req.clientY, world: graphCtl.toWorld(req.clientX, req.clientY), insertEdge: edgeId }) },
      { sep: true },
      { label: 'Delete wire', icon: 'trash', onClick: () => ed.disconnect(edgeId) },
    ];
    return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
  }
  const node = ed.state.graph.nodes.find((n) => n.id === req.nodeId);
  const def = node && ed.registry.get(node.type);
  const multi = sel.length > 1;
  const items: MenuItem[] = [
    ...(req.paramKey && node && def
      ? [
          { label: 'Hide from node', onClick: () => setPin(node.id, req.paramKey!, false, effectivePins(def, node)) },
          { sep: true } as MenuItem,
        ]
      : []),
    { label: 'View this node', icon: 'monitor', onClick: () => node && ed.setViewed(node.id), shortcut: 'Ctrl+Shift+Click', disabled: multi },
    { label: node?.bypass ? 'Enable' : 'Bypass', icon: 'bypass', onClick: () => sel.forEach((id) => ed.toggleBypass(id)), shortcut: 'B' },
    { label: node?.collapsed ? 'Expand' : 'Collapse', icon: 'chevronDown', onClick: () => ed.toggleCollapse(sel), shortcut: 'H' },
    { label: 'Rename', icon: 'rename', onClick: () => node && window.dispatchEvent(new CustomEvent('rsmps:rename', { detail: node.id })), shortcut: 'Double-click', disabled: multi },
    { sep: true },
    { label: 'Duplicate', icon: 'copy', onClick: () => ed.duplicate(), shortcut: 'Ctrl+D' },
    { label: 'Copy', icon: 'copy', onClick: () => ed.copy(), shortcut: 'Ctrl+C' },
    { label: 'Paste', icon: 'copy', onClick: () => ed.paste(), shortcut: 'Ctrl+V', disabled: !ed.hasClipboard() },
    { label: 'Group into frame', icon: 'frame', onClick: () => ed.groupSelection(), shortcut: 'Ctrl+G' },
    { label: 'Remove from frame', onClick: () => ed.removeFromFrame(sel), disabled: !node?.frame, shortcut: 'Ctrl+Alt+G' },
    { sep: true },
    { label: 'Delete', icon: 'trash', onClick: () => ed.deleteSelection(), shortcut: 'Del' },
  ];
  return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
}
