import { Icon } from '../components/Icon';
import { MenuButton, type MenuItem } from '../components/Menu';
import { useEffect, useState } from 'react';
import pkg from '../../../package.json';
import { enabledOutputs } from '../../engine/graph';
import { resolveActiveOutput } from '../store/editor';
import { useApp, useEd } from '../store/context';
import { reloadInSafeMode } from '../safety';
import { isDesktop } from '../../io/desktop';
import { checkNow } from '../updateNotice';
import './topbar.css';
import '../scan/scan.css';

export function TopBar() {
  const app = useApp();
  const { io, ed } = app;
  const name = useEd((s) => s.graph.name);
  const canUndo = useEd((s) => s.canUndo);
  const canRedo = useEd((s) => s.canRedo);
  const mode = useEd((s) => s.mode);
  const enabledCount = useEd((s) => enabledOutputs(s.graph, io.registry).length);
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

  const open = () => ed.openFileTab();
  const save = () => ed.saveFile();
  const mem = io.memory();
  const mb = Math.round((mem.engineCacheBytes + mem.gpuPoolBytes + mem.frameCacheBytes + mem.decodedMediaBytes) / 1048576);

  const fileItems: MenuItem[] = [
    { label: 'New project (new tab)', onClick: () => void ed.newProjectTab(), shortcut: 'Ctrl+Alt+T' },
    { label: 'New scan (photos of printed sheets)', onClick: () => void ed.newScanTab() },
    { label: 'Open file in a new tab…', onClick: open, shortcut: 'Ctrl+O' },
    { label: 'Save…', onClick: save, shortcut: 'Ctrl+S' },
    { sep: true },
    { label: 'Presets…', onClick: () => ed.openDialog('presets') },
    { label: 'Save as preset…', onClick: () => ed.openDialog('savePreset') },
    { sep: true },
    { label: 'Project settings', onClick: () => { ed.select([]); ed.setPrefs({ rightOpen: true }); } },
    { label: 'Backups…', onClick: () => ed.openDialog('backups') },
    { label: 'Reload in safe mode (rendering paused)', onClick: () => reloadInSafeMode(app) },
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
    { label: `Memory in use: ${mb} MB (this tab only)`, disabled: true },
    { label: 'Keyboard shortcuts', onClick: () => ed.openDialog('shortcuts'), shortcut: '?' },
    { label: 'Customise shortcuts…', onClick: () => ed.openDialog('keymap') },
    { label: 'About RSMPS…', onClick: () => ed.openDialog('about') },
    ...(isDesktop() ? [{ label: 'Check for updates…', onClick: () => void checkNow(ed) }] : []),
  ];

  const hasSel = useEd((s) => s.selection.length > 0);
  const editItems: MenuItem[] = [
    { label: 'Undo', icon: 'undo', onClick: () => ed.undo(), shortcut: 'Ctrl+Z', disabled: !canUndo },
    { label: 'Redo', icon: 'redo', onClick: () => ed.redo(), shortcut: 'Ctrl+Y', disabled: !canRedo },
    { sep: true },
    { label: 'Cut', onClick: () => ed.cut(), disabled: !hasSel },
    { label: 'Copy', icon: 'copy', onClick: () => ed.copy(), shortcut: 'Ctrl+C', disabled: !hasSel },
    { label: 'Paste', onClick: () => ed.paste(), shortcut: 'Ctrl+V', disabled: !ed.hasClipboard() },
    { label: 'Duplicate', icon: 'copy', onClick: () => ed.duplicate(), shortcut: 'Ctrl+D', disabled: !hasSel },
    { label: 'Delete', icon: 'trash', onClick: () => ed.deleteSelection(), shortcut: 'Del', disabled: !hasSel },
    { sep: true },
    { label: 'Select all', icon: 'selectAll', onClick: () => ed.selectAll(), shortcut: 'Ctrl+A' },
    { sep: true },
    { label: 'Tidy up', icon: 'layout', onClick: () => ed.autoLayout(true), shortcut: 'L' },
  ];

  return (
    <header className="rs-top">
      <div className="rs-top__brand">
        <img src={`${import.meta.env.BASE_URL}ripscorpy-mark.png`} alt="" width={32} height={32} />
        <span className="rs-top__word">RSMPS</span>
      </div>
      <MenuButton items={fileItems} className="rs-btn rs-btn--ghost">File <Icon name="chevronDown" size={12} /></MenuButton>
      <MenuButton items={editItems} className="rs-btn rs-btn--ghost">Edit <Icon name="chevronDown" size={12} /></MenuButton>
      <div className="rs-top__sep" />
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canUndo} onClick={() => ed.undo()} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canRedo} onClick={() => ed.redo()} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
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
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${leftOpen ? ' is-on' : ''}`} onClick={() => ed.setPrefs({ leftOpen: !leftOpen })} title="Toggle media panel" aria-label="Toggle media panel"><Icon name="folder" /></button>
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${rightOpen ? ' is-on' : ''}`} onClick={() => ed.setPrefs({ rightOpen: !rightOpen })} title="Toggle inspector" aria-label="Toggle inspector"><Icon name="menu" /></button>
      <div className="rs-top__sep" />
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={open} title="Open file in a new tab (Ctrl+O)" aria-label="Open"><Icon name="open" /><span className="rs-top__label">Open</span></button>
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={save} title="Save (Ctrl+S)" aria-label="Save"><Icon name="save" /><span className="rs-top__label">Save</span></button>
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={() => { ed.studioTarget = null; ed.openDialog('palette'); }} title="Palette Studio: build palettes from colour harmonies or images" aria-label="Palettes"><Icon name="palette" /><span className="rs-top__label">Palettes</span></button>
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={() => ed.openDialog('plugins')} title="Plugins" aria-label="Plugins"><Icon name="puzzle" /><span className="rs-top__label">Plugins</span></button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.openDialog('shortcuts')} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><Icon name="help" /></button>
      <div className="rs-top__sep" />
      <a className="rs-btn rs-btn--ghost rs-top__link" href="https://ko-fi.com/ripscorpy" target="_blank" rel="noopener noreferrer" title="Buy me a coffee: it feeds two cats" aria-label="Support"><Icon name="coffee" /><span className="rs-top__label">Support</span></a>
      <a className="rs-btn rs-btn--ghost rs-top__link" href={bugUrl} target="_blank" rel="noopener noreferrer" title="Report a bug on GitHub (only app version, browser and GPU are pre-filled)" aria-label="Report a bug"><Icon name="bug" /><span className="rs-top__label">Report a bug</span></a>
      <div className="rs-top__sep" />
      <div className="rs-top__split">
        <button className="rs-btn rs-btn--primary" onClick={() => void ed.runExport([], ed.exportPrefs(ed.state.activeProject).items)} disabled={enabledCount === 0} title="Export the outputs that are ticked (Outputs panel)"><Icon name="export" /> Export ({enabledCount})</button>
        <MenuButton className="rs-btn rs-btn--primary rs-top__caret" title="More export options" items={[
          { label: 'Export enabled outputs', onClick: () => void ed.runExport([], ed.exportPrefs(ed.state.activeProject).items) },
          { label: 'Export active output only', onClick: () => { const id = resolveActiveOutput(ed.state, io.registry); if (id) void ed.runExport([id], 'current'); else ed.toast('There is no output node.', 'error'); } },
          { sep: true },
          { head: 'Export active output as' },
          { label: 'Video', onClick: () => ed.exportAs('video') },
          { label: 'Still image', onClick: () => ed.exportAs('image') },
          { label: 'Image sequence', onClick: () => ed.exportAs('sequence') },
          { label: 'Spritesheet', onClick: () => ed.exportAs('spritesheet') },
          { sep: true },
          { label: 'Export…', onClick: () => ed.openDialog('export'), shortcut: 'Ctrl+E' },
        ]}><Icon name="chevronDown" size={12} /></MenuButton>
      </div>
    </header>
  );
}
