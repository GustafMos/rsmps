import { bugReportUrl } from '../lib/bugReport';
import { BETA } from '../aboutCopy';
import { Icon } from '../components/Icon';
import { MenuButton, type MenuItem } from '../components/Menu';
import { useEffect, useState } from 'react';
import pkg from '../../../package.json';
import { enabledOutputs } from '../../engine/graph';
import { resolveActiveOutput } from '../store/editor';
import { useApp, useEd } from '../store/context';
import { usePanelToggles } from '../responsive/TabletDrawer';
import { reloadInSafeMode } from '../safety';
import { isDesktop } from '../../io/desktop';
import { checkNow } from '../updateNotice';
import { addCurrent } from '../store/queue';
import { openFeature } from '../store/features';
import './topbar.css';
import '../scan/scan.css';

export function TopBar() {
  const app = useApp();
  const { io, ed } = app;
  // a scan tab has no graph name of its own: the bar shows the tab's name (read-only; rename the tab itself) instead of the graph's "Untitled"
  const name = useEd((s) => (s.mode === 'scan' ? (s.projects.find((p) => p.id === s.activeProject)?.name ?? 'Scan') : s.graph.name));
  const isScan = useEd((s) => s.mode === 'scan');
  const canUndo = useEd((s) => s.canUndo);
  const canRedo = useEd((s) => s.canRedo);
  const mode = useEd((s) => s.mode);
  const enabledCount = useEd((s) => enabledOutputs(s.graph, io.registry).length);
  const { mediaOpen, inspectorOpen: rightOpen, toggleMedia, toggleInspector, openInspector } = usePanelToggles(); // desktop: fold the media rail / hide the inspector; tablet: open the drawers

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
  const bugUrl = bugReportUrl(gpu);

  const open = () => ed.openFileTab();
  const save = () => ed.saveFile();
  const mem = io.memory();
  const mb = Math.round((mem.engineCacheBytes + mem.gpuPoolBytes + mem.frameCacheBytes + mem.decodedMediaBytes) / 1048576);

  const fileItems: MenuItem[] = [
    { label: 'New project (new tab)', onClick: () => void ed.newProjectTab(), shortcut: 'Ctrl+Alt+T' },
    { label: 'New scan (photos of printed sheets)', onClick: () => void ed.newScanTab() },
    { label: 'Print blank sheets…', onClick: () => ed.openDialog('blankSheets') },
    { label: 'New from template…', onClick: () => openFeature('templates') },
    { label: 'Open file in a new tab…', onClick: open, shortcut: 'Ctrl+O' },
    { label: 'Save…', onClick: save, shortcut: 'Ctrl+S' },
    { sep: true },
    { label: 'Presets…', onClick: () => ed.openDialog('presets') },
    { label: 'Save as preset…', onClick: () => ed.openDialog('savePreset') },
    { label: 'Share this look…', onClick: () => openFeature('share') },
    { label: 'Render queue…', onClick: () => openFeature('queue') },
    { label: 'Stop-motion capture…', onClick: () => openFeature('stopmotion') },
    { sep: true },
    { label: 'Project settings', onClick: () => { ed.select([]); openInspector(); } },
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
    { label: 'Customize shortcuts…', onClick: () => ed.openDialog('keymap') },
    { label: 'About RSMPS…', onClick: () => ed.openDialog('about') },
    { label: 'Report a bug…', onClick: () => window.open(bugUrl, '_blank', 'noopener') }, // also in the menu: the top bar hides its link buttons on narrow windows
    { label: 'Support (Ko-fi)…', onClick: () => window.open('https://ko-fi.com/ripscorpy', '_blank', 'noopener') },
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
        <button className="rs-top__beta" onClick={() => ed.openDialog('about')} title={`${BETA.short} ${BETA.ask} Click for details.`}>{BETA.badge}</button>
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
        title={isScan ? 'Scan tab name: double-click the tab to rename it' : 'Project name'}
        readOnly={isScan}
        placeholder="Untitled"
        onChange={(e) => ed.setName(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <div className="rs-top__spacer" />
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${mediaOpen ? ' is-on' : ''}`} onClick={toggleMedia} title="Toggle media panel: open it, or fold it to a slim rail" aria-label="Toggle media panel"><Icon name="folder" /></button>
      <button className={`rs-btn rs-btn--icon rs-btn--ghost${rightOpen ? ' is-on' : ''}`} onClick={toggleInspector} title="Toggle inspector" aria-label="Toggle inspector"><Icon name="menu" /></button>
      <div className="rs-top__sep" />
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={open} title="Open file in a new tab (Ctrl+O)" aria-label="Open"><Icon name="open" /><span className="rs-top__label">Open</span></button>
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={save} title="Save (Ctrl+S)" aria-label="Save"><Icon name="save" /><span className="rs-top__label">Save</span></button>
      <button className="rs-btn rs-btn--ghost rs-top__link" onClick={() => { ed.studioTarget = null; ed.openDialog('palette'); }} title="Palette Studio: build palettes from color harmonies or images" aria-label="Palettes"><Icon name="palette" /><span className="rs-top__label">Palettes</span></button>
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
          { label: 'Sprite sheet', onClick: () => ed.exportAs('spritesheet') },
          { sep: true },
          { label: 'Export…', onClick: () => ed.openDialog('export'), shortcut: 'Ctrl+E' },
          { sep: true },
          { label: 'Add to render queue', onClick: () => { if (addCurrent(app)) { ed.toast('Added to the render queue.', 'ok'); openFeature('queue'); } } },
          { label: 'Render queue…', onClick: () => openFeature('queue') },
        ]}><Icon name="chevronDown" size={12} /></MenuButton>
      </div>
    </header>
  );
}
