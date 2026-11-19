import { Icon, type IconName } from '../components/Icon';
import { MEDIA_TIMELINE_ID } from '../../engine/lib/media-edit';
import { SafetyBar } from '../components/SafetyBar';
import { GraphView } from '../graph/GraphView';
import { Inspector } from '../inspector/Inspector';
import { ScanQuickSettings, ScanStepper } from '../scan/ScanStage';
import { ScanView } from '../scan/ScanView';
import { Sidebar } from '../sidebar/Sidebar';
import { useApp, useEd } from '../store/context';
import { MediaEditor } from '../timeline/MediaEditor';
import { TimelineEditor } from '../timeline/TimelineEditor';
import { Viewer } from '../viewer/Viewer';
import { GraphToolbar, GraphTouchChip } from './GraphToolbar';
import { MoreSheet } from './MoreSheet';
import { NodeList } from './NodeList';
import { PhoneTransport } from './PhoneTransport';
import { dispatchShell, showTab, useShell } from './shellStore';
import { PHONE_TABS, viewerMode, type PhoneTab } from './shellState';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useViewport } from './viewport';
import '../graph-touch/graph-touch.css';
import './responsive.css'; // last on purpose: same-specificity rules here must win over the components' own css
import { ViewerOverflow } from './ViewerOverflow';

const TABS: Record<PhoneTab, { label: string; icon: IconName }> = {
  view: { label: 'View', icon: 'monitor' },
  graph: { label: 'Graph', icon: 'layout' },
  inspector: { label: 'Inspector', icon: 'menu' },
  media: { label: 'Media', icon: 'folder' },
  more: { label: 'More', icon: 'more' },
};

/**
 * The phone layout: one main area at a time and a bottom tab bar (thumb reach): View, Graph, Inspector, Media, More. The viewer is
 * mounted once and moves: full size in View, a docked strip (about 30 % of the height, collapsible, with a pin toggle) above Graph and
 * Inspector, so the result is always in sight while editing. Landscape: the viewer sits on the left, the current tab on the right.
 */
export function PhoneShell() {
  const { ed } = useApp();
  const vp = useViewport();
  const shell = useShell((s) => s);
  const mode = useEd((s) => s.mode);
  const scanStage = useEd((s) => s.scanStage);
  const timelineNode = useEd((s) => s.timelineNode);
  const timelineIsMedia = useEd((s) => s.graph.nodes.find((n) => n.id === s.timelineNode)?.type === MEDIA_TIMELINE_ID);
  const landscape = vp.landscape;
  // landscape: the viewer is always at the left, so "View" has nothing more to show on the right: the graph takes its place
  const pane: PhoneTab = landscape && shell.tab === 'view' ? 'graph' : shell.tab;
  const vmode = landscape ? 'side' : viewerMode(shell);

  const behind = vmode === 'behind';
  const nodesHidden = behind && shell.nodesHidden;

  const scanBody = mode === 'scan' && scanStage === 1;
  return (
    <div className="rs-pshell" data-tab={shell.tab} data-pane={pane} data-vmode={vmode} data-nodes={nodesHidden ? 'off' : 'on'}>
      <PhoneBar />
      <SafetyBar />
      {mode === 'scan' && <ScanStepper />}
      {mode === 'scan' && scanStage === 2 && <ScanQuickSettings />}
      {scanBody ? (
        <div className="rs-pshell__scan"><ScanView /></div>
      ) : (
        <div className="rs-pshell__body">
          <div className="rs-pshell__viewer" data-mode={vmode} style={vmode === 'dock' ? { flexBasis: `${shell.dockSize * 100}%` } : undefined}>
            <div className="rs-pshell__vhead">
              <span className="rs-caps">Viewer</span>
              <span className="rs-pshell__spacer" />
              <ViewerOverflow />
              {(vmode === 'dock' || vmode === 'dock-folded') && (
                <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => dispatchShell({ type: 'dockOpen' })} aria-label={vmode === 'dock' ? 'Fold the viewer' : 'Unfold the viewer'} aria-expanded={vmode === 'dock'}>
                  <Icon name={vmode === 'dock' ? 'chevronDown' : 'chevronRight'} size={16} />
                </button>
              )}
              {vmode !== 'side' && (
                <button className={`rs-btn rs-btn--icon rs-btn--ghost${shell.dock ? ' is-on' : ''}`} onClick={() => dispatchShell({ type: 'dock' })} aria-label="Pin the viewer above the inspector" aria-pressed={shell.dock} title={shell.dock ? 'Unpin: the viewer only shows in the View tab' : 'Pin: keep the viewer above the graph and inspector'}>
                  <Icon name="pin" size={16} />
                </button>
              )}
            </div>
            <div className="rs-pshell__vbody"><Viewer /></div>
            <PhoneTransport />
            {vmode === 'dock' && <DockGrip />}
          </div>
          <div className="rs-pshell__main">
            <section className="rs-pshell__pane rs-pshell__pane--graph" hidden={pane !== 'graph'}>
              <GraphToolbar />
              <div className="rs-pshell__graph">
                <div className="rs-pshell__canvas" hidden={shell.graphList || nodesHidden}>
                  <GraphView />
                  <GraphTouchChip />
                </div>
                {shell.graphList && <NodeList />}
                {behind && !timelineNode && (
                  <button
                    className={`rs-btn rs-btn--icon rs-pshell__eye${nodesHidden ? ' is-on' : ''}`}
                    onClick={() => dispatchShell({ type: 'nodes' })}
                    aria-pressed={nodesHidden}
                    aria-label={nodesHidden ? 'Show the nodes' : 'Hide the nodes to see the whole picture'}
                    title={nodesHidden ? 'Show the nodes' : 'Hide the nodes'}
                  >
                    <Icon name={nodesHidden ? 'eyeOff' : 'eye'} size={20} />
                  </button>
                )}
                {timelineNode && (timelineIsMedia ? <MediaEditor nodeId={timelineNode} onClose={() => ed.openTimeline(null)} /> : <TimelineEditor nodeId={timelineNode} onClose={() => ed.openTimeline(null)} />)}
              </div>
            </section>
            {pane === 'inspector' && (
              <section className="rs-pshell__pane">
                <InspectorCrumb />
                <div className="rs-pshell__scroll"><Inspector /></div>
              </section>
            )}
            {pane === 'media' && (
              <section className="rs-pshell__pane rs-pshell__pane--media"><Sidebar fill /></section>
            )}
            {pane === 'more' && <section className="rs-pshell__pane"><MoreSheet /></section>}
          </div>
        </div>
      )}
      <TabBar />
    </div>
  );
}

