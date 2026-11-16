import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';
import { AddonsSection } from './AddonsSection';
import { Dialog } from './Dialog';

export function PluginsDialog() {
  const { io, ed } = useApp();
  const sub = useCallback((fn: () => void) => io.plugins.subscribe(fn), [io]);
  const ver = useRef(0);
  const version = useSyncExternalStore(
    useCallback((fn: () => void) => sub(() => { ver.current++; fn(); }), [sub]),
    () => ver.current,
  );
  const list = useMemo(() => io.plugins.list(), [io, version]);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const install = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const info = await io.plugins.install(f);
      if (info.error) ed.toast(`${info.fileName}: ${info.error}`, 'error');
      else ed.toast(`Installed ${info.nodeIds.length} node${info.nodeIds.length === 1 ? '' : 's'} from ${info.fileName}`, 'ok');
    } catch (err) {
      ed.toast(`Plugin failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Plugins" onClose={() => ed.openDialog(null)} width={560}
      footer={<><button className="rs-btn" onClick={() => ed.openDialog(null)}>Close</button><button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => file.current?.click()}><Icon name="plus" /> Install plugin (.js)…</button></>}>
      <input ref={file} type="file" accept=".js,.mjs,text/javascript" hidden onChange={(e) => { void install(e.target.files?.[0]); e.target.value = ''; }} />
      <AddonsSection />
      <div className="rs-dlg__sec"><span className="rs-caps">Your plugins</span></div>
      <div className="rs-dlg__warn">
        <Icon name="warn" />
        <span>Plugins are code. They run inside this page with the same access as the app itself. Only install plugins from people you trust.</span>
      </div>
      <p className="rs-dlg__note">
        A plugin is a single JavaScript module that exports a node definition. Its nodes then appear in the Add menu like built-in ones. See <code className="rs-mono">docs/PLUGINS.md</code> for the format and an example.
      </p>
      {list.length === 0 ? (
        <div className="rs-empty" style={{ border: '1px dashed var(--line-strong)' }}>No plugins installed.</div>
      ) : (
        <div className="rs-dlg__list">
          {list.map((p) => (
            <div key={p.id} className={`rs-plug${p.error ? ' has-error' : ''}`}>
              <div className="rs-plug__main">
                <strong>{p.fileName}</strong>
                {p.error ? <span className="rs-plug__err">{p.error}</span> : <span className="rs-plug__ids rs-mono">{p.nodeIds.join(', ') || 'no nodes'}</span>}
              </div>
              <button className="rs-btn rs-btn--danger" onClick={() => void io.plugins.remove(p.id)} title="Remove this plugin"><Icon name="trash" /> Remove</button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
