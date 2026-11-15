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
  moveWire,
  wiresInto,
  setParam,
  uid,
  updateNode,
  createGraph,
} from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { Edge, FrameBox, GraphDoc, InputSchema, NodeInstance, OutputSchema, ProjectSettings, SocketType } from '../../engine/types';
import type { Io, OpenProject } from '../../io/api';
import { autoLayout, needsLayout } from '../lib/autolayout';
import { outputType } from '../../engine/graph';
import { firstImagePort, inputsAccepting, outputsFeeding, paletteInputPort, sourceDefFor } from '../lib/sockets';
import { layoutFor } from '../lib/layout';
import { frameRects, nodeRects } from '../lib/geometry';

export type DialogId = 'export' | 'plugins' | 'presets' | 'savePreset' | 'shortcuts' | 'keymap' | 'palette' | null;

export interface AddMenuRequest {
  clientX: number;
  clientY: number;
  world: { x: number; y: number };
  /** Opened with Shift+Space: focus lands on the recent nodes so Enter adds one at once. */
  quick?: boolean;
  /** Set when a wire was dropped on empty space. side = which end is fixed. */
  link?: { side: 'out' | 'in'; node: string; port: string; type: SocketType };
}

export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
  nodeId: string | null;
  /** Right-click on a parameter row of the node. */
  paramKey?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  actions?: { label: string; run: () => void }[];
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
  /** Output node whose frame non-output previews use (the last selected output). */
  activeOutput: string | null;
  /** Open projects (tabs): metadata only. Only the active one has a graph in memory. */
  projects: OpenProject[];
  activeProject: string | null;
  /** Name of the project being loaded (editing is blocked meanwhile). */
  switching: string | null;
  /** Socket picker for a dragged wire dropped on a node (or "drive a parameter"). */
  socketPicker: { node: string; from: { node: string; port: string; type: SocketType }; x: number; y: number } | null;
  /** One-time support prompt currently visible. */
  supportPrompt: 'export' | 'close' | null;
  /** Running export (progress shown in a floating bar). */
  exportJob: { label: string; fraction: number } | null;
  /** Top-level tab: the node editor or the print-scan-back tool. */
  mode: 'edit' | 'scan';
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

/** The output whose frame previews use: the last selected output, else the first output node. */
export function resolveActiveOutput(s: EditorState, registry: Registry): string | null {
  const isOut = (id: string | null) => !!id && registry.get(s.graph.nodes.find((n) => n.id === id)?.type ?? '')?.category === 'output';
  if (isOut(s.activeOutput)) return s.activeOutput;
  return s.graph.nodes.find((n) => registry.get(n.type)?.category === 'output')?.id ?? null;
}

