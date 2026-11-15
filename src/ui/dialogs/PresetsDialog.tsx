import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';
import { Dialog } from './Dialog';

type Preset = Awaited<ReturnType<ReturnType<typeof useApp>['io']['projects']['listPresets']>>[number];

export function PresetsDialog() {
  const { io, ed } = useApp();
  const [list, setList] = useState<Preset[] | null>(null);
  const refresh = () => io.projects.listPresets().then(setList).catch((e) => ed.toast(`Could not list presets: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  useEffect(() => void refresh(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (id: string) => {
    const g = await io.projects.loadPreset(id);
    if (!g) return ed.toast('Could not load that preset.', 'error');
    // keep the current project's media assets out of it: presets are graphs without media
    ed.loadGraph(g, true);
    ed.openDialog(null);
    ed.toast('Preset loaded (Ctrl+Z to go back)', 'ok');
  };

  return (
    <Dialog title="Presets" onClose={() => ed.openDialog(null)} width={600} footer={<><button className="rs-btn" onClick={() => ed.openDialog(null)}>Close</button><button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('savePreset')}><Icon name="save" /> Save current as preset…</button></>}>
      {list === null ? (
        <div className="rs-empty">Loading…</div>
      ) : list.length === 0 ? (
        <div className="rs-empty" style={{ border: '1px dashed var(--line-strong)' }}>No presets yet. Save the current graph to reuse it later.</div>
      ) : (
        <div className="rs-presets">
          {list.map((p) => (
            <div key={p.id} className="rs-preset">
              <div className="rs-preset__img">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <Icon name="image" size={24} />}</div>
              <div className="rs-preset__name" title={p.name}>{p.name}</div>
              <div className="rs-preset__btns">
                <button className="rs-btn rs-btn--primary" onClick={() => void load(p.id)}>Load</button>
                {p.builtin ? <span className="rs-caps">built-in</span> : (
                  <button className="rs-btn rs-btn--icon rs-btn--ghost rs-btn--danger" title="Delete preset" onClick={() => void io.projects.deletePreset(p.id).then(refresh)}><Icon name="trash" /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function SavePresetDialog() {
  const { io, ed } = useApp();
  const [name, setName] = useState(ed.state.graph.name === 'Untitled' ? '' : ed.state.graph.name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const thumb = await io.player.snapshot().catch(() => null);
      await io.projects.savePreset(name.trim(), ed.state.graph, thumb ?? undefined);
      ed.toast(`Saved preset "${name.trim()}"`, 'ok');
      ed.openDialog('presets');
    } catch (err) {
      ed.toast(`Could not save preset: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog title="Save as preset" onClose={() => ed.openDialog('presets')} width={420} footer={<><button className="rs-btn" onClick={() => ed.openDialog('presets')}>Back</button><button className="rs-btn rs-btn--primary" disabled={busy || !name.trim()} onClick={save}>Save preset</button></>}>
      <p className="rs-dlg__note">Saves the node graph (without your media files) with a thumbnail of the current viewer image.</p>
      <input className="rs-input" style={{ height: 'var(--ctl-h-lg)', width: '100%' }} autoFocus value={name} placeholder="Preset name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void save(); }} />
    </Dialog>
  );
}
