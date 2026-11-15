import { Icon } from '../components/Icon';
import { MenuButton, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';
import './topbar.css';
import '../scan/scan.css';

export function TopBar() {
  const { io, ed } = useApp();
  const name = useEd((s) => s.graph.name);
  const canUndo = useEd((s) => s.canUndo);
  const canRedo = useEd((s) => s.canRedo);
  const mode = useEd((s) => s.mode);
  const leftOpen = useEd((s) => s.prefs.leftOpen);
  const rightOpen = useEd((s) => s.prefs.rightOpen);

  const open = async () => {
    try {
      const g = await io.projects.openFromFile();
      if (g) ed.loadGraph(g, true);
    } catch (err) {
      ed.toast(`Could not open: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };
  const save = async () => {
    try {
      await io.projects.saveToFile(ed.state.graph);
      ed.toast('Project saved', 'ok');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) ed.toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const fileItems: MenuItem[] = [
    { label: 'New project', onClick: () => { ed.newGraph('Untitled', true); ed.toast('New project (Ctrl+Z to go back)', 'info'); } },
    { label: 'Open…', onClick: open, shortcut: 'Ctrl+O' },
    { label: 'Save…', onClick: save, shortcut: 'Ctrl+S' },
    { sep: true },
    { label: 'Presets…', onClick: () => ed.openDialog('presets') },
    { label: 'Save as preset…', onClick: () => ed.openDialog('savePreset') },
    { sep: true },
    { label: 'Project settings', onClick: () => { ed.select([]); ed.setPrefs({ rightOpen: true }); } },
    { label: 'Palette Studio…', onClick: () => { ed.studioTarget = null; ed.openDialog('palette'); } },
    { label: 'Plugins…', onClick: () => ed.openDialog('plugins') },
    { sep: true },
    { label: 'Keyboard shortcuts', onClick: () => ed.openDialog('shortcuts'), shortcut: '?' },
    { label: 'Customise shortcuts…', onClick: () => ed.openDialog('keymap') },
  ];

  return (
    <header className="rs-top">
      <div className="rs-top__brand">
        <img src="/ripscorpy-logo.png" alt="" width={28} height={28} />
        <span className="rs-top__word">RSMPS</span>
      </div>
      <div className="rs-top__modes" role="tablist" aria-label="Mode">
        <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'is-on' : ''} onClick={() => ed.setMode('edit')} title="Node editor">Edit</button>
        <button role="tab" aria-selected={mode === 'scan'} className={mode === 'scan' ? 'is-on' : ''} onClick={() => ed.setMode('scan')} title="Scan photos of printed sheets back into an animation">Scan</button>
      </div>
      <MenuButton items={fileItems} className="rs-btn rs-btn--ghost">File <Icon name="chevronDown" size={12} /></MenuButton>
      <div className="rs-top__sep" />
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canUndo} onClick={() => ed.undo()} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canRedo} onClick={() => ed.redo()} title="Redo (Ctrl+Y)"><Icon name="redo" /></button>
      <div className="rs-top__sep" />
      <input
        className="rs-top__name"
        value={name}
        spellCheck={false}
        aria-label="Project name"
        title="Project name"
        onChange={(e) => ed.setName(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <div className="rs-top__spacer" />
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${leftOpen ? ' is-on' : ''}`} onClick={() => ed.setPrefs({ leftOpen: !leftOpen })} title="Toggle media panel"><Icon name="folder" /></button>
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${rightOpen ? ' is-on' : ''}`} onClick={() => ed.setPrefs({ rightOpen: !rightOpen })} title="Toggle inspector"><Icon name="menu" /></button>
      <button className="rs-btn rs-btn--ghost" onClick={() => { ed.studioTarget = null; ed.openDialog('palette'); }} title="Palette Studio: build palettes from colour harmonies or images">Palettes</button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.openDialog('plugins')} title="Plugins"><Icon name="plug" /></button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.openDialog('shortcuts')} title="Keyboard shortcuts (?)"><Icon name="help" /></button>
      <button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('export')} title="Export (Ctrl+E)"><Icon name="export" /> Export</button>
    </header>
  );
}
