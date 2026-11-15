import { useApp } from '../store/context';
import { Dialog } from './Dialog';

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Graph',
    rows: [
      ['Shift+A / right-click', 'Add node'],
      ['Click / Shift+Click', 'Select / add to selection'],
      ['Drag on empty space', 'Box select'],
      ['Middle-drag / Space-drag', 'Pan'],
      ['Wheel', 'Zoom at cursor'],
      ['F / Home', 'Frame all'],
      ['Delete / Backspace', 'Delete (heals the chain)'],
      ['Ctrl+C / V / D', 'Copy / paste / duplicate'],
      ['Ctrl+G', 'Group selection in a frame'],
      ['Ctrl+Alt+G', 'Remove from frame'],
      ['Ctrl+Shift+Click', 'View this node'],
      ['Ctrl+right-drag / Alt+drag', 'Cut wires'],
      ['Double-click wire', 'Add reroute (if available)'],
      ['B / H', 'Bypass / collapse'],
      ['L', 'Auto-layout'],
      ['Drag node over a wire', 'Insert it on the wire'],
    ],
  },
  {
    title: 'General',
    rows: [
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Space', 'Play / pause'],
      ['← / →', 'Step one frame'],
      ['Ctrl+← / →', 'Previous / next batch item'],
      ['` (backtick)', 'Maximise panel under cursor'],
      ['Ctrl+S / Ctrl+O', 'Save / open project'],
      ['Ctrl+E', 'Export'],
      ['?', 'This cheat-sheet'],
    ],
  },
  {
    title: 'Viewer',
    rows: [
      ['Wheel', 'Zoom'],
      ['Drag', 'Pan'],
      ['F', 'Fit'],
      ['1', '100%'],
      ['Double-click', 'Fit'],
      ['[ ] / X', 'Paint-mask brush size / paint-erase'],
    ],
  },
];

export function ShortcutsDialog() {
  const { ed } = useApp();
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => ed.openDialog(null)} width={680}>
      <div className="rs-keys">
        {SECTIONS.map((s) => (
          <div key={s.title}>
            <div className="rs-caps" style={{ marginBottom: 8 }}>{s.title}</div>
            {s.rows.map(([k, d]) => (
              <div key={k} className="rs-keys__row">
                <span className="rs-kbd">{k}</span>
                <span>{d}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
