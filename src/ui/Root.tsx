import { useEffect, useState } from 'react';
import { batchCount, upstream } from '../engine/graph';
import type { Registry } from '../engine/define';
import type { GraphDoc } from '../engine/types';
import { App } from './App';
import { bootIo } from './boot';
import { GraphController } from './graph/controller';
import { AppProvider, type AppCtx } from './store/context';
import { Editor } from './store/editor';
import { createPlayerStore } from './store/playerStore';

/**
 * Viewing a node fed by an empty media source can only produce nothing. Passing null shows the
 * viewer's empty state instead (and keeps the player from re-rendering a result that never comes).
 */
function viewable(graph: GraphDoc, id: string | null, registry: Registry): boolean {
  if (!id) return false;
  for (const nid of upstream(graph, id)) {
    const n = graph.nodes.find((x) => x.id === nid);
    const def = n && registry.get(n.type);
    if (!n || !def || Object.keys(def.inputs as object).length) continue;
    for (const [key, p] of Object.entries(def.params as Record<string, { type: string }>)) {
      if (p.type === 'assets' && Array.isArray(n.params[key]) && (n.params[key] as unknown[]).length === 0) return false;
    }
  }
  return true;
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
        const ed = new Editor(io);
        const playerStore = createPlayerStore(io);
        const graphCtl = new GraphController();

        // keep the player and autosave in step with the document
        let lastGraph: GraphDoc | null = null;
        let lastView: string | null | undefined;
        let lastItem = -1;
        const sync = () => {
          const s = ed.state;
          if (s.graph === lastGraph && s.viewedNodeId === lastView && s.item === lastItem) return;
          const graphChanged = s.graph !== lastGraph;
          lastGraph = s.graph;
          lastView = s.viewedNodeId;
          lastItem = s.item;
          io.player.setView({ graph: s.graph, node: viewable(s.graph, s.viewedNodeId, io.registry) ? s.viewedNodeId : null, item: s.item, itemCount: batchCount(s.graph, io.registry) });
          if (graphChanged) io.projects.autosave(s.graph);
        };
        const unsub = ed.store.subscribe(sync);
        const unreg = io.registry.subscribe(() => {
          lastGraph = null; // plugin installed/removed: re-evaluate
          sync();
        });

        const saved = await io.projects.loadAutosave().catch(() => null);
        if (saved && saved.schema === 'rsmps/graph' && saved.version === 2 && Array.isArray(saved.nodes) && saved.nodes.length > 0) ed.loadGraph(saved);
        else ed.newGraph();
        sync();

        stop = () => {
          unsub();
          unreg();
        };
        setBoot({ status: 'ready', app: { io, ed, playerStore, graphCtl } });
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
        <img src="/ripscorpy-logo.png" alt="" width={64} height={64} />
        <div className="rs-boot__word">RSMPS</div>
        <div className="rs-boot__msg">Starting the GPU engine…</div>
      </div>
    );
  }
  if (boot.status === 'error') {
    return (
      <div className="rs-boot rs-boot--error" role="alert">
        <img src="/ripscorpy-logo.png" alt="" width={64} height={64} />
        <div className="rs-boot__word">Cannot start</div>
        <p className="rs-boot__big">RSMPS needs WebGPU, and this browser could not provide it.</p>
        <p className="rs-boot__msg">{boot.message}</p>
        <ul className="rs-boot__list">
          <li>Use a recent Chrome or Edge (113 or newer), or another browser with WebGPU enabled.</li>
          <li>Make sure hardware acceleration is turned on in the browser settings.</li>
          <li>Serve the page from localhost or https: WebGPU is disabled on plain http.</li>
        </ul>
        <button className="rs-btn rs-btn--primary" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  return (
    <AppProvider value={boot.app}>
      <App />
    </AppProvider>
  );
}