export class Editor {
  readonly store: Store<EditorState>;
  private past: GraphDoc[] = [];
  private future: GraphDoc[] = [];
  private lastKey = '';
  private lastTime = 0;
  private clip: Clip | null = null;
  private toastId = 0;
  private holds = 0;
  private holdPushed = false;
  /** Palette studio target (node + palette param) when opened from an inspector. */
  studioTarget: { nodeId: string; key: string } | null = null;

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
      mode: 'edit',
      activeOutput: null,
      projects: [],
      activeProject: null,
      switching: null,
      exportJob: null,
      supportPrompt: null,
      socketPicker: null,
    });
  }

  get registry(): Registry {
    return this.io.registry;
  }
  get state(): EditorState {
    return this.store.get();
  }
  private patch(p: Partial<EditorState>) {
    if (p.selection) {
      const g = p.graph ?? this.state.graph;
      const outs = p.selection.filter((id) => this.registry.get(g.nodes.find((n) => n.id === id)?.type ?? '')?.category === 'output');
      if (outs.length) p = { ...p, activeOutput: outs[outs.length - 1] };
    }
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
    this.loadGraph(this.makeStarterGraph(name), keepHistory);
  }

  /** Set by project switching: the next graph change is a load, not an edit (do not save / mark dirty). */
  skipSave = false;

  private makeStarterGraph(name: string): GraphDoc {
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
    return g;
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
    const coalesce = key && key === this.lastKey && (this.holds > 0 ? this.holdPushed : now - this.lastTime < 900) && this.past.length > 0;
    if (!coalesce) {
      if (this.holds > 0) this.holdPushed = true;
      this.past.push(s.graph);
      if (this.past.length > 300) this.past.shift();
    }
    this.future = [];
    this.lastKey = key ?? '';
    this.lastTime = now;
    this.applyGraph(next);
  }

  /** While held, edits sharing a key form ONE undo step (a whole drag or popover session). */
  beginHold(): void {
    if (this.holds++ === 0) {
      this.holdPushed = false;
      this.lastKey = '';
    }
  }
  /** cancel = drop the edits made during the hold (Esc in a picker). */
  endHold(cancel = false): void {
    if (this.holds === 0) return;
    this.holds--;
    if (this.holds > 0) return;
    if (cancel && this.holdPushed) {
      const prev = this.past.pop();
      if (prev) this.applyGraph(prev);
    }
    this.holdPushed = false;
    this.lastKey = '';
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
  setActiveOutput(id: string): void {
    this.patch({ activeOutput: id });
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
    this.rememberPending(nodeId, key, value);
    this.commit(setParam(this.state.graph, nodeId, key, value), `p:${nodeId}:${key}`);
  }
  /** Remember the in-flight edit so a reload after a render that never finished can offer to revert it. */
  private rememberPending(nodeId: string, key: string, value: unknown): void {
    try {
      const node = this.state.graph.nodes.find((n) => n.id === nodeId);
      if (!node || JSON.stringify(value).length > 300) return;
      const prevRaw = sessionStorage.getItem('rsmps.pendingEdit');
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      const same = prev && prev.nodeId === nodeId && prev.key === key && Date.now() - prev.at < 15000;
      const def = this.registry.get(node.type);
      const label = `${node.label || def?.title || node.type} · ${(def?.params as Record<string, { label?: string }> | undefined)?.[key]?.label ?? key}`;
      sessionStorage.setItem('rsmps.pendingEdit', JSON.stringify({ nodeId, key, label, oldValue: same ? prev.oldValue : node.params[key], newValue: value, at: Date.now() }));
    } catch {
      /* storage unavailable */
    }
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

  /** Connect, then (for multi inputs) place the new wire at layer position `slot`. */
  connectSlot(g: GraphDoc, from: Edge['from'], to: Edge['to'], slot?: number): GraphDoc {
    let next = connect(g, this.registry, from, to);
    if (slot !== undefined) {
      const group = wiresInto(next, to.node, to.port);
      const mine = group[group.length - 1];
      if (mine) next = moveWire(next, mine.id, slot - (group.length - 1));
    }
    return next;
  }
  moveLayerPure(g: GraphDoc, edgeId: string, delta: number): GraphDoc {
    return moveWire(g, edgeId, delta);
  }
  connect(from: Edge['from'], to: Edge['to'], slot?: number): boolean {
    const err = connectError(this.state.graph, this.registry, from, to);
    if (err) {
      this.toast(err, 'error');
      return false;
    }
    this.edit((g) => this.connectSlot(g, from, to, slot));
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
        if (src && sdef) next = this.insertInChain(next, src.id, node.id);
      }
      return this.withPalette(next, node.id, false) ?? next;
    });
    if (id) this.patch({ selection: [id], selectedFrame: null });
    this.pushRecent(type);
    return id || null;
  }

  /**
   * Insert a freshly added node into the chain after `srcId`: wire the source's first output into the new node's
   * first compatible input, then re-route every wire that left that output so it comes from the new node instead
   * (when the types fit), keeping layer order on multi inputs. Downstream nodes are pushed right when needed.
   */
  private insertInChain(g: GraphDoc, srcId: string, newId: string): GraphDoc {
    const src = g.nodes.find((n) => n.id === srcId)!;
    const nn = g.nodes.find((n) => n.id === newId)!;
    const sdef = this.registry.get(src.type)!;
    const ndef = this.registry.get(nn.type)!;
    const srcOuts = Object.entries(sdef.outputs as OutputSchema);
    const GAP = 60;
    const srcW = layoutFor(g, src, sdef).width;
    const newW = layoutFor(g, nn, ndef).width;
    const move = (gr: GraphDoc, id: string, x: number, y: number): GraphDoc => ({ ...gr, nodes: gr.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) });
    if (!srcOuts.length) return g;
    const [outPort, outDef] = srcOuts[0];
    const from = { node: srcId, port: outPort };
    const inPort = inputsAccepting(ndef, outDef.type).find((p) => p in ndef.inputs);
    if (!inPort) return move(g, newId, src.x, src.y + layoutFor(g, src, sdef).height + 40); // a generator: just sits next to the selection
    const downstream = g.edges.filter((e) => e.from.node === srcId && e.from.port === outPort);
    let next = connect(g, this.registry, from, { node: newId, port: inPort });
    const newOut = Object.keys(ndef.outputs)[0];
    const rerouted: Edge[] = [];
    if (newOut) {
      for (const e of downstream) {
        const target = { node: newId, port: newOut };
        if (connectError(disconnect(next, e.id), this.registry, target, e.to)) continue;
        const tdef = this.registry.get(next.nodes.find((n) => n.id === e.to.node)?.type ?? '');
        const multi = !!(tdef?.inputs as Record<string, { multi?: boolean }> | undefined)?.[e.to.port]?.multi;
        const pos = wiresInto(next, e.to.node, e.to.port).findIndex((x) => x.id === e.id);
        next = connect(disconnect(next, e.id), this.registry, target, e.to);
        if (multi && pos >= 0) {
          const group = wiresInto(next, e.to.node, e.to.port);
          next = moveWire(next, group[group.length - 1].id, pos - (group.length - 1));
        }
        rerouted.push(e);
      }
    }
    // place the new node between the source and its former consumers, pushing everything downstream right if needed
    let x = src.x + srcW + GAP;
    const y = src.y;
    if (rerouted.length) {
      const consumers = new Set(rerouted.map((e) => e.to.node));
      const minX = Math.min(...[...consumers].map((id) => next.nodes.find((n) => n.id === id)!.x));
      const shift = x + newW + GAP - minX;
      if (shift > 0) {
        const down = new Set<string>();
        const stack = [...consumers];
        while (stack.length) {
          const id = stack.pop()!;
          if (down.has(id) || id === newId || id === srcId) continue;
          down.add(id);
          for (const e of next.edges) if (e.from.node === id) stack.push(e.to.node);
        }
        next = { ...next, nodes: next.nodes.map((n) => (down.has(n.id) ? { ...n, x: n.x + shift } : n)) };
      }
    }
    x = Math.round(x);
    return move(next, newId, x, Math.round(y));
  }

  /**
   * Generic palette wiring: when a node has an unwired palette input and an image feed, add a Palette node
   * (extracted once at the current time, not following) wired into it. Returns null when not applicable.
   */
  private withPalette(g: GraphDoc, nodeId: string, custom: boolean): GraphDoc | null {
    const node = g.nodes.find((n) => n.id === nodeId);
    const def = node && this.registry.get(node.type);
    const palDef = this.registry.get('palette');
    if (!node || !def || !palDef) return null;
    const pp = paletteInputPort(def);
    if (!pp || g.edges.some((e) => e.to.node === nodeId && e.to.port === pp)) return null;
    const ip = firstImagePort(def);
    const feed = ip ? g.edges.find((e) => e.to.node === nodeId && e.to.port === ip) : undefined;
    if (!custom && !feed) return null;
    const t = Math.round(this.io.player.getState().seconds * 100) / 100;
    const params = custom ? { source: 'custom' } : { source: 'extract', frame: t, follow: false };
    const at = { x: node.x - 250, y: node.y + 150 };
    const added = addNode(g, this.registry, 'palette', at, params);
    let next = added.graph;
    const palIn = Object.keys(palDef.inputs).find((k) => (palDef.inputs as Record<string, { type: string }>)[k].type === 'image');
    const palOut = Object.keys(palDef.outputs)[0];
    if (feed && palIn) next = connect(next, this.registry, feed.from, { node: added.node.id, port: palIn });
    next = connect(next, this.registry, { node: added.node.id, port: palOut }, { node: nodeId, port: pp });
    this.lastPaletteId = added.node.id;
    return next;
  }
  private lastPaletteId = '';

  /** "Extract from image" on a node with no palette: one undo step. */
  extractPaletteFor(nodeId: string): void {
    const next = this.withPalette(this.state.graph, nodeId, false);
    if (!next) return this.toast('Connect an image to this node first, then extract a palette from it.', 'info');
    this.commit(next);
    this.patch({ selection: [this.lastPaletteId], selectedFrame: null });
  }
  /** "Create palette…": a custom Palette node wired in, then Palette Studio on it. */
  createPaletteFor(nodeId: string): void {
    const next = this.withPalette(this.state.graph, nodeId, true);
    if (!next) return this.toast('The Palette node type is not available.', 'error');
    this.commit(next);
    this.patch({ selection: [this.lastPaletteId], selectedFrame: null });
    this.studioTarget = { nodeId: this.lastPaletteId, key: 'custom' };
    this.openDialog('palette');
  }

  /**
   * Two outputs joined: the one you HELD goes on top (foreground), the one you dropped ONTO is the base.
   * Images/masks make a Merge, audio makes a Mixer. One undo step. Returns false when the pair is not mergeable.
   */
  mergeOutputs(held: Edge['from'], base: Edge['from']): boolean {
    const g0 = this.state.graph;
    const ta = outputType(g0, this.registry, held.node, held.port);
    const tb = outputType(g0, this.registry, base.node, base.port);
    const visual = (t: SocketType | null) => t === 'image' || t === 'mask';
    const kind = visual(ta) && visual(tb) ? 'merge' : ta === 'audio' && tb === 'audio' ? 'mixer' : null;
    const def = kind ? this.registry.get(kind) : undefined;
    if (!kind || !def || held.node === base.node) {
      if (kind && !def) this.toast(`The "${kind}" node type is not available.`, 'error');
      return false;
    }
    const nodeA = g0.nodes.find((n) => n.id === held.node)!;
    const nodeB = g0.nodes.find((n) => n.id === base.node)!;
    const wA = layoutFor(g0, nodeA, this.registry.get(nodeA.type)).width;
    const at = { x: Math.round(Math.max(nodeA.x, nodeB.x) + wA + 70), y: Math.round((nodeA.y + nodeB.y) / 2) };
    let newId = '';
    const viewed = this.state.viewedNodeId;
    let viewMerge = false;
    this.edit((g) => {
      const added = addNode(g, this.registry, kind, at);
      newId = added.node.id;
      let next = added.graph;
      const ins = def.inputs as Record<string, { type: string; multi?: boolean }>;
      const keys = Object.keys(ins);
      const to = (port: string) => ({ node: newId, port });
      if (kind === 'merge') {
        const bg = keys.includes('background') ? 'background' : keys[0];
        const fg = keys.includes('foreground') ? 'foreground' : keys.find((k) => k !== bg)!;
        next = connect(next, this.registry, base, to(bg));
        next = connect(next, this.registry, held, to(fg));
      } else {
        const multi = keys.find((k) => ins[k].multi) ?? keys[0];
        next = connect(next, this.registry, base, to(multi));
        next = connect(next, this.registry, held, to(multi));
      }
      const out = { node: newId, port: Object.keys(def.outputs)[0] };
      if (viewed === base.node) viewMerge = true;
      else if (viewed) {
        const feeding = next.edges.filter((e) => e.from.node === base.node && e.from.port === base.port && e.to.node === viewed);
        if (feeding.length === 1 && next.edges.filter((e) => e.to.node === viewed && e.from.node === base.node).length === 1) {
          next = connect(disconnect(next, feeding[0].id), this.registry, out, feeding[0].to);
        }
      }
      return next;
    });
    if (!newId) return false;
    this.patch({ selection: [newId], selectedFrame: null, ...(viewMerge ? { viewedNodeId: newId } : {}) });
    return true;
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
  /* ------------------------------ project tabs ------------------------------ */

  /** Boot: restore the tab list and load ONLY the active project. */
  async initProjects(): Promise<void> {
    const list = await this.io.projects.listOpen();
    let active = await this.io.projects.activeId();
    if (!active || !list.some((p) => p.id === active)) active = list[0]?.id ?? null;
    const g = active ? await this.io.projects.loadProject(active).catch(() => null) : null;
    if (active && g && g.schema === 'rsmps/graph' && g.version === 2) {
      this.skipSave = true;
      this.loadGraph(g);
      await this.io.projects.setActive(active);
      this.patch({ projects: list, activeProject: active });
      return;
    }
    this.newGraph();
    const p = await this.io.projects.createProject(this.state.graph, this.state.graph.name);
    this.patch({ projects: await this.io.projects.listOpen(), activeProject: p.id });
  }

  async refreshProjects(): Promise<void> {
    const list = await this.io.projects.listOpen();
    const active = this.state.activeProject;
    this.patch({ projects: list.map((p) => (p.id === active ? { ...p, dirty: this.state.projects.find((x) => x.id === p.id)?.dirty || p.dirty } : p)) });
  }

  /** The active tab was edited: show its name and a dirty dot without waiting for storage. */
  touchActive(): void {
    const { activeProject, projects, graph } = this.state;
    if (!activeProject) return;
    const cur = projects.find((p) => p.id === activeProject);
    if (!cur || (cur.name === graph.name && cur.dirty)) return;
    this.patch({ projects: projects.map((p) => (p.id === activeProject ? { ...p, name: graph.name, dirty: true, updatedAt: Date.now() } : p)) });
  }

  /** Save the live project with a fresh thumbnail (when leaving it) and wait until it is written. */
  private async saveWithThumb(): Promise<void> {
    const id = this.state.activeProject;
    if (!id) return;
    const blob = await this.io.player.snapshot().catch(() => null);
    this.io.projects.saveProject(id, this.state.graph, blob ?? undefined);
    await this.io.projects.flush();
  }

  /** Make a tab live: only one graph is ever in memory. Undo history is cleared (per tab session). */
  async switchTo(id: string): Promise<void> {
    const s = this.state;
    if (id === s.activeProject || s.switching) return;
    const target = s.projects.find((p) => p.id === id);
    this.patch({ switching: target?.name ?? 'project', addMenu: null, contextMenu: null });
    try {
      await this.saveWithThumb();
      const g = await this.io.switchProject(id);
      this.skipSave = true;
      if (g) this.loadGraph(g);
      else this.newGraph();
      this.patch({ activeProject: id, switching: null });
      await this.refreshProjects();
      try {
        if (!localStorage.getItem('rsmps.ui.tabUndoNote')) {
          localStorage.setItem('rsmps.ui.tabUndoNote', '1');
          this.toast('Undo history belongs to this session of a tab: switching tabs clears it, so background tabs use no memory.', 'info');
        }
      } catch {
        /* ignore */
      }
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not switch tab: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** New tab (starter graph, or the given document) and switch to it. */
  async newProjectTab(graph?: GraphDoc): Promise<void> {
    if (this.state.switching) return;
    this.patch({ switching: graph?.name ?? 'new project' });
    try {
      await this.saveWithThumb();
      const doc = graph ?? this.makeStarterGraph('Untitled');
      const p = await this.io.projects.createProject(doc, doc.name);
      const g = (await this.io.switchProject(p.id)) ?? doc;
      this.skipSave = true;
      this.loadGraph(g);
      this.patch({ activeProject: p.id, switching: null });
      await this.refreshProjects();
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not create the tab: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async closeTab(id: string): Promise<void> {
    const s = this.state;
    if (s.switching) return;
    const closing = s.projects.find((p) => p.id === id);
    try {
      if (id === s.activeProject) await this.saveWithThumb();
      else await this.io.projects.flush();
      const next = await this.io.projects.closeProject(id);
      if (id === s.activeProject) {
        if (next) {
          this.patch({ activeProject: null });
          await this.switchTo(next);
        } else {
          this.patch({ activeProject: null, projects: [] });
          await this.newProjectTab();
        }
      } else await this.refreshProjects();
      this.toast(`Closed "${closing?.name ?? 'project'}"`, 'info', [{ label: 'Reopen', run: () => void this.reopenProject(id) }]);
      setTimeout(() => this.maybeSupport('close'), 600);
    } catch (err) {
      this.toast(`Could not close the tab: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async reopenProject(id: string): Promise<void> {
    if (this.state.switching) return;
    try {
      await this.saveWithThumb();
      const p = await this.io.projects.reopen(id);
      if (!p) return this.toast('That project is no longer available.', 'error');
      this.patch({ switching: p.name });
      const g = await this.io.switchProject(p.id);
      this.skipSave = true;
      if (g) this.loadGraph(g);
      this.patch({ activeProject: p.id, switching: null });
      await this.refreshProjects();
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not reopen: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async renameTab(id: string, name: string): Promise<void> {
    const n = name.trim() || 'Untitled';
    if (id === this.state.activeProject) this.setName(n);
    else await this.io.projects.renameProject(id, n);
    this.patch({ projects: this.state.projects.map((p) => (p.id === id ? { ...p, name: n } : p)) });
  }

  async duplicateTab(id: string): Promise<void> {
    if (id === this.state.activeProject) await this.saveWithThumb();
    await this.io.projects.duplicateProject(id);
    await this.refreshProjects();
  }

  async reorderTabs(ids: string[]): Promise<void> {
    this.patch({ projects: ids.map((i) => this.state.projects.find((p) => p.id === i)!).filter(Boolean) });
    await this.io.projects.reorderOpen(ids);
  }

  /** Write the active project to a file; the tab's dirty dot clears when that succeeds. */
  async saveFile(): Promise<void> {
    const id = this.state.activeProject;
    try {
      await this.io.projects.saveToFile(this.state.graph);
      if (id) {
        await this.io.projects.markSaved(id);
        this.patch({ projects: this.state.projects.map((p) => (p.id === id ? { ...p, dirty: false } : p)) });
      }
      this.toast('Project saved', 'ok');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) this.toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** File → Open: the file becomes a NEW tab. */
  async openFileTab(): Promise<void> {
    try {
      const g = await this.io.projects.openFromFile();
      if (g) await this.newProjectTab(g);
    } catch (err) {
      this.toast(`Could not open: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /* -------------------------------- export --------------------------------- */

  private exportAbort: AbortController | null = null;
  private supportShown = new Set<string>();

  /** Each trigger shows its prompt at most once EVER (flag set when shown), never in safe mode or over another prompt. */
  maybeSupport(kind: 'export' | 'close'): void {
    if (/[?&]safe/.test(location.search) || this.state.supportPrompt || this.supportShown.has(kind)) return;
    const key = 'rsmps.ui.support.' + kind;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      /* storage unavailable: the per-session guard above still limits it to once */
    }
    this.supportShown.add(kind);
    this.patch({ supportPrompt: kind });
  }
  dismissSupport(): void {
    if (this.state.supportPrompt) this.patch({ supportPrompt: null });
  }

  exportPrefs(projectId: string | null): { items: 'current' | 'all'; zip: boolean } {
    try {
      const all = JSON.parse(localStorage.getItem('rsmps.ui.exportPrefs') ?? '{}');
      return { items: 'current', zip: true, ...(all[projectId ?? ''] ?? {}) };
    } catch {
      return { items: 'current', zip: true };
    }
  }
  setExportPrefs(projectId: string | null, p: Partial<{ items: 'current' | 'all'; zip: boolean }>): void {
    try {
      const all = JSON.parse(localStorage.getItem('rsmps.ui.exportPrefs') ?? '{}');
      all[projectId ?? ''] = { ...this.exportPrefs(projectId), ...p };
      localStorage.setItem('rsmps.ui.exportPrefs', JSON.stringify(all));
    } catch {
      /* ignore */
    }
    this.patch({ toasts: this.state.toasts }); // re-render subscribers that read prefs
  }

  /** Render and download. `outputs: []` means every enabled output. No dialog: progress is a floating bar. */
  async runExport(outputs: string[], items: 'current' | 'all', zip?: boolean): Promise<void> {
    if (this.exportAbort) return this.toast('An export is already running.', 'info');
    const s = this.state;
    const ac = new AbortController();
    this.exportAbort = ac;
    this.patch({ exportJob: { label: 'Starting…', fraction: 0 } });
    try {
      const files = await this.io.exporter.run({
        graph: s.graph,
        outputs,
        items,
        item: s.item,
        zip: zip ?? this.exportPrefs(s.activeProject).zip,
        signal: ac.signal,
        onProgress: (p) => this.patch({ exportJob: { label: p.label, fraction: p.fraction } }),
      });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.io.exporter.download(files);
      this.toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, 'ok');
      setTimeout(() => this.maybeSupport('export'), 1200);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) this.toast('Export cancelled', 'info');
      else this.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      this.exportAbort = null;
      this.patch({ exportJob: null });
    }
  }
  /** Set the active output's export type (undoable) and export just that output now. */
  exportAs(kind: string): void {
    const id = resolveActiveOutput(this.state, this.registry);
    if (!id) return this.toast('There is no output node.', 'error');
    this.setParam(id, 'kind', kind);
    void this.runExport([id], 'current');
  }
  cancelExport(): void {
    this.exportAbort?.abort();
  }

  openSocketPicker(req: EditorState['socketPicker']): void {
    this.patch({ socketPicker: req, addMenu: null, contextMenu: null });
  }
  setMode(mode: 'edit' | 'scan'): void {
    this.patch({ mode, addMenu: null, contextMenu: null });
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
  toast(text: string, kind: Toast['kind'] = 'info', actions?: Toast['actions']): void {
    const id = ++this.toastId;
    this.patch({ toasts: [...this.state.toasts.slice(-3), { id, kind, text, actions }] });
    setTimeout(() => this.dismissToast(id), actions ? 20000 : kind === 'error' ? 7000 : 3000);
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
