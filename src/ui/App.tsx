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
import { MediaEditor } from './timeline/MediaEditor';
import { MEDIA_TIMELINE_ID } from '../engine/lib/media-edit';
import { ScanQuickSettings, ScanStepper } from './scan/ScanStage';
import { usePlayKeys } from './playKeys';
import { useRenderWatchdog } from './watchdog';
import { SafetyBar } from './components/SafetyBar';
import { LiveHost } from './live/LiveHost';
import { FeatureHost } from './FeatureHost'; // share, queue, templates, stop-motion (see FeatureHost.tsx)
import './app.css';
// the responsive layer comes after every component's own css on purpose: its same-specificity rules must win
import { PhoneShell } from './responsive/PhoneShell';
import { TabletDrawer } from './responsive/TabletDrawer';
import { GraphTouchChip, SelectToggle } from './responsive/GraphToolbar';
import { useResponsiveEffects } from './responsive/useResponsiveEffects';
import { useViewport } from './responsive/viewport';

export function App() {
  const { ed, io } = useApp();
  useShortcuts(useApp());
  usePlayKeys(useApp());
  useRenderWatchdog(useApp());
  useResponsiveEffects();
  const vp = useViewport();
  const cls = vp.cls;
  const prefs = useEd((s) => s.prefs);
  const mode = useEd((s) => s.mode);
  const timelineNode = useEd((s) => s.timelineNode);
  const timelineIsMedia = useEd((s) => s.graph.nodes.find((n) => n.id === s.timelineNode)?.type === MEDIA_TIMELINE_ID);
  const scanStage = useEd((s) => s.scanStage);
  const switching = useEd((s) => s.switching);
  const center = useRef<HTMLDivElement>(null);
  const viewerPanel = useRef<HTMLDivElement>(null);
  const max = prefs.maximized;

  useEffect(() => {
    // the open tab's own name (a scan tab has no graph name of its own, so the graph's "Untitled" must not leak into the title)
    const set = () => {
      const st = ed.state;
      const tab = st.projects.find((p) => p.id === st.activeProject);
      const name = st.mode === 'scan' ? tab?.name : st.graph.name || tab?.name;
      document.title = `${name || 'Untitled'} · RSMPS`;
    };
    set();
    return ed.store.subscribe(set);
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
      {cls !== 'phone' && <TopBar />}
      {cls !== 'phone' && <SafetyBar />}
      {cls !== 'phone' && <ProjectTabs />}
      {switching && (
        <div className="rs-switching" role="status" aria-live="polite">
          <div>Loading {switching}…</div>
        </div>
      )}
      {cls === 'phone' && <PhoneShell />}
      {cls !== 'phone' && mode === 'scan' && <ScanStepper />}
      {cls !== 'phone' && mode === 'scan' && scanStage === 2 && <ScanQuickSettings />}
      {cls === 'phone' ? null : mode === 'scan' && scanStage === 1 ? <ScanView /> : (
      <div className="rs-main">
        <TabletDrawer side="left" title="Media"><Sidebar fill={cls === 'tablet'} /></TabletDrawer>
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
              <div className="rs-panel__body">
                <GraphView />
                {vp.coarse && <div className="rs-gt-overlay"><SelectToggle /></div>}
                {vp.coarse && <GraphTouchChip />}
              </div>
              {timelineNode && (timelineIsMedia ? <MediaEditor nodeId={timelineNode} onClose={() => ed.openTimeline(null)} /> : <TimelineEditor nodeId={timelineNode} onClose={() => ed.openTimeline(null)} />)}
            </div>
          )}
        </section>
        {(prefs.rightOpen || cls === 'tablet') && (
          <TabletDrawer side="right" title="Inspector">
            <aside className="rs-right">
              <div className="rs-panel__head"><span className="rs-caps">Inspector</span></div>
              <Inspector />
            </aside>
          </TabletDrawer>
        )}
      </div>
      )}
      {cls !== 'phone' && (mode === 'edit' || scanStage === 2) && <Transport />}
      <AddMenu />
      <NodeContextMenu />
      <DialogHost />
      <FeatureHost />
      <LiveHost />
      <SocketPicker />
      <ExportBar />
      <SupportCard />
      <Toasts />
    </div>
  );
}
