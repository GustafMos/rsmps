/**
 * The editor store: one document, selection, view and UI prefs, with undo/redo as a stack of
 * GraphDoc references (the pure helpers in engine/graph share structure, so this is cheap).
 */
import { createStore, type Store } from './createStore';
import { withProcessResult } from '../../engine/process';
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
  withEffectiveDuration,
} from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { AssetInfo, Edge, FrameBox, GraphDoc, InputSchema, NodeInstance, OutputSchema, ProjectSettings, SocketType } from '../../engine/types';
import type { Io, OpenProject } from '../../io/api';
import { autoLayout, needsLayout } from '../lib/autolayout';
import { pushBelow, separateMoved } from '../lib/separate';
import { inputType, outputType, upstream } from '../../engine/graph';
import { createScanProject } from '../scan/session';
import { buildLayeredScanGraph, guideRemovalStep } from '../scan/scanGraph';
import { reconcileMediaEdits, type DescribeSource } from '../../engine/lib/media-edit-graph';
import { clipMap } from '../../engine/lib/media-time';
import { DEFAULT_CLIP_SECONDS } from '../../engine/lib/media-edit';
import { applyTake, normalizeTimeline, type LoopRecordMode } from '../../engine/audio/timeline';
import { rateForFirstVideo } from '../lib/firstVideoRate';
import { soundToWire } from '../lib/exportSound';
import { firstImagePort, inputsAccepting, outputsFeeding, paletteInputPort, sourceDefFor } from '../lib/sockets';
import { layoutFor } from '../lib/layout';
import { frameRects, nodeRects } from '../lib/geometry';
import { convertNode, describeDropped } from '../lib/convert';
import {
  addBoundaryPort,
  defOf,
  editExposed,
  exposeParam,
  GROUP_IN,
  GROUP_OUT,
  GROUP_TYPE,
  groupProblem,
  isBoundaryNode,
  isPathId,
  levelGraph,
  makeGroup,
  NEW_PORT,
  nodeAtPath,
  PATH_SEP,
  removeBoundaryPort,
  renameGroupPort,
  ungroupNode,
  unexposeParam,
  validateGroupNode,
  validPath,
  withLevel,
  withoutProcessResults,
  type GroupKind,
} from '../../engine/group';
import { processParamsPatch } from '../../engine/process';
import type { AnyNodeDef } from '../../engine/types';

/** A port name from the socket it was made from. */
function portName(def: AnyNodeDef | undefined, port: string, dir: 'in' | 'out'): string {
  if (!def) return port;
  const d = dir === 'out' ? (def.outputs as Record<string, { label?: string }>)[port] : ((def.inputs as Record<string, { label?: string }>)[port] ?? (def.params as Record<string, { label?: string }>)[port]);
  return d?.label ?? port;
}

export type DialogId = 'export' | 'blankSheets' | 'backups' | 'about' | 'plugins' | 'presets' | 'savePreset' | 'saveNode' | 'shortcuts' | 'keymap' | 'palette' | null;

/** A question shown in the app's own dialog (`Editor.ask`), never a browser `confirm`. */
export interface ConfirmRequest {
  title: string;
  text: string;
  /** Optional bullet list under the text. */
  items?: string[];
  ok: string;
  cancel?: string;
}

export interface AddMenuRequest {
  clientX: number;
  clientY: number;
  world: { x: number; y: number };
  /** Opened with Shift+Space: focus lands on the recent nodes so Enter adds one at once. */
  quick?: boolean;
  /** Set when a wire was dropped on empty space. side = which end is fixed. */
  link?: { side: 'out' | 'in'; node: string; port: string; type: SocketType };
  /** The new node is spliced into this wire. */
  insertEdge?: string;
  /** Opened by right-click / long-press on empty graph: adds Paste and Select all. */
  context?: boolean;
}

export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
  nodeId: string | null;
  /** Right-click on a parameter row of the node. */
  paramKey?: string;
  /** Right-click on a wire (nodeId is then null). */
  edgeId?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  actions?: { label: string; run: () => void }[];
  /** How many times the same message arrived while it was still on screen (shown as ×N). */
  count?: number;
}

export interface UiPrefs {
  leftOpen: boolean;
  rightOpen: boolean;
  /** Viewer height as a fraction of the centre column. */
  split: number;
  maximized: null | 'viewer' | 'graph';
  debug: boolean;
  /** Snap dragged nodes to an 8 px grid on drop (default on). */
  gridSnap?: boolean;
}

