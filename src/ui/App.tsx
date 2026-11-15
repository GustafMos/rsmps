import { useEffect, useRef } from 'react';
import { Icon } from './components/Icon';
import { DialogHost, ExportBar, SupportCard, Toasts } from './dialogs/Overlays';
import { GraphView } from './graph/GraphView';
import { Inspector } from './inspector/Inspector';
import { AddMenu } from './menus/AddMenu';
import { NodeContextMenu } from './menus/NodeContextMenu';
import { SocketPicker } from './menus/SocketPicker';
import { Sidebar } from './sidebar/Sidebar';
import { useApp, useEd } from './store/context';
import { TopBar } from './topbar/TopBar';
import { ProjectTabs } from './topbar/ProjectTabs';
import { Transport } from './transport/Transport';
import { Viewer } from './viewer/Viewer';
import { trackPointer } from './lib/drag';
import { useShortcuts } from './shortcuts';
import { ScanView } from './scan/ScanView';
import { TimelineEditor } from './timeline/TimelineEditor';
import { ScanQuickSettings, ScanStepper } from './scan/ScanStage';
import { usePlayKeys } from './playKeys';
import { useRenderWatchdog } from './watchdog';
import './app.css';

const SAFE = /[?&]safe/.test(location.search);

export function App() {
  const { ed, io } = useApp();
  useShortcuts(useApp());
  usePlayKeys(useApp());
  useRenderWatchdog(useApp());
  const prefs = useEd((s) => s.prefs);
  const mode = useEd((s) => s.mode);
  const timelineNode = useEd((s) => s.timelineNode);
  const scanStage = useEd((s) => s.scanStage);
  const switching = useEd((s) => s.switching);
  const center = useRef<HTMLDivElement>(null);
  const viewerPanel = useRef<HTMLDivElement>(null);
  const max = prefs.maximized;

  useEffect(() => {
    document.title = `${ed.state.graph.name || 'Untitled'} · RSMPS`;
    return ed.store.subscribe(() => {
      document.title = `${ed.state.graph.name || 'Untitled'} · RSMPS`;
    });
  }, [ed]);

  const dragDivider = (e: React.PointerEvent) => {
    e.preventDefault();
    const c = center.current!;
    const r = c.getBoundingClientRect();
    let frac = prefs.split;
    document.body.style.cursor = 'row-resize';
    trackPointer(
      e,
      (ev) => {
        frac = Math.min(0.85, Math.max(0.15, (ev.clientY - r.top) / r.height));
        if (viewerPanel.current) viewerPanel.current.style.flexBasis = `${frac * 100}%`;
      },
      () => {
        document.body.style.cursor = '';
        ed.setPrefs({ split: frac });
      },
    );
  };

  const maxBtn = (panel: 'viewer' | 'graph') => (
    <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.setPrefs({ maximized: max === panel ? null : panel })} title="Maximise / restore (`)">
      <Icon name={max === panel ? 'restore' : 'maximize'} size={14} />
    </button>
  );

  return (
    <div
      className="rs-app"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (e.defaultPrevented || !e.dataTransfer.files.length) return;
        e.preventDefault();
        io.library
          .add(Array.from(e.dataTransfer.files))
          .then((i) => ed.toast(`Imported ${i.length} file${i.length === 1 ? '' : 's'}`, 'ok'))
          .catch((err) => ed.toast(`Import failed: ${String(err)}`, 'error'));
      }}
    >
      {SAFE && (
        <div className="rs-safe" role="alert">Safe mode: rendering is off. Remove ?safe from the address to render.</div>
      )}
      <TopBar />
      <ProjectTabs />
      {switching && (
        <div className="rs-switching" role="status" aria-live="polite">
          <div>Loading {switching}…</div>
        </div>
      )}
      {mode === 'scan' && <ScanStepper />}
      {mode === 'scan' && scanStage === 2 && <ScanQuickSettings />}
      {mode === 'scan' && scanStage === 1 ? <ScanView /> : (
      <div className="rs-main">
        {prefs.leftOpen && (
          <aside className="rs-left">
            <Sidebar />
          </aside>
        )}
        <section className="rs-center" ref={center}>
          {max !== 'graph' && (
            <div className="rs-panel" ref={viewerPanel} style={max === 'viewer' ? { flex: 1 } : { flex: `0 0 ${prefs.split * 100}%` }}>
              <div className="rs-panel__head"><span className="rs-caps">Viewer</span><span className="rs-panel__spacer" />{maxBtn('viewer')}</div>
              <div className="rs-panel__body"><Viewer /></div>
            </div>
          )}
          {!max && <div className="rs-divider" onPointerDown={dragDivider} role="separator" aria-orientation="horizontal" title="Drag to resize" />}
          {max !== 'viewer' && (
            <div className="rs-panel" style={{ flex: 1 }}>
              <div className="rs-panel__head"><span className="rs-caps">Node graph</span><span className="rs-panel__spacer" /><span className="rs-panel__tip">Shift+A add · Space+drag pan · wheel zoom</span>{maxBtn('graph')}</div>
              <div className="rs-panel__body"><GraphView /></div>
            </div>
          )}
        </section>
        {prefs.rightOpen && (
          <aside className="rs-right">
            <div className="rs-panel__head"><span className="rs-caps">Inspector</span></div>
            <Inspector />
          </aside>
        )}
      </div>
      )}
      {(mode === 'edit' || scanStage === 2) && <Transport />}
      <AddMenu />
      <NodeContextMenu />
      <DialogHost />
      {timelineNode && <TimelineEditor nodeId={timelineNode} onClose={() => ed.openTimeline(null)} />}
      <SocketPicker />
      <ExportBar />
      <SupportCard />
      <Toasts />
    </div>
  );
}
