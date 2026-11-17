import { useMemo, useState } from 'react';
import { CATEGORIES, type Category } from '../../engine/types';
import { groupData, nodeAtPath } from '../../engine/group';
import { NODE_FILE_EXT } from '../../io/node-presets';
import { useApp, useEd } from '../store/context';
import { Dialog } from './Dialog';

/** The app's own yes / no question (`Editor.ask`). Esc or a click outside answers no. */
export function ConfirmHost() {
  const { ed } = useApp();
  const req = useEd((s) => s.confirm);
  if (!req) return null;
  return (
    <Dialog
      title={req.title}
      onClose={() => ed.answer(false)}
      width={460}
      footer={
        <>
          <button className="rs-btn" onClick={() => ed.answer(false)}>{req.cancel ?? 'Cancel'}</button>
          <button className="rs-btn rs-btn--primary" autoFocus onClick={() => ed.answer(true)}>{req.ok}</button>
        </>
      }
    >
      <p className="rs-dlg__note">{req.text}</p>
      {req.items && req.items.length > 0 && (
        <ul className="rs-dlg__list">
          {req.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Download text as a file (the browser's own download). */
export function downloadText(name: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const nodeFileName = (name: string) => `${name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'node'}${NODE_FILE_EXT}`;

/**
 * "Save group as node…": name, category, keywords and description, then the group is kept in the library and appears in the add menu
 * under its category. Saved nodes are added as editable copies, never as live links (said in the dialog).
 */
export function SaveNodeDialog() {
  const { ed, io } = useApp();
  const target = useEd((s) => s.saveNodeTarget);
  const root = useEd((s) => s.graph);
  const node = useMemo(() => (target ? nodeAtPath(root, target) : null), [root, target]);
  const d = node ? groupData(node) : null;
  const [name, setName] = useState(node?.label || d?.title || '');
  const [category, setCategory] = useState<Category>(d?.color ?? 'math');
  const [keywords, setKeywords] = useState('');
  const [description, setDescription] = useState(d?.description ?? '');
  const [busy, setBusy] = useState(false);
  const close = () => ed.openDialog(null);
  if (!node || !d) return null;
  const meta = () => ({ name: name.trim(), category, keywords: keywords.split(/[,\s]+/).filter(Boolean), description: description.trim() });
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await io.nodePresets.save(node, meta());
      ed.toast(`Saved "${name.trim()}": find it in the add menu under ${CATEGORIES[category].title}`, 'ok');
      close();
    } catch (err) {
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
      setBusy(false);
    }
  };
  const exportFile = () => {
    try {
      downloadText(nodeFileName(name || 'node'), io.nodePresets.toFile(node, meta()));
    } catch (err) {
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <Dialog
      title="Save group as node"
      onClose={close}
      width={460}
      footer={
        <>
          <button className="rs-btn" onClick={exportFile} disabled={!name.trim()} title={`Download a ${NODE_FILE_EXT} file to share`}>Export file…</button>
          <button className="rs-btn rs-btn--primary" disabled={busy || !name.trim()} onClick={() => void save()}>Save node</button>
        </>
      }
    >
      <p className="rs-dlg__note">The group becomes a node in your add menu. Adding it later makes an editable copy: changing the saved node never changes graphs that already use it.</p>
      <label className="rs-dlg__field">
        <span>Name</span>
        <input className="rs-input" autoFocus value={name} maxLength={60} placeholder="Node name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { stop(e); if (e.key === 'Enter') void save(); }} />
      </label>
      <label className="rs-dlg__field">
        <span>Category</span>
        <select className="rs-input" value={category} onChange={(e) => setCategory(e.target.value as Category)} onKeyDown={stop}>
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <option key={c} value={c}>{CATEGORIES[c].title}</option>
          ))}
        </select>
      </label>
      <label className="rs-dlg__field">
        <span>Keywords</span>
        <input className="rs-input" value={keywords} placeholder="logo, recolor, zoom" onChange={(e) => setKeywords(e.target.value)} onKeyDown={stop} />
      </label>
      <label className="rs-dlg__field">
        <span>Description</span>
        <textarea className="rs-input" rows={3} value={description} maxLength={600} onChange={(e) => setDescription(e.target.value)} onKeyDown={stop} />
      </label>
    </Dialog>
  );
}
