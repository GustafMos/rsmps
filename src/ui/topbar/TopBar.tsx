import { Icon } from '../components/Icon';
import { MenuButton, type MenuItem } from '../components/Menu';
import { useEffect, useState } from 'react';
import pkg from '../../../package.json';
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

  // Non-personal technical context only: no project name, file names or graph contents.
  const [gpu, setGpu] = useState('unknown');
  useEffect(() => {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } };
    nav.gpu
      ?.requestAdapter()
      .then((a) => {
        const i = a?.info;
        if (i) setGpu([i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'WebGPU (no description)');
      })
      .catch(() => undefined);
  }, []);
  const bugBody = ['## What happened', '', '', '## Steps', '1. ', '', '## Expected', '', '', '---', `App: RSMPS ${pkg.version}`, `Browser: ${navigator.userAgent}`, `GPU: ${gpu}`].join('\n');
  const bugUrl = `https://github.com/GustafMos/rsmps/issues/new?body=${encodeURIComponent(bugBody)}`;

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
    {
      label: 'Copy graph for bug report',
      onClick: () =>
        navigator.clipboard.writeText(JSON.stringify(ed.state.graph, null, 1)).then(
          () => ed.toast('Graph copied. Paste it into the bug report yourself if you are happy to share it.', 'ok'),
          () => ed.toast('Clipboard is not available here.', 'error'),
        ),
    },
    { label: 'Keyboard shortcuts', onClick: () => ed.openDialog('shortcuts'), shortcut: '?' },
    { label: 'Customise shortcuts…', onClick: () => ed.openDialog('keymap') },
  ];

  return (
    <header className="rs-top">
      <div className="rs-top__brand">
        <img src="/ripscorpy-logo.png" alt="" width={34} height={34} />
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
      <a className="rs-btn rs-btn--ghost rs-top__link" href="https://ko-fi.com/ripscorpy" target="_blank" rel="noopener noreferrer" title="Buy me a coffee: it feeds two cats"><Icon name="coffee" /><span className="rs-top__label">Support</span></a>
      <a className="rs-btn rs-btn--ghost rs-top__link" href={bugUrl} target="_blank" rel="noopener noreferrer" title="Report a bug on GitHub (only app version, browser and GPU are pre-filled)"><Icon name="bug" /><span className="rs-top__label">Report a bug</span></a>
      <button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('export')} title="Export (Ctrl+E)"><Icon name="export" /> Export</button>
    </header>
  );
}
