import { useEffect, useState } from 'react';
import type { ParamDef } from '../../engine/types';
import { describeSource, type MidiMapping } from '../../engine/lib/midi-map';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { Dialog } from '../dialogs/Dialog';
import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive, type Live } from '../store/live';
import { REACT_FEATURES, reactionOf } from '../store/react';
import './live.css';

/**
 * Everything of the live tools that is not a button in an existing panel: the right-click menu of a setting (MIDI learn, React to sound),
 * the "move a control" banner, the MIDI mappings dialog, the sound chooser, and the output window menu.
 * Mounted once by the app. It finds settings through the `data-param-key` / `data-param-node` / `data-node-id` attributes of the
 * inspector rows and the node rows, so it needs no change in either component.
 */
export function LiveHost() {
  const app = useApp();
  const live = getLive(app);
  const ui = useSelector(live.ui, (s) => s);
  const midi = useSelector(live.midi.store, (s) => s);

  useEffect(() => live.midi.init(), [live]);
  useEffect(() => () => live.output.close(), [live]);

  // right-click on a setting
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const row = t?.closest?.('[data-param-key]') as HTMLElement | null;
      if (!row) return;
      const key = row.getAttribute('data-param-key')!;
      const nodeId = row.getAttribute('data-param-node') ?? row.closest('[data-node-id]')?.getAttribute('data-node-id');
      if (!nodeId) return;
      const def = live.midi.paramDef(nodeId, key);
      if (!def || !(def.type === 'number' || def.type === 'bool' || def.type === 'enum')) return;
      e.preventDefault();
      e.stopPropagation();
      live.ui.set((s) => ({ ...s, paramMenu: { x: e.clientX, y: e.clientY, node: nodeId, param: key } }));
    };
    document.addEventListener('contextmenu', onMenu, true);
    return () => document.removeEventListener('contextmenu', onMenu, true);
  }, [live]);

  // Esc cancels learning
  useEffect(() => {
    if (!midi.learning) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        live.midi.cancelLearn();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [live, midi.learning]);

  return (
    <>
      {midi.learning && (
        <div className="rs-live__banner" role="status">
          <span className="rs-live__pulse" />
          <span>
            Move a knob, press a key or push a fader to control <b>{midi.learning.label}</b>
            {midi.devices.length === 0 && ' (no MIDI input found)'}
          </span>
          <button className="rs-btn" onClick={() => live.midi.cancelLearn()}>Cancel (Esc)</button>
        </div>
      )}
      {midi.recording && (
        <div className="rs-live__banner" role="status">
          <span className="rs-live__pulse" />
          <span>Recording <b>{midi.recording.label}</b> for one pass of the loop</span>
          <button className="rs-btn" onClick={() => live.midi.stopRecording(true)}>Stop and keep</button>
          <button className="rs-btn rs-btn--ghost" onClick={() => live.midi.stopRecording(false)}>Discard</button>
        </div>
      )}
      {ui.paramMenu && <ParamMenu live={live} {...ui.paramMenu} onClose={() => live.ui.set((s) => ({ ...s, paramMenu: null }))} />}
      {ui.outputMenu && <OutputMenu live={live} {...ui.outputMenu} onClose={() => live.ui.set((s) => ({ ...s, outputMenu: null }))} />}
      {midi.dialog && <MidiDialog live={live} />}
      {ui.soundChooser && (
        <Dialog title="Which sound is the music?" onClose={() => live.ui.set((s) => ({ ...s, soundChooser: null }))} width={420}>
          <div className="rs-live__choices">
            {ui.soundChooser.sources.map((s) => (
              <button key={`${s.node}.${s.port}`} className="rs-btn" onClick={() => live.react(ui.soundChooser!.node, ui.soundChooser!.param, ui.soundChooser!.feature, s)}>
                {s.label}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}

function ParamMenu({ live, x, y, node, param, onClose }: { live: Live; x: number; y: number; node: string; param: string; onClose: () => void }) {
  const mapped = live.midi.mappingsFor(node, param);
  const def = live.midi.paramDef(node, param) as ParamDef;
  const level = live.ed.state.level;
  const wired = level.edges.some((e) => e.to.node === node && e.to.port === param);
  const reacting = reactionOf(level, node, param);
  const items: MenuItem[] = [
    { head: live.midi.label(node, param) },
    { label: mapped.length ? 'MIDI learn another control' : 'MIDI learn', onClick: () => void live.midi.learn(node, param), disabled: wired },
  ];
  if (mapped.length) {
    items.push({ label: `Unlearn MIDI${mapped.length > 1 ? ` (${mapped.length} controls)` : ''}`, onClick: () => live.midi.unlearn(node, param) });
    if (def.type === 'number') items.push({ label: 'Record automation', onClick: () => live.midi.startRecording(mapped[0].id) });
  }
  items.push({ label: 'MIDI mappings…', onClick: () => live.midi.store.set((s) => ({ ...s, dialog: true })) });
  if (def.type === 'number') {
    items.push({ sep: true }, { head: reacting ? 'Reacts to sound: change' : 'React to sound' });
    for (const f of REACT_FEATURES) items.push({ label: `${reacting?.feature === f.id ? '✓ ' : ''}${f.label}`, onClick: () => live.react(node, param, f.id), disabled: wired && !reacting });
    if (reacting) items.push({ label: 'Stop reacting', onClick: () => live.stopReacting(node, param) });
  }
  return <MenuPopup x={x} y={y} items={items} onClose={onClose} />;
}

function OutputMenu({ live, x, y, onClose }: { live: Live; x: number; y: number; onClose: () => void }) {
  const out = useSelector(live.output.store, (s) => s);
  const o = out.opts;
  const tick = (on: boolean) => (on ? '✓ ' : '');
  const items: MenuItem[] = [
    { head: 'Output window' },
    { label: out.open ? 'Close the output window' : 'Open the output window', onClick: () => live.output.toggle() },
    { label: `${tick(out.blackout)}Blackout`, disabled: !out.open, onClick: () => live.output.setBlackout() },
    { label: `${tick(out.freeze)}Freeze`, disabled: !out.open, onClick: () => live.output.setFreeze() },
    { label: 'Full screen (F in the window)', disabled: !out.open, onClick: () => live.output.fullscreen() },
    { sep: true },
    { label: `${tick(o.fit === 'fit')}Fit`, onClick: () => live.output.setOpts({ fit: 'fit' }) },
    { label: `${tick(o.fit === 'fill')}Fill`, onClick: () => live.output.setOpts({ fit: 'fill' }) },
    { label: `${tick(o.fit === 'native')}Pixels 1:1`, onClick: () => live.output.setOpts({ fit: 'native' }) },
    { label: `${tick(o.sharp)}Sharp pixels`, onClick: () => live.output.setOpts({ sharp: !o.sharp }) },
    { label: `${tick(o.clean)}Clean feed (no hint)`, onClick: () => live.output.setOpts({ clean: !o.clean }) },
    { label: `Background: ${o.bg === '#000000' ? 'black' : o.bg === '#00b140' ? 'green' : 'gray'} (next)`, onClick: () => live.output.setOpts({ bg: o.bg === '#000000' ? '#00b140' : o.bg === '#00b140' ? '#808080' : '#000000' }) },
    { label: `Desktop display: ${o.display === 'auto' ? 'automatic' : o.display} (next)`, onClick: () => live.output.setOpts({ display: o.display === 'auto' ? '1' : o.display === '1' ? '2' : o.display === '2' ? '3' : 'auto' }) },
    { sep: true },
    { label: 'MIDI mappings…', onClick: () => live.midi.store.set((s) => ({ ...s, dialog: true })) },
  ];
  return <MenuPopup x={x} y={y} items={items} onClose={onClose} />;
}

function MidiDialog({ live }: { live: Live }) {
  const midi = useSelector(live.midi.store, (s) => s);
  const map = useApp().ed.state.graph.midiMap;
  const [, setTick] = useState(0);
  useEffect(() => {
    live.midi.prune();
    const t = window.setInterval(() => setTick((n) => n + 1), 120);
    return () => window.clearInterval(t);
  }, [live]);
  // the editor store changes with every edit: subscribe so the table follows
  const [, bump] = useState(0);
  useEffect(() => live.ed.store.subscribe(() => bump((n) => n + 1)), [live]);
  const mappings = (live.ed.state.graph.midiMap ?? map)?.mappings ?? [];
  const num = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);
  return (
    <Dialog
      title="MIDI mappings"
      width={mappings.length ? 900 : 600}
      onClose={() => live.midi.store.set((s) => ({ ...s, dialog: false }))}
      footer={
        <>
          {midi.status !== 'ready' && <button className="rs-btn" onClick={() => void live.midi.start()}>Turn MIDI on</button>}
          <button className="rs-btn rs-btn--primary" onClick={() => live.midi.store.set((s) => ({ ...s, dialog: false }))}>Done</button>
        </>
      }
    >
      <div className="rs-live__status">
        {live.midi.statusText()}
        {midi.devices.length > 0 && ` Inputs: ${midi.devices.join(', ')}.`}
        {midi.last && ` Last: ${midi.last.text}.`}
      </div>
      {mappings.length === 0 ? (
        <p className="rs-live__status rs-live__empty">Nothing is mapped yet. Right-click any number, switch or choice (in the inspector or on a node) and pick MIDI learn, then move a knob or press a key.</p>
      ) : (
        <table className="rs-live__table">
          <thead>
            <tr><th>Setting</th><th>Control</th><th>Low</th><th>High</th><th>Curve</th><th>Invert</th><th>Buttons</th><th>Takeover</th><th /><th /></tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <MappingRow key={m.id} m={m} live={live} num={num} />
            ))}
          </tbody>
        </table>
      )}
      <p className="rs-live__status">Settings are written into the project like a hand edit, so they are saved, undone and exported. Several controls can drive one setting, and one control can drive several settings.</p>
    </Dialog>
  );
}

function MappingRow({ m, live, num }: { m: MidiMapping; live: Live; num: (v: string, f: number) => number }) {
  const shape = live.midi.shape(m.node, m.param);
  const isNum = shape?.type === 'number';
  const upd = (patch: Partial<MidiMapping>) => live.midi.updateMapping(m.id, patch);
  const gone = !shape;
  return (
    <tr>
      <td title={gone ? 'This setting is not in the level you are looking at' : undefined} style={gone ? { opacity: 0.5 } : undefined}>{live.midi.label(m.node, m.param)}</td>
      <td className="rs-live__src">{describeSource(m.source)}{m.deviceName ? ` · ${m.deviceName}` : ''}</td>
      <td>{isNum ? <input className="rs-input" defaultValue={m.min} key={`min${m.min}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => upd({ min: num(e.target.value, m.min) })} /> : null}</td>
      <td>{isNum ? <input className="rs-input" defaultValue={m.max} key={`max${m.max}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => upd({ max: num(e.target.value, m.max) })} /> : null}</td>
      <td>
        {isNum && (
          <select className="rs-input" value={m.curve} onChange={(e) => upd({ curve: e.target.value as MidiMapping['curve'] })}>
            <option value="linear">Linear</option>
            <option value="exp">Exponential</option>
            <option value="log">Logarithmic</option>
          </select>
        )}
      </td>
      <td><input type="checkbox" checked={m.invert} onChange={(e) => upd({ invert: e.target.checked })} aria-label="Invert" /></td>
      <td>
        {shape && !isNum && (
          <select className="rs-input" value={m.mode} onChange={(e) => upd({ mode: e.target.value as MidiMapping['mode'] })}>
            <option value="toggle">Toggle</option>
            <option value="momentary">Momentary</option>
            {shape.type === 'enum' && <option value="step">Step through</option>}
            {shape.type === 'bool' && <option value="step">Follow</option>}
          </select>
        )}
      </td>
      <td>
        {isNum && (
          <select className="rs-input" value={m.pickup} onChange={(e) => upd({ pickup: e.target.value as MidiMapping['pickup'] })}>
            <option value="pickup">Pick up</option>
            <option value="jump">Jump</option>
          </select>
        )}
      </td>
      <td><div className="rs-live__bar" title="Where the control is"><span style={{ width: `${Math.round(live.midi.position(m.id) * 100)}%` }} /></div></td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {isNum && <button className="rs-btn rs-btn--ghost" title="Record one pass of the loop as keyframes" onClick={() => { live.midi.store.set((s) => ({ ...s, dialog: false })); live.midi.startRecording(m.id); }}>Record</button>}
        <button className="rs-btn rs-btn--ghost rs-btn--danger" onClick={() => live.midi.removeMapping(m.id)}>Remove</button>
      </td>
    </tr>
  );
}
