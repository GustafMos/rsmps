/**
 * The editor store: one document, selection, view and UI prefs, with undo/redo as a stack of
 * GraphDoc references (the pure helpers in engine/graph share structure, so this is cheap).
 */
import { createStore, type Store } from './createStore';
import {
  addNode,
  batchCount,
  connect,
  connectError,
  disconnect,
  outputNodes,
  removeNodes,
  setParam,
  uid,
  updateNode,
  createGraph,
} from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { Edge, FrameBox, GraphDoc, InputSchema, NodeInstance, OutputSchema, ProjectSettings, SocketType } from '../../engine/types';
import type { Io } from '../../io/api';
import { autoLayout, needsLayout } from '../lib/autolayout';
import { inputsAccepting, outputsFeeding, sourceDefFor } from '../lib/sockets';
import { layoutFor } from '../lib/layout';
import { frameRects, nodeRects } from '../lib/geometry';

export type DialogId = 'export' | 'plugins' | 'presets' | 'savePreset' | 'shortcuts' | null;

export interface AddMenuRequest {
  clientX: number;
  clientY: number;
  world: { x: number; y: number };
  /** Set when a wire was dropped on empty space. side = which end is fixed. */
  link?: { side: 'out' | 'in'; node: string; port: string; type: SocketType };
}

export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
  nodeId: string | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

export interface UiPrefs {
  leftOpen: boolean;
  rightOpen: boolean;
  /** Viewer height as a fraction of the centre column. */
  split: number;
  maximized: null | 'viewer' | 'graph';
  debug: boolean;
}

export interface EditorState {
  graph: GraphDoc;
  selection: readonly string[];
  selectedFrame: string | null;
  viewedNodeId: string | null;
  item: number;
  prefs: UiPrefs;
  canUndo: boolean;
  canRedo: boolean;
  addMenu: AddMenuRequest | null;
  contextMenu: ContextMenuRequest | null;
  dialog: DialogId;
  toasts: readonly Toast[];
  /** Bumped when a different document is loaded (views re-frame). */
  docRev: number;
}

interface Clip {
  nodes: NodeInstance[];
  edges: Edge[];
}

const PREFS_KEY = 'rsmps.ui.prefs';
const RECENT_KEY = 'rsmps.ui.recent';

function loadPrefs(): UiPrefs {
  const base: UiPrefs = { leftOpen: true, rightOpen: true, split: 0.46, maximized: null, debug: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...base, ...JSON.parse(raw), maximized: null };
  } catch {
    /* storage unavailable */
  }
  return base;
}

