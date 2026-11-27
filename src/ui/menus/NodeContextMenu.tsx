import { MenuPopup, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';
import { setPin } from '../store/nodeView';
import { effectivePins } from '../lib/layout';
import { bakeGroup, bakeSelection, bakeSelectionWithCacheNodes } from '../store/bake';
import { defOf, GROUP_TYPE, groupDefOf, isBoundaryNode } from '../../engine/group';
import { downloadText, nodeFileName } from '../dialogs/GroupDialogs';
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
    const e = ed.state.level.edges.find((x) => x.id === edgeId);
    const items: MenuItem[] = [
      { label: 'Insert node…', icon: 'plus', onClick: () => e && ed.openAddMenu({ clientX: req.clientX, clientY: req.clientY, world: graphCtl.toWorld(req.clientX, req.clientY), insertEdge: edgeId }) },
      { sep: true },
      { label: 'Delete wire', icon: 'trash', onClick: () => ed.disconnect(edgeId) },
    ];
    return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
  }
  const node = ed.state.level.nodes.find((n) => n.id === req.nodeId);
  const def = defOf(ed.registry, node);
  const path = ed.state.path;
  const isGroup = node?.type === GROUP_TYPE;
  const boundary = isBoundaryNode(node);
  const multi = sel.length > 1;
  const family = node && !multi ? familyMembers(ed.registry, node.type) : [];
  const items: MenuItem[] = [
    ...(req.paramKey && node && def
      ? [
          { label: 'Hide from node', onClick: () => setPin(node.id, req.paramKey!, false, effectivePins(def, node)) },
          ...(path.length && !boundary ? [{ label: 'Expose on group', icon: 'stack' as const, onClick: () => ed.exposeParam(node.id, req.paramKey!) }] : []),
          { sep: true } as MenuItem,
        ]
      : []),
    ...(node?.type === 'sdf-3d' && !multi
      ? [
          { label: 'Convert to SDF Scene', onClick: () => ed.convertToSdfScene(node.id) },
          { label: 'Convert a copy to SDF Scene', onClick: () => ed.convertToSdfScene(node.id, true) },
          { sep: true } as MenuItem,
        ]
      : []),
    ...(isGroup && !multi
      ? [
          { label: 'Open group', icon: 'stack' as const, onClick: () => ed.enterGroup(node!.id), shortcut: 'Tab' },
          { label: 'Ungroup', onClick: () => ed.ungroupNodes(), shortcut: bindingsOf('graph.ungroup')[0] },
          { label: 'Save as node…', onClick: () => ed.openSaveNode(ed.fullId(node!.id)) },
          { label: 'Export node file…', icon: 'export' as const, onClick: () => downloadText(nodeFileName(node!.label || groupDefOf(node!).title), app.io.nodePresets.toFile(node!)) },
          { label: 'Bake group', icon: 'save' as const, onClick: () => void bakeGroup(app, node!.id) },
          { sep: true } as MenuItem,
        ]
      : []),
    ...(path.length ? [{ label: 'Close group', icon: 'chevronLeft' as const, onClick: () => ed.exitGroup(), shortcut: 'Esc' }] : []),
    { label: 'View this node', icon: 'monitor', onClick: () => node && ed.setViewed(ed.fullId(node.id)), shortcut: 'Ctrl+Shift+Click', disabled: multi || boundary },
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
    { label: 'Group', icon: 'stack', onClick: () => ed.groupNodes(), shortcut: bindingsOf('graph.makeGroup')[0], disabled: boundary },
    { label: 'Repeat', onClick: () => ed.groupNodes('repeat'), shortcut: bindingsOf('graph.repeat')[0], disabled: boundary },
    { label: 'Put in a frame', icon: 'frame', onClick: () => ed.groupSelection(), shortcut: bindingsOf('graph.group')[0] },
    { label: 'Bake selection', icon: 'save', onClick: () => void bakeSelection(app), shortcut: bindingsOf('graph.bake')[0] },
    ...(!path.length ? [{ label: 'Bake with Cache nodes', onClick: () => void bakeSelectionWithCacheNodes(app) }] : []),
    ...(sel.some((id) => !!defOf(ed.registry, ed.state.level.nodes.find((n) => n.id === id))?.process)
      ? [{ label: 'Process selected nodes', icon: 'play' as const, onClick: () => void processSelection(app), shortcut: bindingsOf('graph.process')[0] }]
      : []),
    { label: 'Remove from frame', onClick: () => ed.removeFromFrame(sel), disabled: !node?.frame, shortcut: 'Ctrl+Alt+G' },
    { sep: true },
    { label: 'Delete', icon: 'trash', onClick: () => ed.deleteSelection(), shortcut: 'Del' },
  ];
  return <MenuPopup x={req.clientX} y={req.clientY} items={items} onClose={() => ed.openContextMenu(null)} />;
}