export interface EditorState {
  /** The document (top level, with groups): what is evaluated, saved and undone. */
  graph: GraphDoc;
  /** Open groups, outermost first (ids from the top level down). Empty = the top level is shown. */
  path: readonly string[];
  /**
   * What the node editor shows and edits: the document itself at the top level, or the inside of the open group (with its boundary nodes
   * `@in` / `@out`). Selection and node ids in the graph view are ids of this level; `viewedNodeId` is a full path.
   */
  level: GraphDoc;
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
  /** Timeline node whose editor panel is open. */
  timelineNode: string | null;
  /** The track armed for recording. */
  armed: { nodeId: string; track: string; kind: 'audio' | 'midi' } | null;
  /** Stage of a scan tab: 1 = photos, 2 = clean up & export (the node editor). */
  scanStage: 1 | 2;
  /** Top-level tab: the node editor or the print-scan-back tool. */
  mode: 'edit' | 'scan';
  /** The question `ask` is waiting on (rendered by the dialog host). */
  confirm: ConfirmRequest | null;
  /** "Save group as node…": the group (full path id) the dialog saves. */
  saveNodeTarget: string | null;
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
/** True for a scan tab (kind comes from the newer project storage). */
function kindOf(p: object | undefined | null): boolean {
  return (p as { kind?: string } | undefined)?.kind === 'scan';
}

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
    const first = createGraph();
    this.store = createStore<EditorState>({
      graph: first,
      path: [],
      level: first,
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
      scanStage: 1,
      timelineNode: null,
      armed: null,
      supportPrompt: null,
      socketPicker: null,
      confirm: null,
      saveNodeTarget: null,
    });
  }

  get registry(): Registry {
    return this.io.registry;
  }
  get state(): EditorState {
    return this.store.get();
  }
  /** The graph shown in the node editor (top level, or the inside of the open group). */
  get level(): GraphDoc {
    return this.state.level;
  }
  /** Full path id of a node of the shown level (what the engine, the viewer and processes use). */
  fullId(levelId: string): string {
    return this.state.path.length ? [...this.state.path, levelId].join(PATH_SEP) : levelId;
  }
  private patch(p: Partial<EditorState>) {
    if (p.graph !== undefined || p.path !== undefined) {
      const root = p.graph ?? this.state.graph;
      const path = validPath(root, p.path ?? this.state.path);
      p = { ...p, path: path.length === this.state.path.length && path.every((x, i) => x === this.state.path[i]) && p.path === undefined ? this.state.path : path, level: levelGraph(root, path) };
    }
    if (p.selection && !(p.path ?? this.state.path).length) {
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
    g = withEffectiveDuration(g, this.registry);
    if (keepHistory) this.past.push(this.state.graph);
    else this.past = [];
    this.future = [];
    this.lastKey = '';
    this.patch({
      graph: g,
      path: [],
      selection: [],
      selectedFrame: null,
      viewedNodeId: this.defaultView(g),
      item: 0,
      canUndo: this.past.length > 0,
      canRedo: false,
      docRev: this.state.docRev + 1,
    });
    this.syncHeights();
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

  /** What a newly wired source is, for the Media Timeline: label and natural length (Media In knows its file). */
  private describeSource: DescribeSource = ({ node, port }, to) => {
    const def = defOf(this.registry, node);
    const name = node.label || def?.title || node.type;
    if (node.type === 'media-in' && (port === 'image' || port === 'audio')) {
      const ids = node.params.assets;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
      const info = id ? this.io.library.list().find((a) => a.id === id) : null;
      if (info && id) {
        if (info.kind !== 'video') return { name: info.name || name, duration: DEFAULT_CLIP_SECONDS };
        const p = { trim: Array.isArray(node.params.trim) ? (node.params.trim as number[]) : [0, 1], fps: Number(node.params.fps) || 0, offset: 0, loopVideo: true };
        const m = clipMap({ duration: info.duration, fps: info.fps }, p);
        const hasAudio = info.hasAudio && node.params.mute !== true;
        return { name: info.name || name, duration: m.span / m.rate, asset: hasAudio || to === 'sounds' ? id : undefined, assetIn: m.a, hasAudio };
      }
    }
    return { name, duration: 0 };
  };

  /** Replace the document. `key` coalesces rapid edits (slider drags) into one undo step. */
  commit(next: GraphDoc, key?: string): void {
    const s = this.state;
    if (next === s.graph) return;
    // The first video in a project that still has the default frame rate: the project takes the clip's rate (same undo step).
    const clipRate = rateForFirstVideo(s.graph, next, (id) => this.io.library.assetInfo(id) ?? undefined);
    if (clipRate) {
      next = { ...next, project: { ...next.project, fps: clipRate } };
      this.toast(`Project frame rate set to ${clipRate} fps to match the clip.`, 'info');
    }
    // Media Timeline bookkeeping: new / removed / reordered wires update its edit, and a node that sets the project length sets it.
    next = withEffectiveDuration(reconcileMediaEdits(s.graph, next, this.describeSource), this.registry);
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
    this.reflow();
  }

  /** Heights the layout had when last looked at (to see which nodes grew or shrank), and what each growth pushed. */
  private heights = new Map<string, number>();
  private pushed = new Map<string, Map<string, number>>();

  /** Start over from the current graph without moving anything (after load / undo / redo). */
  syncHeights(): void {
    const g = this.level;
    this.heights = new Map(g.nodes.map((n) => [n.id, layoutFor(g, n, defOf(this.registry, n)).height]));
    this.pushed.clear();
  }

  /** Briefly animate node moves that the app made (not the user): see `.rs-slide` in node.css. */
  private slide(): void {
    if (typeof document === 'undefined') return;
    document.body.classList.add('rs-slide');
    window.setTimeout(() => document.body.classList.remove('rs-slide'), 220);
  }

  /**
   * A node got taller (a param wired, "N more…" expanded, a layer list grew): push the nodes below it down. It got shorter:
   * pull back only what its own growth pushed. Positions change without a history entry of their own.
   */
  reflow(): void {
    const g0 = this.level;
    let g = g0;
    const cur = new Map(g0.nodes.map((n) => [n.id, layoutFor(g0, n, defOf(this.registry, n)).height]));
    for (const [id, h] of cur) {
      const prev = this.heights.get(id);
      if (prev === undefined) continue;
      const d = h - prev;
      if (d > 0.5) {
        const res = pushBelow(g, this.registry, id);
        g = res.graph;
        const rec = this.pushed.get(id) ?? new Map<string, number>();
        for (const [k, v] of res.moved) rec.set(k, (rec.get(k) ?? 0) + v);
        this.pushed.set(id, rec);
      } else if (d < -0.5) {
        const rec = this.pushed.get(id);
        if (rec) {
          let left = -d;
          const up = new Map<string, number>();
          for (const [k, v] of rec) {
            const take = Math.min(v, left);
            if (take > 0) {
              up.set(k, take);
              rec.set(k, v - take);
            }
          }
          if (up.size) g = { ...g, nodes: g.nodes.map((n) => (up.has(n.id) ? { ...n, y: Math.round(n.y - up.get(n.id)!) } : n)) };
        }
      }
    }
    this.heights = cur;
    if (g !== g0) {
      this.slide();
      this.applyGraph(this.state.path.length ? withLevel(this.state.graph, this.state.path, g) : g);
    }
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
      const g0 = this.state.graph;
      // nothing may end up on top of another node: slide added / moved nodes to free space, push neighbours down for growth
      const made = fn(g0);
      const separated = separateMoved(g0, made, this.registry);
      if (separated !== made) this.slide();
      this.commit(separated, key);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /**
   * Replace the shown level (the top level, or the inside of the open group): the edited level is written back into its group, then
   * committed like any edit (one undo step; `key` coalesces). Media Timeline bookkeeping runs on the level that was edited.
   */
  commitLevel(next: GraphDoc, key?: string): void {
    const path = this.state.path;
    if (!path.length) return this.commit(next, key);
    const level = this.level;
    if (next === level) return;
    next = reconcileMediaEdits(level, next, this.describeSource);
    this.commit(withLevel(this.state.graph, path, next), key);
  }

  /** `edit` for the shown level: `fn` gets the level's graph and returns it edited (errors become a toast). */
  editLevel(fn: (g: GraphDoc) => GraphDoc, key?: string): void {
    if (!this.state.path.length) return this.edit(fn, key);
    try {
      const g0 = this.level;
      const made = fn(g0);
      const separated = separateMoved(g0, made, this.registry);
      if (separated !== made) this.slide();
      this.commitLevel(separated, key);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private applyGraph(g: GraphDoc) {
    const s = this.state;
    const path = validPath(g, s.path);
    const ids = new Set(levelGraph(g, path).nodes.map((n) => n.id));
    const selection = path.length === s.path.length ? s.selection.filter((id) => ids.has(id)) : [];
    const viewed = s.viewedNodeId && (g.nodes.some((n) => n.id === s.viewedNodeId) || (isPathId(s.viewedNodeId) && nodeAtPath(g, s.viewedNodeId))) ? s.viewedNodeId : this.defaultView(g);
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
    this.syncHeights();
  }
  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.graph);
    this.lastKey = '';
    this.applyGraph(next);
    this.syncHeights();
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
    this.patch({ selection: this.level.nodes.map((n) => n.id), selectedFrame: null });
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
    this.commitLevel(setParam(this.level, nodeId, key, value), `p:${nodeId}:${key}`);
  }
  /** Remember the in-flight edit so a reload after a render that never finished can offer to revert it. */
  private rememberPending(nodeId: string, key: string, value: unknown): void {
    try {
      const node = this.level.nodes.find((n) => n.id === nodeId);
      if (!node || JSON.stringify(value).length > 300) return;
      const prevRaw = localStorage.getItem('rsmps.pendingEdit');
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      const same = prev && prev.nodeId === nodeId && prev.key === key && Date.now() - prev.at < 15000;
      const def = defOf(this.registry, node);
      const label = `${node.label || def?.title || node.type} · ${(def?.params as Record<string, { label?: string }> | undefined)?.[key]?.label ?? key}`;
      localStorage.setItem('rsmps.pendingEdit', JSON.stringify({ nodeId, key, label, oldValue: same ? prev.oldValue : node.params[key], newValue: value, at: Date.now() }));
    } catch {
      /* storage unavailable */
    }
  }
  setNode(nodeId: string, patch: Partial<NodeInstance>, key?: string): void {
    this.commitLevel(updateNode(this.level, nodeId, patch), key);
  }
  setProject(patch: Partial<ProjectSettings>): void {
    const g = this.state.graph;
    this.commit({ ...g, project: { ...g.project, ...patch } }, 'project:' + Object.keys(patch).join(','));
  }
  setName(name: string): void {
    this.commit({ ...this.state.graph, name }, 'name');
  }

  moveNodes(deltas: ReadonlyMap<string, { dx: number; dy: number }>): void {
    const g = this.level;
    this.commitLevel({
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
    // Inside an open group: a wire onto the "+" socket of a boundary node adds a group port of the wire's type.
    if (from.node === GROUP_IN && from.port === NEW_PORT) {
      const it = inputType(this.level, this.registry, to.node, to.port);
      if (!it) return false;
      const name = portName(defOf(this.registry, this.level.nodes.find((n) => n.id === to.node)), to.port, 'in');
      this.editLevel((g) => {
        const added = addBoundaryPort(g, 'in', it.type, name);
        return this.connectSlot(added.graph, { node: GROUP_IN, port: added.port }, to, slot);
      });
      return true;
    }
    if (to.node === GROUP_OUT && to.port === NEW_PORT) {
      const ot = outputType(this.level, this.registry, from.node, from.port);
      if (!ot) return false;
      const name = portName(defOf(this.registry, this.level.nodes.find((n) => n.id === from.node)), from.port, 'out');
      this.editLevel((g) => {
        const added = addBoundaryPort(g, 'out', ot, name);
        return this.connectSlot(added.graph, from, { node: GROUP_OUT, port: added.port });
      });
      return true;
    }
    const err = connectError(this.level, this.registry, from, to);
    if (err) {
      this.toast(err, 'error');
      return false;
    }
    this.editLevel((g) => this.connectSlot(g, from, to, slot));
    return true;
  }
  disconnect(edgeId: string): void {
    this.editLevel((g) => disconnect(g, edgeId));
  }

  deleteSelection(): void {
    const { selection, selectedFrame, graph } = this.state;
    if (selectedFrame) {
      this.ungroup(selectedFrame);
      return;
    }
    // the boundary of an open group stays (remove a port from the group's inspector instead)
    const ids = selection.filter((id) => !isBoundaryNode(this.level.nodes.find((n) => n.id === id)));
    if (!ids.length) return;
    this.editLevel((g) => removeNodes(g, this.registry, ids, true));
    void graph;
  }

  toggleBypass(id: string): void {
    const n = this.level.nodes.find((x) => x.id === id);
    if (n) this.setNode(id, { bypass: !n.bypass });
  }
  toggleCollapse(ids: readonly string[]): void {
    const g = this.level;
    const first = g.nodes.find((n) => n.id === ids[0]);
    if (!first) return;
    const collapsed = !first.collapsed;
    this.commitLevel({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, collapsed } : n)) });
  }

  /** Add a node (optionally wired). Returns its id. */
  addNodeAt(type: string, at: { x: number; y: number }, link?: AddMenuRequest['link'], params?: Record<string, unknown>): string | null {
    const def = this.registry.get(type);
    if (!def) return null;
    let id = '';
    this.editLevel((g) => {
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
        const sdef = src && defOf(this.registry, src);
        if (src && sdef) next = this.insertInChain(next, src.id, node.id);
      }
      return this.withPalette(next, node.id, false) ?? next;
    });
    if (id) this.patch({ selection: [id], selectedFrame: null });
    this.pushRecent(type);
    return id || null;
  }

  /**
   * "Enable audio": when the picture comes from a video with sound (or a Media Timeline) and no Audio Output plays anything,
   * add an Audio Output and wire that sound into it, so what is heard is what is exported. One undo step. Returns the new
   * node's id, or null when nothing was needed.
   */
  ensureAudioOutput(): string | null {
    const g0 = this.state.graph;
    const src = soundToWire(g0, this.registry, (id) => this.io.library.assetInfo(id), this.state.item);
    const out = this.registry.list().find((d) => d.category === 'output' && !!d.audio);
    if (!src || !out || !this.level.nodes.some((n) => n.id === src.node.id)) return null; // the source sits inside a group: leave the graph alone
    const inPort = Object.keys(out.inputs).find((k) => (out.inputs as InputSchema)[k].type === 'audio');
    if (!inPort) return null;
    let id = '';
    this.editLevel((g) => {
      const srcNode = g.nodes.find((n) => n.id === src.node.id)!;
      // under the picture output this sound belongs to, else to the right of the source
      const picture = g.nodes.find((n) => this.registry.get(n.type)?.category === 'output' && upstream(g, n.id).has(srcNode.id));
      const at = picture ? { x: picture.x, y: picture.y + layoutFor(g, picture, defOf(this.registry, picture)).height + 40 } : { x: srcNode.x + layoutFor(g, srcNode, defOf(this.registry, srcNode)).width + 60, y: srcNode.y + 200 };
      const added = addNode(g, this.registry, out.id, at);
      if (connectError(added.graph, this.registry, { node: srcNode.id, port: src.port }, { node: added.node.id, port: inPort })) return g;
      id = added.node.id;
      return connect(added.graph, this.registry, { node: srcNode.id, port: src.port }, { node: added.node.id, port: inPort });
    });
    if (!id) return null;
    this.toast('Audio Output added and wired: this is the sound you hear and the sound that is exported.', 'info');
    return id;
  }

  /**
   * Insert a freshly added node into the chain after `srcId`: wire the source's first output into the new node's
   * first compatible input, then re-route every wire that left that output so it comes from the new node instead
   * (when the types fit), keeping layer order on multi inputs. Downstream nodes are pushed right when needed.
   */
  private insertInChain(g: GraphDoc, srcId: string, newId: string): GraphDoc {
    const src = g.nodes.find((n) => n.id === srcId)!;
    const nn = g.nodes.find((n) => n.id === newId)!;
    const sdef = defOf(this.registry, src)!;
    const ndef = defOf(this.registry, nn)!;
    const srcOuts = Object.entries(sdef.outputs as OutputSchema);
    const GAP = 60;
    const srcW = layoutFor(g, src, sdef).width;
    const newW = layoutFor(g, nn, ndef).width;
    const move = (gr: GraphDoc, id: string, x: number, y: number): GraphDoc => ({ ...gr, nodes: gr.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) });
    if (!srcOuts.length) return g;
    // The first output the new node can take: an image effect joins the picture chain, a sound effect the sound chain
    // (Media In has both; the picture output comes first, so "the first output" alone left sound effects unwired).
    const accepting = (type: string) => inputsAccepting(ndef, type as never).find((p) => p in ndef.inputs);
    const [outPort, outDef] = srcOuts.find(([, o]) => accepting(o.type)) ?? srcOuts[0];
    const from = { node: srcId, port: outPort };
    const inPort = accepting(outDef.type);
    if (!inPort) return move(g, newId, src.x, src.y + layoutFor(g, src, sdef).height + 40); // a generator: just sits next to the selection
    const downstream = g.edges.filter((e) => e.from.node === srcId && e.from.port === outPort);
    let next = connect(g, this.registry, from, { node: newId, port: inPort });
    return this.takeOver(next, from, newId, downstream).graph;
  }

  /**
   * The new node `newId` takes over the downstream wires of output `from` (those in `downstream`) when its first output can
   * feed them, keeping their position among a multi input's wires; wires that do not fit stay. The node is then placed between
   * `from`'s node and its former consumers, pushing everything downstream right if there is no room.
   */
  private takeOver(g: GraphDoc, from: Edge['from'], newId: string, downstream: Edge[], place?: { x: number; y: number }): { graph: GraphDoc; rerouted: number } {
    const srcId = from.node;
    const src = g.nodes.find((n) => n.id === srcId)!;
    const nn = g.nodes.find((n) => n.id === newId)!;
    const ndef = defOf(this.registry, nn)!;
    const srcW = layoutFor(g, src, defOf(this.registry, src)).width;
    const newW = layoutFor(g, nn, ndef).width;
    const GAP = 60;
    const move = (gr: GraphDoc, id: string, x: number, y: number): GraphDoc => ({ ...gr, nodes: gr.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) });
    let next = g;
    const newOut = Object.keys(ndef.outputs)[0];
    const rerouted: Edge[] = [];
    if (newOut) {
      for (const e of downstream) {
        const target = { node: newId, port: newOut };
        if (connectError(disconnect(next, e.id), this.registry, target, e.to)) continue;
        // two outputs joined into one node that fed the same consumer socket: it now gets the new node's output once
        if (next.edges.some((x) => x.from.node === newId && x.from.port === newOut && x.to.node === e.to.node && x.to.port === e.to.port)) {
          next = disconnect(next, e.id);
          rerouted.push(e);
          continue;
        }
        const tdef = defOf(this.registry, next.nodes.find((n) => n.id === e.to.node));
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
    let x = place ? Math.max(place.x, src.x + srcW + GAP) : src.x + srcW + GAP;
    const y = place ? place.y : src.y;
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
    return { graph: move(next, newId, x, Math.round(y)), rerouted: rerouted.length };
  }

  /**
   * "Keep this look": put a Render Scale node (scale = `percent`, Smooth) in front of the viewed Output, or right after the viewed node when
   * that is not an Output, so the export looks like the preview. One undo step; the new node is selected. A Render Scale that already sits
   * there is updated instead of stacking another. Returns the Render Scale node's id (null when nothing could be done; a toast says why).
   */
  keepPreviewLook(percent: number): string | null {
    const type = 'render-scale';
    const pct = Math.min(100, Math.max(5, Math.round(percent * 10) / 10));
    const g0 = this.state.graph;
    const viewed = g0.nodes.find((n) => n.id === this.state.viewedNodeId);
    const vdef = viewed && defOf(this.registry, viewed);
    if (!viewed || !vdef) {
      this.toast('Nothing is being viewed. Click the eye on a node first.', 'info');
      return null;
    }
    if (!this.registry.get(type)) {
      this.toast('The Render Scale node type is not available.', 'error');
      return null;
    }
    const done = (id: string, verb: string) => {
      this.patch({ selection: [id], selectedFrame: null });
      this.toast(`Render Scale ${pct}% ${verb}`, 'ok');
      return id;
    };
    const update = (id: string) => {
      this.setParam(id, 'scale', pct);
      return done(id, 'updated');
    };
    if (viewed.type === type) return update(viewed.id);

    let newId = '';
    if (vdef.category === 'output') {
      const inPort = Object.keys(vdef.inputs).find((k) => (vdef.inputs as Record<string, { type: string }>)[k].type === 'image');
      const wire = inPort ? g0.edges.find((e) => e.to.node === viewed.id && e.to.port === inPort) : undefined;
      if (!wire) {
        this.toast('Connect an image to the Output first.', 'info');
        return null;
      }
      const up = g0.nodes.find((n) => n.id === wire.from.node);
      if (up?.type === type) return update(up.id);
      this.edit((g) => {
        const added = addNode(g, this.registry, type, { x: 0, y: 0 }, { scale: pct, filter: 'smooth' });
        newId = added.node.id;
        const next = connect(added.graph, this.registry, wire.from, { node: newId, port: 'image' });
        return this.takeOver(next, wire.from, newId, [wire]).graph;
      });
    } else {
      const outPort = Object.entries(vdef.outputs as OutputSchema).find(([, o]) => o.type === 'image')?.[0];
      if (!outPort) {
        this.toast('Render Scale works on pictures: view a node that produces an image.', 'info');
        return null;
      }
      this.edit((g) => {
        const added = addNode(g, this.registry, type, { x: 0, y: 0 }, { scale: pct, filter: 'smooth' });
        newId = added.node.id;
        const from = { node: viewed.id, port: outPort };
        const inPort = 'image';
        let next = connect(added.graph, this.registry, from, { node: newId, port: inPort });
        next = this.takeOver(next, from, newId, g.edges.filter((e) => e.from.node === viewed.id && e.from.port === outPort)).graph;
        return next;
      });
    }
    return newId && this.state.graph.nodes.some((n) => n.id === newId) ? done(newId, 'added') : null;
  }

  /**
   * Generic palette wiring: when a node has an unwired palette input and an image feed, add a Palette node
   * (extracted once at the current time, not following) wired into it. Returns null when not applicable.
   */
  private withPalette(g: GraphDoc, nodeId: string, custom: boolean): GraphDoc | null {
    const node = g.nodes.find((n) => n.id === nodeId);
    const def = node && defOf(this.registry, node);
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
    const next = this.withPalette(this.level, nodeId, false);
    if (!next) return this.toast('Connect an image to this node first, then extract a palette from it.', 'info');
    this.commitLevel(next);
    this.patch({ selection: [this.lastPaletteId], selectedFrame: null });
  }
  /** "Create palette…": a custom Palette node wired in, then Palette Studio on it. */
  createPaletteFor(nodeId: string): void {
    const next = this.withPalette(this.level, nodeId, true);
    if (!next) return this.toast('The Palette node type is not available.', 'error');
    this.commitLevel(next);
    this.patch({ selection: [this.lastPaletteId], selectedFrame: null });
    this.studioTarget = { nodeId: this.lastPaletteId, key: 'custom' };
    this.openDialog('palette');
  }

  /**
   * Two outputs joined: the one you HELD goes on top (foreground), the one you dropped ONTO is the base.
   * Images/masks make a Merge, audio makes a Mixer. One undo step. Returns false when the pair is not mergeable.
   */
  mergeOutputs(held: Edge['from'], base: Edge['from']): boolean {
    const g0 = this.level;
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
    const wA = layoutFor(g0, nodeA, defOf(this.registry, nodeA)).width;
    const at = { x: Math.round(Math.max(nodeA.x, nodeB.x) + wA + 70), y: Math.round((nodeA.y + nodeB.y) / 2) };
    let newId = '';
    const viewed = this.state.viewedNodeId;
    let viewMerge = false;
    this.editLevel((g) => {
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
      if (viewed === base.node || viewed === held.node) viewMerge = true;
      // like chain insertion: the Merge is spliced into the chain. Every wire leaving EITHER joined output that the Merge can feed
      // follows the Merge (dropping a fresh node onto a wired one, or the other way round, both mean "insert it there"). Wires that
      // would make a loop stay where they are; a consumer that had both outputs on one socket gets the Merge once.
      const leaving = (o: Edge['from']) => g.edges.filter((e) => e.from.node === o.node && e.from.port === o.port);
      const res = this.takeOver(next, base, newId, [...leaving(base), ...leaving(held)], at);
      next = res.graph;
      if (!res.rerouted) next = { ...next, nodes: next.nodes.map((n) => (n.id === newId ? { ...n, x: at.x, y: at.y } : n)) };
      return next;
    });
    if (!newId) return false;
    this.patch({ selection: [newId], selectedFrame: null, ...(viewMerge ? { viewedNodeId: newId } : {}) });
    return true;
  }

  /** "Type" dropdown / "Convert to…": turn a node into another member of its family in place. One undo step. */
  convertNodeType(id: string, newType: string): boolean {
    const res = convertNode(this.level, this.registry, id, newType);
    if (res.error) {
      this.toast(res.error, 'error');
      return false;
    }
    if (res.graph === this.level) return true;
    this.commitLevel(res.graph);
    const lost = describeDropped(res.dropped);
    if (lost) this.toast(`Converted to ${this.registry.get(newType)?.title ?? newType}: ${lost}.`, 'info');
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
  finishDrag(deltas: ReadonlyMap<string, { dx: number; dy: number }>, insertEdge: string | null, detachId?: string): void {
    this.editLevel((g0) => {
      // Shift-drag: lift the node out of its chain first (its source feeds its former consumers, like delete-with-heal)
      let g = g0;
      const lifted = detachId ? g0.nodes.find((n) => n.id === detachId) : undefined;
      if (lifted) {
        const healed = removeNodes(g0, this.registry, [lifted.id], true);
        g = { ...healed, nodes: [...healed.nodes, lifted] };
      }
      let next: GraphDoc = {
        ...g,
        nodes: g.nodes.map((n) => {
          const d = deltas.get(n.id);
          if (!d) return n;
          const q = (v: number) => (this.state.prefs.gridSnap === false ? Math.round(v) : Math.round(v / 8) * 8);
          return { ...n, x: q(n.x + d.dx), y: q(n.y + d.dy) };
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
    this.editLevel((g) => this.insertInto(g, nodeId, edgeId));
  }

  private insertInto(g: GraphDoc, nodeId: string, edgeId: string): GraphDoc {
    const e = g.edges.find((x) => x.id === edgeId);
    const node = g.nodes.find((n) => n.id === nodeId);
    const def = node && defOf(this.registry, node);
    if (!e || !node || !def) return g;
    const ft = defOf(this.registry, g.nodes.find((n) => n.id === e.from.node))?.outputs[e.from.port]?.type;
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
    this.editLevel((g) => {
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
    const { selection } = this.state;
    const graph = this.level;
    // the boundary of an open group is not a node that can be copied
    const set = new Set(selection.filter((id) => !isBoundaryNode(graph.nodes.find((n) => n.id === id))));
    if (!set.size) return;
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
      // a copy never shares a stored process result (bake, analysis) with the original: it starts unprocessed
      return { ...withoutProcessResults(structuredClone(n), this.clearOf), id, x: Math.round(n.x + off.x), y: Math.round(n.y + off.y), frame: undefined };
    });
    const edges = clip.edges.map((e) => ({ id: uid('e'), from: { ...e.from, node: map.get(e.from.node)! }, to: { ...e.to, node: map.get(e.to.node)! } }));
    this.editLevel((g) => ({ ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] }));
    this.patch({ selection: nodes.map((n) => n.id), selectedFrame: null });
    if (!at) this.clip = { nodes: nodes.map((n) => ({ ...n })), edges };
  }

  hasClipboard(): boolean {
    return !!this.clip && this.clip.nodes.length > 0;
  }

  cut(): void {
    if (!this.state.selection.length) return;
    this.copy();
    this.deleteSelection();
  }

  duplicate(): void {
    const saved = this.clip;
    this.copy();
    this.paste();
    this.clip = saved ?? this.clip;
  }

  /* -------------------------------- groups -------------------------------- */

  /** Params patch that clears a node's stored process result (for copies), or null. */
  private clearOf = (n: NodeInstance): Record<string, unknown> | null => {
    if (n.type === GROUP_TYPE) return null; // withoutProcessResults drops a group's own handle
    const def = this.registry.get(n.type);
    return def?.process ? processParamsPatch(def, null) : null;
  };

  /**
   * Ctrl+G: the selected nodes become one group node wired exactly like them (`kind` 'repeat': a Repeat group). One undo step. Returns the
   * group's id, or null (a toast says why). The viewer keeps showing what it showed (a viewed node that went inside is followed by path).
   */
  groupNodes(kind: GroupKind = 'group', ids: readonly string[] = this.state.selection): string | null {
    const sel = [...ids];
    const problem = groupProblem(this.level, this.registry, sel);
    if (problem) {
      this.toast(problem, 'info');
      return null;
    }
    let gid = '';
    const v = this.state.viewedNodeId;
    this.editLevel((g) => {
      const r = makeGroup(g, this.registry, sel, { kind });
      gid = r.group.id;
      return r.graph;
    });
    if (!gid || !this.level.nodes.some((n) => n.id === gid)) return null;
    const moved = v ? sel.find((id) => this.fullId(id) === v) : undefined;
    this.patch({ selection: [gid], selectedFrame: null, ...(moved ? { viewedNodeId: this.fullId(gid) + PATH_SEP + moved } : {}) });
    return gid;
  }

  /** Ctrl+Shift+G: put the selected groups' insides back in place (exposed values and wires kept). One undo step. */
  ungroupNodes(ids: readonly string[] = this.state.selection): string[] {
    const groups = ids.filter((id) => this.level.nodes.find((n) => n.id === id)?.type === GROUP_TYPE);
    if (!groups.length) {
      if (this.state.selectedFrame) this.ungroup(this.state.selectedFrame);
      else this.toast('Select a group node to ungroup it.', 'info');
      return [];
    }
    const out: string[] = [];
    const v = this.state.viewedNodeId;
    let viewed: string | null = null;
    this.editLevel((g) => {
      let next = g;
      for (const gid of groups) {
        const r = ungroupNode(next, gid);
        next = r.graph;
        out.push(...r.ids);
        // the viewer was showing a node inside: it is now a node of this level
        const prefix = this.fullId(gid) + PATH_SEP;
        const inner = v && v.startsWith(prefix) ? v.slice(prefix.length) : '';
        if (inner && !inner.includes(PATH_SEP) && r.ids.includes(inner)) viewed = this.fullId(inner);
      }
      return next;
    });
    this.patch({ selection: out, selectedFrame: null, ...(viewed ? { viewedNodeId: viewed } : {}) });
    return out;
  }

  /** Open a group node of the shown level (double-click, Tab): the graph view shows its inside. */
  enterGroup(id: string): void {
    const n = this.level.nodes.find((x) => x.id === id);
    if (n?.type !== GROUP_TYPE) return;
    this.patch({ path: [...this.state.path, id], selection: [], selectedFrame: null, addMenu: null, contextMenu: null, socketPicker: null });
    this.syncHeights();
  }

  /** Close open groups (Esc, the breadcrumb). `depth` = how many levels stay open (0 = the top level). The group left is selected. */
  exitGroup(depth = this.state.path.length - 1): void {
    const path = this.state.path;
    if (!path.length) return;
    const keep = Math.max(0, Math.min(path.length - 1, depth));
    const left = path[keep];
    this.patch({ path: path.slice(0, keep), selection: left ? [left] : [], selectedFrame: null, addMenu: null, contextMenu: null, socketPicker: null });
    this.syncHeights();
  }

  /** Edit the level at `path` (not necessarily the shown one) as one undo step. */
  private editAt(path: readonly string[], fn: (g: GraphDoc) => GraphDoc, key?: string): void {
    try {
      const root = this.state.graph;
      const level = levelGraph(root, path);
      const next = fn(level);
      if (next !== level) this.commit(withLevel(root, path, next), key);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /**
   * Show an inner param on its group ("Expose on group"). `groupPath` = the full path of the group (default: the open group, for a node
   * of the shown level). The group's value starts as the inner value.
   */
  exposeParam(innerId: string, param: string, label?: string, groupPath: readonly string[] = this.state.path): void {
    if (!groupPath.length) return this.toast('Open a group (double-click it) to expose its parameters.', 'info');
    const gid = groupPath[groupPath.length - 1];
    this.editAt(groupPath.slice(0, -1), (g) => exposeParam(g, gid, innerId, param, this.registry, label));
  }

  /** Stop showing an exposed param (`groupId` is a node of the shown level). Its value goes back inside. */
  unexposeParam(groupId: string, exposedId: string): void {
    this.editLevel((g) => unexposeParam(g, groupId, exposedId));
  }

  /** Rename or reorder the exposed params of a group of the shown level. */
  editExposed(groupId: string, patch: { rename?: Record<string, string>; order?: string[] }): void {
    this.editLevel((g) => editExposed(g, groupId, patch), `exposed:${groupId}`);
  }

  /** Rename a port of a group of the shown level. */
  renameGroupPort(groupId: string, dir: 'in' | 'out', port: string, name: string): void {
    this.editLevel((g) => renameGroupPort(g, groupId, dir, port, name), `port:${groupId}:${port}`);
  }

  /** Title, colour stripe (a category key), icon and description of a group of the shown level. */
  setGroupInfo(groupId: string, patch: { title?: string; color?: string; icon?: string; description?: string }): void {
    this.editLevel(
      (g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === groupId && n.type === GROUP_TYPE ? { ...n, params: { ...n.params, ...patch } } : n)) }),
      `groupinfo:${groupId}:${Object.keys(patch).join(',')}`,
    );
  }

  /** Remove a port of a group (`groupId` of the shown level; default: the open group) and the wires that used it, inside and outside. */
  removeGroupPort(side: 'in' | 'out', port: string, groupId?: string): void {
    if (groupId) return this.editAt([...this.state.path, groupId], (g) => removeBoundaryPort(g, side, port));
    if (!this.state.path.length) return;
    this.editLevel((g) => removeBoundaryPort(g, side, port));
  }

  /** Add a group node made elsewhere (a saved node, an imported file) at a position: an editable copy, never a live link. */
  addGroupNode(group: NodeInstance, at: { x: number; y: number }, link?: AddMenuRequest['link']): string | null {
    const problems = validateGroupNode(group, this.registry);
    if (problems.length) {
      this.toast(`This group cannot be added: ${problems[0]}.`, 'error');
      return null;
    }
    const id = uid('g');
    const node: NodeInstance = { ...withoutProcessResults(structuredClone(group), this.clearOf), id, x: Math.round(at.x), y: Math.round(at.y), frame: undefined };
    this.editLevel((g) => {
      let next: GraphDoc = { ...g, nodes: [...g.nodes, node] };
      const def = defOf(this.registry, node);
      if (link && def) {
        // opened from a dragged wire: connect it to the first socket that fits, like any added node
        const ports = link.side === 'out' ? inputsAccepting(def, link.type) : outputsFeeding(def, link.type);
        for (const port of ports) {
          const from = link.side === 'out' ? { node: link.node, port: link.port } : { node: id, port };
          const to = link.side === 'out' ? { node: id, port } : { node: link.node, port: link.port };
          if (!connectError(next, this.registry, from, to)) {
            next = connect(next, this.registry, from, to);
            break;
          }
        }
      }
      return next;
    });
    this.patch({ selection: [id], selectedFrame: null });
    return id;
  }

  /* -------------------------------- frames -------------------------------- */

  groupSelection(): void {
    const { selection } = this.state;
    if (!selection.length) return;
    const palette = ['#5b8def', '#c77dff', '#4dd6a8', '#f2c14e', '#ef6f9c', '#58c4dd'];
    const id = uid('f');
    this.editLevel((g) => {
      const frames = g.frames ?? [];
      const frame: FrameBox = { id, label: 'Frame', color: palette[frames.length % palette.length] };
      return { ...g, frames: [...frames, frame], nodes: g.nodes.map((n) => (selection.includes(n.id) ? { ...n, frame: id } : n)) };
    });
    this.patch({ selectedFrame: id, selection: [] });
  }
  ungroup(frameId: string): void {
    this.editLevel((g) => ({
      ...g,
      frames: (g.frames ?? []).filter((f) => f.id !== frameId),
      nodes: g.nodes.map((n) => (n.frame === frameId ? { ...n, frame: undefined } : n)),
    }));
  }
  removeFromFrame(ids: readonly string[]): void {
    this.editLevel((g) => this.pruneFrames({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, frame: undefined } : n)) }));
  }
  setNodeFrame(ids: readonly string[], frame: string): void {
    this.editLevel((g) => ({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, frame } : n)) }));
  }
  updateFrame(id: string, patch: Partial<FrameBox>): void {
    this.commitLevel({ ...this.level, frames: (this.level.frames ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)) }, `frame:${id}:${Object.keys(patch)}`);
  }
  private pruneFrames(g: GraphDoc): GraphDoc {
    const used = new Set(g.nodes.map((n) => n.frame).filter(Boolean));
    return { ...g, frames: (g.frames ?? []).filter((f) => used.has(f.id)) };
  }

  autoLayout(onlySelection = false): void {
    const sel = this.state.selection;
    this.editLevel((g) => autoLayout(g, this.registry, onlySelection && sel.length > 1 ? new Set(sel) : undefined));
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
    if (active && kindOf(list.find((p) => p.id === active))) {
      const sg = await this.io.projects.loadProject(active).catch(() => null);
      this.skipSave = true;
      this.loadGraph(sg ?? createGraph());
      await this.io.projects.setActive(active);
      this.patch({ projects: list, activeProject: active, mode: 'scan', scanStage: sg && sg.nodes.length ? 2 : 1 });
      return;
    }
    const g = active ? await this.io.projects.loadProject(active).catch(() => null) : null;
    if (active && g && g.schema === 'rsmps/graph' && g.version === 2) {
      this.skipSave = true;
      this.loadGraph(g);
      // stored process results (bakes, analyses) that no node of this project references any more: copies, undone bakes
      void this.io.processes.prune(active, g, { unreferenced: true }).catch(() => undefined);
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
      const scan = kindOf(target);
      if (g) this.loadGraph(g);
      else if (scan) this.loadGraph(createGraph());
      else this.newGraph();
      this.patch({ activeProject: id, switching: null, mode: scan ? 'scan' : 'edit', scanStage: scan && g && g.nodes.length ? 2 : 1 });
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
      this.patch({ activeProject: p.id, switching: null, mode: 'edit' });
      await this.refreshProjects();
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not create the tab: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** A scan is a tab of its own kind (needs the newer project storage). */
  async newScanTab(): Promise<void> {
    if (this.state.switching) return;
    this.patch({ switching: 'new scan' });
    try {
      await this.saveWithThumb();
      const p = await createScanProject(this.io, 'Scan');
      await this.io.switchProject(p.id);
      this.skipSave = true;
      this.loadGraph(createGraph());
      this.patch({ activeProject: p.id, switching: null, mode: 'scan', scanStage: 1 });
      await this.refreshProjects();
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not create the scan tab: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  openTimeline(id: string | null): void {
    this.patch({ timelineNode: id });
  }

  /* ------------------------------- recording ------------------------------- */

  armTrack(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void {
    this.io.audio.arm(nodeId, target);
    this.patch({ armed: target ? { nodeId, ...target } : null });
  }

  /** Record from a click: starts audio if needed, then capture (count-in and transport are handled by the IO layer). */
  async startRecording(): Promise<void> {
    try {
      await this.io.audio.record();
    } catch (err) {
      this.toast(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Stop, store the audio and put the take on the armed track (one undo step). */
  async stopRecording(): Promise<void> {
    const armed = this.state.armed;
    try {
      const r = await this.io.audio.stop();
      if (!r) {
        if (armed) this.toast('Nothing was recorded. Play a note or some sound after pressing Record.', 'info');
        return;
      }
      if (!armed) return;
      const node = this.state.graph.nodes.find((n) => n.id === armed.nodeId);
      if (!node) return;
      const tl = normalizeTimeline(node.params.clips);
      const trackName = tl.tracks.find((t) => t.id === armed.track)?.name ?? 'Take';
      const mode = (String(node.params.loopRecordMode ?? 'overdub') as LoopRecordMode);
      const res = applyTake(tl, r.take, { mode, assetIds: r.assets.map((a) => a.id), name: trackName });
      this.setParam(armed.nodeId, 'clips', res.timeline);
      this.toast(`Recorded ${r.take.kind === 'midi' ? 'MIDI' : 'audio'} on "${trackName}"`, 'ok');
    } catch (err) {
      this.toast(`Recording failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** One-click record source for a Timeline node: Microphone -> recordAudio or MIDI Keyboard -> recordMidi (guarded by the registry). */
  addRecordSource(nodeId: string, kind: 'audio' | 'midi'): void {
    const node = this.level.nodes.find((n) => n.id === nodeId);
    const type = kind === 'audio' ? 'microphone' : 'midi-keyboard';
    const def = this.registry.get(type);
    if (!node || !def) return this.toast(`The "${type}" node is not available.`, 'error');
    const outPort = kind === 'audio' ? 'tap' : Object.keys(def.outputs)[0];
    this.editLevel((g) => {
      const added = addNode(g, this.registry, type, { x: node.x - 260, y: node.y + (kind === 'audio' ? 0 : 160) });
      return connect(added.graph, this.registry, { node: added.node.id, port: outPort }, { node: nodeId, port: kind === 'audio' ? 'recordAudio' : 'recordMidi' });
    });
  }

  /** The hidden working sequence owned by the active scan tab (created by `io.scan.attach`). */
  scanAsset(): AssetInfo | undefined {
    const id = this.state.activeProject;
    return this.io.library.list({ includeHidden: true }).find((a) => (a as { owner?: string }).owner === id);
  }

  /** Every hidden working sequence of the active scan tab (one per paper layer). */
  scanAssets(): AssetInfo[] {
    const id = this.state.activeProject;
    return this.io.library.list({ includeHidden: true }).filter((a) => (a as { owner?: string }).owner === id);
  }

  setScanStage(stage: 1 | 2): void {
    if (stage === 2 && !this.ensureScanGraph()) return;
    this.patch({ scanStage: stage });
  }

  /**
   * First visit to stage 2: build the scan project's own clean-up chain from the node types that exist right now.
   * Nodes carry labels so the Quick settings strip can find them.
   */
  ensureScanGraph(): boolean {
    if (this.state.graph.nodes.length) return true;
    const asset = this.scanAsset();
    if (!asset) {
      this.toast('Add photos first: the clean-up graph works on the recovered frames.', 'info');
      return false;
    }
    const layers = this.scanAssets();
    if (layers.length > 1) {
      // sheets with several paper layers: one source per layer, stacked with alpha
      const lg = buildLayeredScanGraph(this.registry, this.state.projects.find((p) => p.id === this.state.activeProject)?.name ?? 'Scan', layers);
      if (lg) {
        this.loadGraph(lg);
        return true;
      }
    }
    const src = sourceDefFor(this.registry, asset.kind === 'image' ? 'image' : 'video');
    const out = this.registry.list().find((d) => d.category === 'output' && (d.params as Record<string, { type: string }>).kind?.type === 'enum' && 'codec' in d.params);
    if (!src || !out) {
      this.toast('The Media In or Output node type is not available.', 'error');
      return false;
    }
    let g = createGraph(this.state.projects.find((p) => p.id === this.state.activeProject)?.name ?? 'Scan');
    g = { ...g, project: { ...g.project, width: asset.width, height: asset.height, fps: asset.fps || 12, duration: asset.duration || g.project.duration, loop: false } };
    const chain: { id: string; label: string; params: Record<string, unknown> }[] = [{ id: src.def.id, label: 'Scanned frames', params: { [src.key]: [asset.id] } }];
    // rotoscope sheets: take the printed guide out first ("Keep only what I drew")
    const removal = guideRemovalStep(this.registry, asset);
    if (removal) chain.push(removal);
    // newer chain: paper-clean -> levels -> upscale-smart; older registries fall back to levels -> resize
    if (this.registry.get('paper-clean')) chain.push({ id: 'paper-clean', label: 'Clean paper', params: {} });
    if (this.registry.get('levels')) chain.push({ id: 'levels', label: 'Contrast', params: {} });
    if (this.registry.get('upscale-smart')) chain.push({ id: 'upscale-smart', label: 'Upscale', params: { mode: 'lineart', by: 'height', height: asset.height } });
    else if (this.registry.get('resize')) chain.push({ id: 'resize', label: 'Upscale', params: { mode: 'height', height: asset.height, filter: 'area' } });
    chain.push({ id: out.id, label: 'Export', params: { kind: 'video', name: 'scan' } });
    let prev: { node: string; port: string } | null = null;
    let x = 0;
    for (const c of chain) {
      const added = addNode(g, this.registry, c.id, { x, y: 0 }, c.params);
      g = { ...added.graph, nodes: added.graph.nodes.map((n) => (n.id === added.node.id ? { ...n, label: c.label } : n)) };
      const d = this.registry.get(c.id)!;
      if (prev) {
        const to = Object.keys(d.inputs).find((k) => (d.inputs as InputSchema)[k].type === 'image');
        if (to) g = connect(g, this.registry, prev, { node: added.node.id, port: to });
      }
      const o = Object.keys(d.outputs)[0];
      prev = o ? { node: added.node.id, port: o } : null;
      x += 280;
    }
    this.loadGraph(g);
    return true;
  }

  /** A graph project with Media In (this asset) -> Output, opened in a new tab. */
  async openAssetInNewProject(assetId: string, name: string): Promise<void> {
    const info = this.io.library.list().find((a) => a.id === assetId);
    const src = info && sourceDefFor(this.registry, info.kind === 'image' ? 'image' : 'video');
    if (!info || !src) return this.toast('That media is not available.', 'error');
    let g = createGraph(name);
    g = { ...g, project: { ...g.project, width: info.width, height: info.height, fps: info.fps || 12, duration: info.duration || g.project.duration } };
    const a = addNode(g, this.registry, src.def.id, { x: 0, y: 0 }, { [src.key]: [assetId] });
    const out = this.registry.list().find((d) => d.category === 'output' && Object.values(d.inputs as InputSchema).some((i) => i.type === 'image'));
    let doc = a.graph;
    if (out) {
      const b = addNode(doc, this.registry, out.id, { x: 330, y: 0 });
      doc = connect(b.graph, this.registry, { node: a.node.id, port: Object.keys(src.def.outputs)[0] }, { node: b.node.id, port: Object.keys(out.inputs).find((k) => (out.inputs as InputSchema)[k].type === 'image')! });
    }
    await this.newProjectTab(doc);
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
      const scan = kindOf(p);
      if (g) this.loadGraph(g);
      else if (scan) this.loadGraph(createGraph());
      this.patch({ activeProject: p.id, switching: null, mode: scan ? 'scan' : 'edit', scanStage: scan && g && g.nodes.length ? 2 : 1 });
      await this.refreshProjects();
    } catch (err) {
      this.patch({ switching: null });
      this.toast(`Could not reopen: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async renameTab(id: string, name: string): Promise<void> {
    const n = name.trim() || 'Untitled';
    const isScan = kindOf(this.state.projects.find((p) => p.id === id));
    if (id === this.state.activeProject && !isScan) this.setName(n);
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
  async runExport(outputs: string[], items: 'current' | 'all', zip?: boolean, audioFormat?: 'wav' | 'm4a' | 'webm'): Promise<void> {
    await this.runExportGraph(this.state.graph, outputs, items, this.state.item, zip ?? this.exportPrefs(this.state.activeProject).zip, audioFormat);
  }

  /** Export any graph (e.g. a throwaway one) through the floating progress bar. Resolves true on success. */
  async runExportGraph(graph: GraphDoc, outputs: string[], items: 'current' | 'all', item: number, zip: boolean, audioFormat?: 'wav' | 'm4a' | 'webm'): Promise<boolean> {
    if (this.exportAbort) {
      this.toast('An export is already running.', 'info');
      return false;
    }
    const s = { graph, item };
    // Process mode: an export must never silently contain a stand-in (a placeholder card, an unanalysed Track...).
    let runProcesses = false;
    const pending = this.io.processes.pending(graph, outputs);
    if (pending.length) {
      // the app's own dialog (Esc or a click outside = no), not the browser's confirm
      const ok = await this.ask({
        title: 'Run processes first?',
        text: `Before exporting, ${pending.length === 1 ? 'a process has' : `${pending.length} processes have`} to run, otherwise the export would contain a stand-in instead of the real result:`,
        items: pending.map((p) => `${p.label}: ${p.title}, ${p.state}`),
        ok: `Run ${pending.length === 1 ? 'it' : 'them'}, then export`,
        cancel: 'Cancel',
      });
      if (!ok) {
        this.toast('Export canceled: run the processes first (Process button in the inspector).', 'info');
        return false;
      }
      runProcesses = true;
    }
    const ac = new AbortController();
    this.exportAbort = ac;
    this.patch({ exportJob: { label: 'Starting…', fraction: 0 } });
    try {
      const files = await this.io.exporter.run({
        graph: s.graph,
        outputs,
        items,
        item: s.item,
        zip,
        ...(audioFormat ? { audioFormat } : {}),
        signal: ac.signal,
        runProcesses,
        // Results go into the nodes too (one undo step each), so the next export does not run them again. Throwaway graphs are not edited.
        onProcessResult: (nodeId, result) => {
          if (graph === this.state.graph) this.edit((g) => withProcessResult(g, this.registry, nodeId, result));
        },
        onProgress: (p) => this.patch({ exportJob: { label: p.label, fraction: p.fraction } }),
      });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.io.exporter.download(files);
      const saved = files.filter((f) => f.savedPath).map((f) => f.savedPath as string); // FFmpeg formats are saved by the desktop app's Save dialog
      this.toast(saved.length === 1 && files.length === 1 ? `Saved ${saved[0]}` : `Exported ${files.length} file${files.length === 1 ? '' : 's'}${saved.length ? ` (${saved.length} saved to the places you chose)` : ''}`, 'ok');
      setTimeout(() => this.maybeSupport('export'), 1200);
      return true;
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) this.toast('Export canceled', 'info');
      else this.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
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

  private confirmResolve: ((ok: boolean) => void) | null = null;

  /** Ask a yes / no question in the app's dialog. Resolves false when dismissed (Esc, the scrim) or when another question replaces it. */
  ask(req: ConfirmRequest): Promise<boolean> {
    this.confirmResolve?.(false);
    return new Promise<boolean>((resolve) => {
      this.confirmResolve = resolve;
      this.patch({ confirm: req });
    });
  }
  /** The dialog's answer. */
  answer(ok: boolean): void {
    const r = this.confirmResolve;
    this.confirmResolve = null;
    this.patch({ confirm: null });
    r?.(ok);
  }

  /** "Save group as node…" for a group node (full path id). */
  openSaveNode(groupFullId: string): void {
    this.patch({ saveNodeTarget: groupFullId, dialog: 'saveNode', addMenu: null, contextMenu: null });
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
    // the same message never stacks: it replaces the one on screen with a ×N counter (and a fresh timer)
    const dup = actions ? undefined : this.state.toasts.find((t) => t.text === text && t.kind === kind && !t.actions);
    const rest = this.state.toasts.filter((t) => t !== dup);
    this.patch({ toasts: [...rest.slice(-3), { id, kind, text, actions, count: dup ? (dup.count ?? 1) + 1 : undefined }] });
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