export function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export class Editor {
  readonly store: Store<EditorState>;
  private past: GraphDoc[] = [];
  private future: GraphDoc[] = [];
  private lastKey = '';
  private lastTime = 0;
  private clip: Clip | null = null;
  private toastId = 0;

  constructor(readonly io: Io) {
    this.store = createStore<EditorState>({
      graph: createGraph(),
      selection: [],
      selectedFrame: null,
      viewedNodeId: null,
      item: 0,
      prefs: loadPrefs(),
      canUndo: false,
      canRedo: false,
      addMenu: null,
      contextMenu: null,
      dialog: null,
      toasts: [],
      docRev: 0,
    });
  }

  get registry(): Registry {
    return this.io.registry;
  }
  get state(): EditorState {
    return this.store.get();
  }
  private patch(p: Partial<EditorState>) {
    this.store.set((s) => ({ ...s, ...p }));
  }

  /* ------------------------------ documents ------------------------------ */

  loadGraph(doc: GraphDoc, keepHistory = false): void {
    let g: GraphDoc = { ...doc, nodes: doc.nodes ?? [], edges: doc.edges ?? [], frames: doc.frames ?? [] };
    g.nodes = g.nodes.map((n) => ({ ...n, x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0, params: n.params ?? {} }));
    if (needsLayout(g)) g = autoLayout(g, this.registry);
    if (keepHistory) this.past.push(this.state.graph);
    else this.past = [];
    this.future = [];
    this.lastKey = '';
    this.patch({
      graph: g,
      selection: [],
      selectedFrame: null,
      viewedNodeId: this.defaultView(g),
      item: 0,
      canUndo: this.past.length > 0,
      canRedo: false,
      docRev: this.state.docRev + 1,
    });
  }

  /** First-run / "New": Source → Output, viewed at the output. Found through the registry, no ids hard-coded. */
  newGraph(name = 'Untitled', keepHistory = false): void {
    let g = createGraph(name);
    const src = sourceDefFor(this.registry, 'image');
    const out = this.registry.list().find((d) => d.category === 'output' && Object.values(d.inputs as InputSchema).some((i) => i.type === 'image'));
    if (src && out) {
      const a = addNode(g, this.registry, src.def.id, { x: 0, y: 0 });
      const b = addNode(a.graph, this.registry, out.id, { x: 330, y: 0 });
      g = b.graph;
      const from = Object.keys(src.def.outputs).find((k) => (src.def.outputs as OutputSchema)[k].type === 'image');
      const to = Object.keys(out.inputs).find((k) => (out.inputs as InputSchema)[k].type === 'image');
      if (from && to) g = connect(g, this.registry, { node: a.node.id, port: from }, { node: b.node.id, port: to });
    }
    this.loadGraph(g, keepHistory);
  }

  private defaultView(g: GraphDoc): string | null {
    return outputNodes(g, this.registry)[0]?.id ?? g.nodes[g.nodes.length - 1]?.id ?? null;
  }

  /* ------------------------------- history -------------------------------- */

  /** Replace the document. `key` coalesces rapid edits (slider drags) into one undo step. */
  commit(next: GraphDoc, key?: string): void {
    const s = this.state;
    if (next === s.graph) return;
    const now = performance.now();
    const coalesce = key && key === this.lastKey && now - this.lastTime < 900 && this.past.length > 0;
    if (!coalesce) {
      this.past.push(s.graph);
      if (this.past.length > 300) this.past.shift();
    }
    this.future = [];
    this.lastKey = key ?? '';
    this.lastTime = now;
    this.applyGraph(next);
  }

  edit(fn: (g: GraphDoc) => GraphDoc, key?: string): void {
    try {
      this.commit(fn(this.state.graph), key);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private applyGraph(g: GraphDoc) {
    const s = this.state;
    const ids = new Set(g.nodes.map((n) => n.id));
    const selection = s.selection.filter((id) => ids.has(id));
    const viewed = s.viewedNodeId && ids.has(s.viewedNodeId) ? s.viewedNodeId : this.defaultView(g);
    const count = batchCount(g, this.registry);
    const frames = g.frames ?? [];
    this.patch({
      graph: g,
      selection: selection.length === s.selection.length ? s.selection : selection,
      selectedFrame: s.selectedFrame && frames.some((f) => f.id === s.selectedFrame) ? s.selectedFrame : null,
      viewedNodeId: viewed,
      item: Math.min(s.item, count - 1),
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    });
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.graph);
    this.lastKey = '';
    this.applyGraph(prev);
  }
  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.graph);
    this.lastKey = '';
    this.applyGraph(next);
  }

  /* ------------------------------ selection -------------------------------- */

  select(ids: readonly string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const cur = this.state.selection;
    let next: string[];
    if (mode === 'replace') next = [...ids];
    else if (mode === 'add') next = [...new Set([...cur, ...ids])];
    else {
      const set = new Set(cur);
      for (const id of ids) set.has(id) ? set.delete(id) : set.add(id);
      next = [...set];
    }
    if (next.length === cur.length && next.every((id, i) => id === cur[i])) {
      if (mode === 'replace' && this.state.selectedFrame) this.patch({ selectedFrame: null });
      return;
    }
    this.patch({ selection: next, selectedFrame: null });
  }
  selectAll(): void {
    this.patch({ selection: this.state.graph.nodes.map((n) => n.id), selectedFrame: null });
  }
  selectFrame(id: string | null): void {
    this.patch({ selectedFrame: id, selection: [] });
  }
  setViewed(id: string | null): void {
    this.patch({ viewedNodeId: id });
  }
  setItem(i: number): void {
    const count = batchCount(this.state.graph, this.registry);
    this.patch({ item: ((i % count) + count) % count });
  }

  /* -------------------------------- editing ------------------------------- */

  setParam(nodeId: string, key: string, value: unknown): void {
    this.commit(setParam(this.state.graph, nodeId, key, value), `p:${nodeId}:${key}`);
  }
  setNode(nodeId: string, patch: Partial<NodeInstance>, key?: string): void {
    this.commit(updateNode(this.state.graph, nodeId, patch), key);
  }
  setProject(patch: Partial<ProjectSettings>): void {
    const g = this.state.graph;
    this.commit({ ...g, project: { ...g.project, ...patch } }, 'project:' + Object.keys(patch).join(','));
  }
  setName(name: string): void {
    this.commit({ ...this.state.graph, name }, 'name');
  }

  moveNodes(deltas: ReadonlyMap<string, { dx: number; dy: number }>): void {
    const g = this.state.graph;
    this.commit({
      ...g,
      nodes: g.nodes.map((n) => {
        const d = deltas.get(n.id);
        return d ? { ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) } : n;
      }),
    });
  }

  connect(from: Edge['from'], to: Edge['to']): boolean {
    const err = connectError(this.state.graph, this.registry, from, to);
    if (err) {
      this.toast(err, 'error');
      return false;
    }
    this.edit((g) => connect(g, this.registry, from, to));
    return true;
  }
  disconnect(edgeId: string): void {
    this.edit((g) => disconnect(g, edgeId));
  }

  deleteSelection(): void {
    const { selection, selectedFrame, graph } = this.state;
    if (selectedFrame) {
      this.ungroup(selectedFrame);
      return;
    }
    if (!selection.length) return;
    this.edit((g) => removeNodes(g, this.registry, [...selection], true));
    void graph;
  }

  toggleBypass(id: string): void {
    const n = this.state.graph.nodes.find((x) => x.id === id);
    if (n) this.setNode(id, { bypass: !n.bypass });
  }
  toggleCollapse(ids: readonly string[]): void {
    const g = this.state.graph;
    const first = g.nodes.find((n) => n.id === ids[0]);
    if (!first) return;
    const collapsed = !first.collapsed;
    this.commit({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, collapsed } : n)) });
  }

  /** Add a node (optionally wired). Returns its id. */
  addNodeAt(type: string, at: { x: number; y: number }, link?: AddMenuRequest['link'], params?: Record<string, unknown>): string | null {
    const def = this.registry.get(type);
    if (!def) return null;
    let id = '';
    this.edit((g) => {
      const { graph, node } = addNode(g, this.registry, type, at, params);
      id = node.id;
      let next = graph;
      const tryConnect = (from: Edge['from'], to: Edge['to']) => {
        if (!connectError(next, this.registry, from, to)) {
          next = connect(next, this.registry, from, to);
          return true;
        }
        return false;
      };
      if (link) {
        if (link.side === 'out') {
          for (const port of inputsAccepting(def, link.type)) if (tryConnect({ node: link.node, port: link.port }, { node: node.id, port })) break;
        } else {
          for (const port of outputsFeeding(def, link.type)) if (tryConnect({ node: node.id, port }, { node: link.node, port: link.port })) break;
        }
      } else if (this.state.selection.length === 1) {
        const src = next.nodes.find((n) => n.id === this.state.selection[0]);
        const sdef = src && this.registry.get(src.type);
        if (src && sdef) {
          outer: for (const [out, od] of Object.entries(sdef.outputs as OutputSchema)) {
            for (const port of inputsAccepting(def, od.type)) {
              if (!(port in def.inputs)) continue; // auto-wire only real inputs, never param sockets
              if (tryConnect({ node: src.id, port: out }, { node: node.id, port })) break outer;
            }
          }
        }
      }
      return next;
    });
    if (id) this.patch({ selection: [id], selectedFrame: null });
    this.pushRecent(type);
    return id || null;
  }

  /** Create a source node holding imported assets (all of one kind) at a position. */
  addAssetNode(assetIds: string[], at: { x: number; y: number }): string | null {
    const info = this.io.library.list().find((a) => a.id === assetIds[0]);
    if (!info) return null;
    const src = sourceDefFor(this.registry, info.kind);
    if (!src) {
      this.toast(`No node can load ${info.kind} files yet.`, 'error');
      return null;
    }
    return this.addNodeAt(src.def.id, at, undefined, { [src.key]: assetIds });
  }

  /** Commit a finished node drag: positions, frame membership and optional insertion on a wire, as ONE undo step. */
  finishDrag(deltas: ReadonlyMap<string, { dx: number; dy: number }>, insertEdge: string | null): void {
    this.edit((g) => {
      let next: GraphDoc = {
        ...g,
        nodes: g.nodes.map((n) => {
          const d = deltas.get(n.id);
          return d ? { ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) } : n;
        }),
      };
      const moved = new Set(deltas.keys());
      const rects = frameRects(next, this.registry, moved);
      const nrects = nodeRects(next, this.registry);
      next = {
        ...next,
        nodes: next.nodes.map((n) => {
          if (!moved.has(n.id)) return n;
          if (n.frame && !rects.has(n.frame)) return n; // every member moved: keep the frame
          const r = nrects.get(n.id)!;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          let best: string | undefined;
          let area = Infinity;
          for (const [fid, fr] of rects) {
            if (cx >= fr.x && cx <= fr.x + fr.w && cy >= fr.y && cy <= fr.y + fr.h && fr.w * fr.h < area) {
              best = fid;
              area = fr.w * fr.h;
            }
          }
          return best === n.frame ? n : { ...n, frame: best };
        }),
      };
      next = this.pruneFrames(next);
      if (insertEdge && moved.size === 1) next = this.insertInto(next, [...moved][0], insertEdge);
      return next;
    });
  }

  insertOnEdge(nodeId: string, edgeId: string): void {
    this.edit((g) => this.insertInto(g, nodeId, edgeId));
  }

  private insertInto(g: GraphDoc, nodeId: string, edgeId: string): GraphDoc {
    const e = g.edges.find((x) => x.id === edgeId);
    const node = g.nodes.find((n) => n.id === nodeId);
    const def = node && this.registry.get(node.type);
    if (!e || !node || !def) return g;
    const ft = this.registry.get(g.nodes.find((n) => n.id === e.from.node)?.type ?? '')?.outputs[e.from.port]?.type;
    if (!ft) return g;
    const inPort = inputsAccepting(def, ft).find((p) => p in def.inputs);
    if (!inPort) return g;
    let next = disconnect(g, e.id);
    const outPort = Object.keys(def.outputs).find((p) => !connectError(next, this.registry, { node: nodeId, port: p }, e.to));
    if (!outPort || connectError(next, this.registry, e.from, { node: nodeId, port: inPort })) return g;
    next = connect(next, this.registry, e.from, { node: nodeId, port: inPort });
    return connect(next, this.registry, { node: nodeId, port: outPort }, e.to);
  }

  addReroute(edgeId: string, at: { x: number; y: number }): void {
    const def = this.registry.get('reroute');
    if (!def) return;
    this.edit((g) => {
      const e = g.edges.find((x) => x.id === edgeId);
      if (!e) return g;
      const inPort = Object.keys(def.inputs)[0];
      const outPort = Object.keys(def.outputs)[0];
      const { graph, node } = addNode(disconnect(g, e.id), this.registry, 'reroute', { x: Math.round(at.x - 20), y: Math.round(at.y - 12) });
      let next = graph;
      next = connect(next, this.registry, e.from, { node: node.id, port: inPort });
      return connect(next, this.registry, { node: node.id, port: outPort }, e.to);
    });
  }

  /* ----------------------------- clipboard -------------------------------- */

  copy(): void {
    const { selection, graph } = this.state;
    if (!selection.length) return;
    const set = new Set(selection);
    this.clip = {
      nodes: graph.nodes.filter((n) => set.has(n.id)).map((n) => structuredClone(n)),
      edges: graph.edges.filter((e) => set.has(e.from.node) && set.has(e.to.node)).map((e) => structuredClone(e)),
    };
    this.toast(`Copied ${selection.length} node${selection.length > 1 ? 's' : ''}`, 'info');
  }

  paste(at?: { x: number; y: number }): void {
    const clip = this.clip;
    if (!clip || !clip.nodes.length) return;
    const minX = Math.min(...clip.nodes.map((n) => n.x));
    const minY = Math.min(...clip.nodes.map((n) => n.y));
    const off = at ? { x: at.x - minX, y: at.y - minY } : { x: 32, y: 32 };
    const map = new Map<string, string>();
    const nodes = clip.nodes.map((n) => {
      const id = uid('n');
      map.set(n.id, id);
      return { ...structuredClone(n), id, x: Math.round(n.x + off.x), y: Math.round(n.y + off.y), frame: undefined };
    });
    const edges = clip.edges.map((e) => ({ id: uid('e'), from: { ...e.from, node: map.get(e.from.node)! }, to: { ...e.to, node: map.get(e.to.node)! } }));
    this.edit((g) => ({ ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] }));
    this.patch({ selection: nodes.map((n) => n.id), selectedFrame: null });
    if (!at) this.clip = { nodes: nodes.map((n) => ({ ...n })), edges };
  }

  duplicate(): void {
    const saved = this.clip;
    this.copy();
    this.paste();
    this.clip = saved ?? this.clip;
  }

  /* -------------------------------- frames -------------------------------- */

  groupSelection(): void {
    const { selection } = this.state;
    if (!selection.length) return;
    const palette = ['#5b8def', '#c77dff', '#4dd6a8', '#f2c14e', '#ef6f9c', '#58c4dd'];
    const id = uid('f');
    this.edit((g) => {
      const frames = g.frames ?? [];
      const frame: FrameBox = { id, label: 'Frame', color: palette[frames.length % palette.length] };
      return { ...g, frames: [...frames, frame], nodes: g.nodes.map((n) => (selection.includes(n.id) ? { ...n, frame: id } : n)) };
    });
    this.patch({ selectedFrame: id, selection: [] });
  }
  ungroup(frameId: string): void {
    this.edit((g) => ({
      ...g,
      frames: (g.frames ?? []).filter((f) => f.id !== frameId),
      nodes: g.nodes.map((n) => (n.frame === frameId ? { ...n, frame: undefined } : n)),
    }));
  }
  removeFromFrame(ids: readonly string[]): void {
    this.edit((g) => this.pruneFrames({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, frame: undefined } : n)) }));
  }
  setNodeFrame(ids: readonly string[], frame: string): void {
    this.edit((g) => ({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, frame } : n)) }));
  }
  updateFrame(id: string, patch: Partial<FrameBox>): void {
    this.commit({ ...this.state.graph, frames: (this.state.graph.frames ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)) }, `frame:${id}:${Object.keys(patch)}`);
  }
  private pruneFrames(g: GraphDoc): GraphDoc {
    const used = new Set(g.nodes.map((n) => n.frame).filter(Boolean));
    return { ...g, frames: (g.frames ?? []).filter((f) => used.has(f.id)) };
  }

  autoLayout(onlySelection = false): void {
    const sel = this.state.selection;
    this.edit((g) => autoLayout(g, this.registry, onlySelection && sel.length > 1 ? new Set(sel) : undefined));
    void layoutFor;
  }

  /* ----------------------------------- ui --------------------------------- */

  setPrefs(p: Partial<UiPrefs>): void {
    const prefs = { ...this.state.prefs, ...p };
    this.patch({ prefs });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, maximized: null }));
    } catch {
      /* ignore */
    }
  }
  openAddMenu(req: AddMenuRequest | null): void {
    this.patch({ addMenu: req, contextMenu: null });
  }
  openContextMenu(req: ContextMenuRequest | null): void {
    this.patch({ contextMenu: req, addMenu: null });
  }
  openDialog(d: DialogId): void {
    this.patch({ dialog: d, addMenu: null, contextMenu: null });
  }
  toast(text: string, kind: Toast['kind'] = 'info'): void {
    const id = ++this.toastId;
    this.patch({ toasts: [...this.state.toasts.slice(-3), { id, kind, text }] });
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 7000 : 3000);
  }
  dismissToast(id: number): void {
    this.patch({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }
  private pushRecent(type: string) {
    try {
      const list = [type, ...getRecent().filter((t) => t !== type)].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }
}
