import { useApp, useDefs } from '../store/context';
import { bindingsOf, useKeymapVersion } from '../keymap';
import { COMMANDS, commandLabel, nodeCommandIds, nodeTypeOf } from '../shortcuts';
import { Dialog } from './Dialog';

/** Mouse gestures are not rebindable, so they are listed statically. */
const MOUSE: [string, string][] = [
  ['Click / Shift+Click', 'Select / add to selection'],
  ['Drag on empty space', 'Box select'],
  ['Middle-drag / hold Space', 'Pan the graph'],
  ['Wheel', 'Zoom at cursor'],
  ['Ctrl+Shift+Click', 'View this node'],
  ['Ctrl+right-drag / Alt+drag', 'Cut wires'],
  ['Double-click wire', 'Add reroute (if available)'],
  ['Drag node over a wire', 'Insert it on the wire'],
  ['Viewer: wheel / drag / F / 1', 'Zoom / pan / fit / 100%'],
  ['Paint mask: [ ] and X', 'Brush size / paint-erase'],
];

export function ShortcutsDialog() {
  const { ed } = useApp();
  const defs = useDefs();
  useKeymapVersion();
  const groups = ['Add nodes', 'Edit', 'Graph', 'Playback', 'View', 'File'] as const;
  const nodes = nodeCommandIds().filter((id) => bindingsOf(id).length && defs.some((d) => d.id === nodeTypeOf(id) && !d.hidden));
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={() => ed.openDialog(null)}
      width={760}
      footer={
        <>
          <button className="rs-btn" onClick={() => ed.openDialog(null)}>Close</button>
          <button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('keymap')}>Customize shortcuts…</button>
        </>
      }
    >
      <div className="rs-keys">
        {groups.map((g) => {
          const rows = COMMANDS.filter((c) => c.group === g && bindingsOf(c.id).length);
          const extra = g === 'Add nodes' ? nodes : [];
          if (!rows.length && !extra.length) return null;
          return (
            <div key={g}>
              <div className="rs-caps" style={{ marginBottom: 8 }}>{g}</div>
              {rows.map((c) => (
                <div key={c.id} className="rs-keys__row">
                  <span className="rs-keys__keys">{bindingsOf(c.id).map((b) => <span key={b} className="rs-kbd">{b}</span>)}</span>
                  <span>{c.label}</span>
                </div>
              ))}
              {extra.map((id) => (
                <div key={id} className="rs-keys__row">
                  <span className="rs-keys__keys">{bindingsOf(id).map((b) => <span key={b} className="rs-kbd">{b}</span>)}</span>
                  <span>{commandLabel(id, (t) => defs.find((d) => d.id === t)?.title)}</span>
                </div>
              ))}
            </div>
          );
        })}
        <div>
          <div className="rs-caps" style={{ marginBottom: 8 }}>Mouse</div>
          {MOUSE.map(([k, d]) => (
            <div key={k} className="rs-keys__row">
              <span className="rs-keys__keys"><span className="rs-kbd">{k}</span></span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
