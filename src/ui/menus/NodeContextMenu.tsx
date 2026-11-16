import { MenuPopup, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';
import { setPin } from '../store/nodeView';
import { effectivePins } from '../lib/layout';
import { bakeSelection } from '../store/bake';
import { processSelection } from '../store/processes';
import { bindingsOf } from '../keymap';
import { familyMembers } from '../lib/convert';

export function NodeContextMenu() {
  const app = useApp();
  const { ed, graphCtl } = app;
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
  const family = node && !multi ? familyMembers(ed.registry, node.type) : [];
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
    ...(family.length
      ? [
          { sep: true } as MenuItem,
          { head: 'Convert to…' } as MenuItem,
          ...family.map((m): MenuItem => ({ label: m.title, disabled: m.id === node!.type, onClick: () => ed.convertNodeType(node!.id, m.id) })),
        ]
      : []),
    { sep: true },
    { label: 'Duplicate', icon: 'copy', onClick: () => ed.duplicate(), shortcut: 'Ctrl+D' },
    { label: 'Copy', icon: 'copy', onClick: () => ed.copy(), shortcut: 'Ctrl+C' },
    { label: 'Paste', icon: 'copy', onClick: () => ed.paste(), shortcut: 'Ctrl+V', disabled: !ed.hasClipboard() },
    { label: 'Group into frame', icon: 'frame', onClick: () => ed.groupSelection(), shortcut: 'Ctrl+G' },
    { label: 'Bake selection', icon: 'save', onClick: () => void bakeSelection(app), shortcut: bindingsOf('graph.bake')[0] },
    ...(sel.some((id) => !!ed.registry.get(ed.state.graph.nodes.find((n) => n.id === id)?.type ?? '')?.process)
      ? [{ label: 'Process selected nodes', icon: 'play' as const, onClick: () => void processSelection(app), shortcut: bindingsOf('graph.process')[0] }]
      : []),
    { label: 'Remove from frame', onClick: () => ed.removeFromFrame(sel), disabled: !node?.frame, shortcut: 'Ctrl+Alt+G' },
    { sep: true },
    { label: 'Delete', icon: 'trash', onClick: () => ed.deleteSelection(), shortcut: 'Del' },
  ];
  return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
}