/** The lower edge of the docked viewer strip: drag it up or down to make the picture smaller or larger. */
function DockGrip() {
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const body = e.currentTarget.closest('.rs-pshell__body');
    if (!body) return;
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const r = body.getBoundingClientRect();
    const move = (ev: PointerEvent) => dispatchShell({ type: 'dockSize', size: (ev.clientY - r.top) / Math.max(1, r.height) });
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };
  return (
    <div className="rs-pshell__grip" role="separator" aria-orientation="horizontal" aria-label="Drag to resize the viewer" onPointerDown={onDown}>
      <span />
    </div>
  );
}

function InspectorCrumb() {
  const sel = useEd((s) => s.selection);
  const title = useEd((s) => {
    if (s.selection.length !== 1) return s.selection.length > 1 ? `${s.selection.length} nodes` : 'Project';
    const n = s.level.nodes.find((x) => x.id === s.selection[0]);
    return n ? n.label || n.type : 'Node';
  });
  return (
    <div className="rs-pshell__crumb">
      <button className="rs-btn rs-btn--ghost" onClick={() => showTab('graph')} aria-label="Back to the graph"><Icon name="chevronLeft" size={16} /> Graph</button>
      <span className="rs-pshell__crumbtitle">{sel.length ? title : 'Project settings'}</span>
    </div>
  );
}

function PhoneBar() {
  const { ed } = useApp();
  const name = useEd((s) => s.graph.name);
  const canUndo = useEd((s) => s.canUndo);
  const canRedo = useEd((s) => s.canRedo);
  return (
    <header className="rs-pbar">
      <img src={`${import.meta.env.BASE_URL}ripscorpy-mark.png`} alt="" width={28} height={28} />
      <input className="rs-pbar__name" value={name} spellCheck={false} aria-label="Project name" onChange={(e) => ed.setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canUndo} onClick={() => ed.undo()} aria-label="Undo"><Icon name="undo" size={18} /></button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={!canRedo} onClick={() => ed.redo()} aria-label="Redo"><Icon name="redo" size={18} /></button>
      <button className="rs-btn rs-btn--primary rs-pbar__export" onClick={() => void ed.runExport([], ed.exportPrefs(ed.state.activeProject).items)} aria-label="Export enabled outputs"><Icon name="export" size={16} /> Export</button>
    </header>
  );
}

function TabBar() {
  const tab = useShell((s) => s.tab);
  const selected = useEd((s) => s.selection.length === 1);
  return (
    <nav className="rs-tabbar" role="tablist" aria-label="Sections">
      {PHONE_TABS.map((t) => (
        <button key={t} className={`rs-tabbar__btn${tab === t ? ' is-active' : ''}`} role="tab" aria-selected={tab === t} onClick={() => showTab(t)}>
          <span className="rs-tabbar__ico">
            <Icon name={TABS[t].icon} size={22} />
            {t === 'inspector' && selected && <span className="rs-tabbar__dot" aria-label="a node is selected" />}
          </span>
          <span className="rs-tabbar__lbl">{TABS[t].label}</span>
        </button>
      ))}
    </nav>
  );
}
