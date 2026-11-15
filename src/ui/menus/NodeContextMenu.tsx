import { MenuPopup, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';

export function NodeContextMenu() {
  const { ed } = useApp();
  const req = useEd((s) => s.contextMenu);
  const sel = useEd((s) => s.selection);
  if (!req) return null;
  const node = ed.state.graph.nodes.find((n) => n.id === req.nodeId);
  const items: MenuItem[] = [
    { label: 'View this node', onClick: () => node && ed.setViewed(node.id), shortcut: 'Ctrl+Shift+Click' },
    { label: node?.bypass ? 'Enable' : 'Bypass', onClick: () => sel.forEach((id) => ed.toggleBypass(id)), shortcut: 'B' },
    { label: node?.collapsed ? 'Expand' : 'Collapse', onClick: () => ed.toggleCollapse(sel), shortcut: 'H' },
    { sep: true },
    { label: 'Duplicate', onClick: () => ed.duplicate(), shortcut: 'Ctrl+D' },
    { label: 'Copy', onClick: () => ed.copy(), shortcut: 'Ctrl+C' },
    { label: 'Group into frame', onClick: () => ed.groupSelection(), shortcut: 'Ctrl+G' },
    { label: 'Remove from frame', onClick: () => ed.removeFromFrame(sel), disabled: !node?.frame, shortcut: 'Ctrl+Alt+G' },
    { sep: true },
    { label: 'Delete', onClick: () => ed.deleteSelection(), shortcut: 'Del' },
  ];
  return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
}
