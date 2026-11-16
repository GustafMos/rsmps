import { useEffect, useState } from 'react';
import { batchCount } from '../engine/graph';
import type { GraphDoc } from '../engine/types';
import { App } from './App';
import { bootIo } from './boot';
import { GraphController } from './graph/controller';
import { AppProvider, type AppCtx } from './store/context';
import { Editor, resolveActiveOutput } from './store/editor';
import { createPlayerStore } from './store/playerStore';
import { PENDING_KEY, type PendingEdit } from './watchdog';
import { beginSafety, installSafety, pushView, safetyStore } from './safety';
import { ErrorBoundary } from './components/ErrorBoundary';

/** A param edit whose render never finished last time (page reloaded within seconds): offer to revert it. */
function offerRecovery(ed: Editor): void {
  try {
    if (safetyStore.get().paused) return; // safe mode: the banner offers "Undo last change" instead
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as PendingEdit;
    if (Date.now() - p.at > 30000 || !ed.state.graph.nodes.some((n) => n.id === p.nodeId)) return;
    const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    ed.toast(`The last change (${p.label}: ${show(p.oldValue)} → ${show(p.newValue)}) did not finish rendering last time. Revert it?`, 'error', [
      { label: 'Revert', run: () => ed.setParam(p.nodeId, p.key, p.oldValue) },
      { label: 'Keep', run: () => undefined },
    ]);
  } catch {
    /* ignore */
  }
}

type Boot = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; app: AppCtx };

export function Root() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    (async () => {
      try {
        const io = await bootIo();
        if (cancelled) return;
        beginSafety(); // safe start? (unclean last run, Shift, ?safe, "Reload in safe mode"): decides before anything renders
        const ed = new Editor(io);
        const playerStore = createPlayerStore(io);
        const graphCtl = new GraphController();

        // keep the player and autosave in step with the document
        let lastGraph: GraphDoc | null = null;
        let lastView: string | null | undefined;
        let lastItem = -1;
        let lastActive: string | null | undefined;
        let lastPaused: boolean | null = null;
        let lastSaved: GraphDoc | null = null;
        let lastThumb = Date.now();
        const sync = () => {
          const s = ed.state;
          const active = resolveActiveOutput(s, io.registry);
          const paused = safetyStore.get().paused;
          if (s.graph === lastGraph && s.viewedNodeId === lastView && s.item === lastItem && active === lastActive && paused === lastPaused) return;
          lastActive = active;
          lastPaused = paused;
          const graphChanged = s.graph !== lastGraph;
          const edited = s.graph !== lastSaved;
          lastSaved = s.graph;
          lastGraph = s.graph;
          lastView = s.viewedNodeId;
          lastItem = s.item;
          pushView(io.player, { graph: s.graph, node: s.viewedNodeId, item: s.item, itemCount: batchCount(s.graph, io.registry), activeOutput: active }, paused);
          void graphChanged;
          if (edited && s.activeProject && !s.switching) {
            if (ed.skipSave) ed.skipSave = false;
            else {
              io.projects.saveProject(s.activeProject, s.graph);
              ed.touchActive();
              if (Date.now() - lastThumb > 30000) {
                lastThumb = Date.now();
                const pid = s.activeProject;
                io.player.snapshot().then((b) => b && ed.state.activeProject === pid && io.projects.saveProject(pid, ed.state.graph, b)).catch(() => undefined);
              }
            }
          }
        };
        const unsub = ed.store.subscribe(sync);
        const unsubSafety = safetyStore.subscribe(sync);
        const unreg = io.registry.subscribe(() => {
          lastGraph = null; // plugin installed/removed: re-evaluate
          sync();
        });

        await ed.initProjects();
        offerRecovery(ed);
        sync();

        const app: AppCtx = { io, ed, playerStore, graphCtl };
        const uninstall = installSafety(app);
        stop = () => {
          uninstall();
          unsubSafety();
          unsub();
          unreg();
        };
        setBoot({ status: 'ready', app });
      } catch (err) {
        if (!cancelled) setBoot({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  if (boot.status === 'loading') {
    return (
      <div className="rs-boot">
        <img src={`${import.meta.env.BASE_URL}ripscorpy-logo.png`} alt="" width={96} height={96} />
        <div className="rs-boot__word">RSMPS</div>
        <div className="rs-boot__msg">Starting the GPU engine…</div>
      </div>
    );
  }
  if (boot.status === 'error') {
    return (
      <div className="rs-boot rs-boot--error" role="alert">
        <img src={`${import.meta.env.BASE_URL}ripscorpy-logo.png`} alt="" width={96} height={96} />
        <div className="rs-boot__word">Cannot start</div>
        <p className="rs-boot__big">{/webgpu|adapter|gpu/i.test(boot.message) ? 'RSMPS needs WebGPU, and this browser could not provide it.' : 'RSMPS could not start.'}</p>
        <p className="rs-boot__msg">{boot.message}</p>
        {/webgpu|adapter|gpu/i.test(boot.message) && (
        <ul className="rs-boot__list">
          <li>Use a recent Chrome or Edge (113 or newer), or another browser with WebGPU enabled.</li>
          <li>Make sure hardware acceleration is turned on in the browser settings.</li>
          <li>Serve the page from localhost or https: WebGPU is disabled on plain http.</li>
        </ul>
        )}
        <button className="rs-btn rs-btn--primary" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  return (
    <AppProvider value={boot.app}>
      <ErrorBoundary app={boot.app}>
        <App />
      </ErrorBoundary>
    </AppProvider>
  );
}
