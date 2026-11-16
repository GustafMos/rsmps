import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { SelectField } from '../components/fields';
import { NODE_DEFAULTS, bindingsOf, eventToBinding, exportKeymap, importKeymap, isModified, owners, resetAll, resetBindings, setBindings, useKeymapVersion } from '../keymap';
import { COMMANDS, allCommandIds, commandGroup, commandLabel, nodeCommandId, nodeTypeOf } from '../shortcuts';
import { useApp, useDefs } from '../store/context';
import { Dialog } from './Dialog';

interface Capture {
  id: string;
  /** index of the binding being replaced, or -1 to add a new one */
  index: number;
  pending?: { binding: string; other: string };
}

export function KeymapDialog() {
  const { ed } = useApp();
  const defs = useDefs();
  useKeymapVersion();
  const [q, setQ] = useState('');
  const [cap, setCap] = useState<Capture | null>(null);
  const [addType, setAddType] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const title = (t: string) => defs.find((d) => d.id === t)?.title;
  const label = (id: string) => commandLabel(id, title);

  const ids = allCommandIds().filter((id) => {
    const t = nodeTypeOf(id);
    return !t || defs.some((d) => d.id === t && !d.hidden);
  });
  const groups = ['Add nodes', 'Edit', 'Graph', 'Playback', 'View', 'File'];
  const match = (id: string) => !q || label(id).toLowerCase().includes(q.toLowerCase()) || bindingsOf(id).some((b) => b.toLowerCase().includes(q.toLowerCase()));

  const apply = (c: Capture, binding: string, mode: 'replace' | 'swap' | 'steal') => {
    const mine = bindingsOf(c.id);
    const old = c.index >= 0 ? mine[c.index] : undefined;
    const other = owners(binding, ids, c.id)[0];
    if (other) {
      const rest = bindingsOf(other).filter((b) => b !== binding);
      setBindings(other, mode === 'swap' && old ? [...rest, old] : rest);
    }
    const next = c.index >= 0 ? mine.map((b, i) => (i === c.index ? binding : b)) : [...mine, binding];
    setBindings(c.id, [...new Set(next)]);
    setCap(null);
  };

  // key capture: runs in the capture phase so nothing else sees the keystroke
  useEffect(() => {
    if (!cap) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') return setCap(null);
      if ((e.key === 'Backspace' || e.key === 'Delete') && cap.index >= 0 && !cap.pending) {
        setBindings(cap.id, bindingsOf(cap.id).filter((_, i) => i !== cap.index));
        return setCap(null);
      }
      const binding = eventToBinding(e);
      if (!binding) return;
      const other = owners(binding, ids, cap.id)[0];
      if (other) setCap({ ...cap, pending: { binding, other } });
      else apply(cap, binding, 'replace');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap]);

  const rows = useMemo(() => groups.map((g) => ({ g, ids: ids.filter((id) => commandGroup(id) === g && match(id)) })).filter((x) => x.ids.length), [ids, q, defs]); // eslint-disable-line react-hooks/exhaustive-deps
  const addableNodes = defs.filter((d) => !d.hidden && !ids.includes(nodeCommandId(d.id))).sort((a, b) => a.title.localeCompare(b.title));

  return (
    <Dialog
      title="Keyboard shortcuts"
      width={780}
      onClose={() => (cap ? setCap(null) : ed.openDialog('shortcuts'))}
      footer={
        <>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try { importKeymap(await f.text()); ed.toast('Keymap imported', 'ok'); } catch (err) { ed.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
          }} />
          <button className="rs-btn" onClick={() => file.current?.click()}>Import…</button>
          <button className="rs-btn" onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([exportKeymap()], { type: 'application/json' }));
            a.download = 'rsmps-keymap.json';
            a.click();
          }}>Export…</button>
          <button className="rs-btn rs-btn--danger" onClick={() => { resetAll(); ed.toast('All shortcuts reset to their defaults', 'ok'); }}>Reset all</button>
          <span style={{ flex: 1 }} />
          <button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('shortcuts')}>Done</button>
        </>
      }
    >
      <input className="rs-input" style={{ height: 'var(--ctl-h-lg)' }} placeholder="Search commands or keys…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <p className="rs-dlg__note">Click a key to change it, then press the new combination. Esc cancels, Backspace removes. Keys never fire while you type in a field.</p>
      <div className="rs-km">
        {rows.map(({ g, ids: list }) => (
          <section key={g}>
            <div className="rs-caps" style={{ margin: '8px 0 4px' }}>{g}</div>
            {list.map((id) => {
              const b = bindingsOf(id);
              const builtin = COMMANDS.some((c) => c.id === id);
              const editing = cap?.id === id;
              return (
                <div key={id} className="rs-km__row">
                  <span className="rs-km__label">{label(id)}</span>
                  <span className="rs-km__keys">
                    {b.map((k, i) => (
                      <button key={k} className={`rs-kbd rs-km__key${editing && cap!.index === i ? ' is-capturing' : ''}`} onClick={() => setCap({ id, index: i })} title="Click, then press a new key">
                        {editing && cap!.index === i ? 'Press a key…' : k}
                      </button>
                    ))}
                    {editing && cap!.index === -1 && <span className="rs-kbd is-capturing">Press a key…</span>}
                    {b.length === 0 && !(editing && cap!.index === -1) && <span className="rs-km__none">unassigned</span>}
                    <button className="rs-btn rs-btn--icon rs-btn--ghost rs-km__add" title="Add another key" onClick={() => setCap({ id, index: -1 })}><Icon name="plus" size={14} /></button>
                  </span>
                  {(isModified(id) || (!builtin && !NODE_DEFAULTS[id] && b.length > 0)) ? (
                    <button className="rs-btn rs-btn--ghost" onClick={() => resetBindings(id)} title={builtin || NODE_DEFAULTS[id] ? 'Restore the default key' : 'Remove this hotkey'}>
                      {builtin || NODE_DEFAULTS[id] ? 'Reset' : 'Remove'}
                    </button>
                  ) : <span />}
                  {editing && cap!.pending && (
                    <div className="rs-km__warn" role="alert">
                      <Icon name="warn" size={14} />
                      <span>{cap!.pending.binding} is already used by “{label(cap!.pending.other)}”.</span>
                      <button className="rs-btn" onClick={() => apply(cap!, cap!.pending!.binding, 'swap')} disabled={cap!.index < 0} title="Give the other command the key you are replacing">Swap</button>
                      <button className="rs-btn rs-btn--primary" onClick={() => apply(cap!, cap!.pending!.binding, 'steal')}>Use here</button>
                      <button className="rs-btn" onClick={() => setCap(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
            {g === 'Add nodes' && (
              <div className="rs-km__row">
                <span className="rs-km__label">Assign a key to another node</span>
                <span className="rs-km__keys">
                  <SelectField value={addType} onChange={setAddType} options={[{ value: '', label: 'Choose a node…' }, ...addableNodes.map((d) => ({ value: d.id, label: d.title }))]} />
                  <button className="rs-btn" disabled={!addType} onClick={() => { setCap({ id: nodeCommandId(addType), index: -1 }); setAddType(''); }}>Assign…</button>
                </span>
              </div>
            )}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
