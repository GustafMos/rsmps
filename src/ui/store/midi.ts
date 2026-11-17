/**
 * MIDI learn controller (UI layer): Web MIDI in, parameter writes out.
 * Mappings live in the project (`GraphDoc.midiMap`, undoable); the mapped value is written INTO the parameter through the editor's
 * `setParam`, so it is saved like a hand edit and exports see it. One MIDI access of our own: it does not touch the audio engine's.
 */
import { addNode, connect } from '../../engine/graph';
import {
  applyMessage,
  automationCurve,
  controlFor,
  describeSource,
  makeMapping,
  newState,
  parseMidi,
  pruneMap,
  shapeOf,
  sourceOf,
  type AutoSample,
  type MapState,
  type MidiMap,
  type MidiMapping,
  type MidiMsg,
  type ParamShape,
} from '../../engine/lib/midi-map';
import type { AnyNodeDef, GraphDoc, NodeInstance, ParamDef } from '../../engine/types';
import type { Io } from '../../io/api';
import { createStore, type Store } from './createStore';
import type { Editor } from './editor';

export type MidiStatus = 'idle' | 'ready' | 'denied' | 'unsupported';

export interface MidiUi {
  status: MidiStatus;
  /** Names of connected MIDI inputs. */
  devices: string[];
  /** The parameter waiting for a control, or null. */
  learning: { node: string; param: string; label: string } | null;
  /** Last message seen, for the activity line of the dialog. */
  last: { text: string; at: number } | null;
  /** The mappings dialog is open. */
  dialog: boolean;
  /** A recording of one pass of a mapped control is in progress. */
  recording: { mapping: string; label: string } | null;
}

export const DOT_STYLE_ID = 'rs-midi-dots';

const q = (s: string): string => s.replace(/["\\]/g, '\\$&');

/** CSS that puts a small dot on every mapped parameter row (inspector rows and node-body rows) without touching their components. */
export function dotCss(map: MidiMap | undefined): string {
  if (!map?.mappings.length) return '';
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const m of map.mappings) {
    const k = `${m.node} ${m.param}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rules.push(`[data-param-node="${q(m.node)}"][data-param-key="${q(m.param)}"]`, `[data-node-id="${q(m.node)}"] [data-param-key="${q(m.param)}"]`);
  }
  const dots = rules.map((r) => `${r}::after`).join(',\n');
  const insp = rules.filter((r) => r.startsWith('[data-param-node')).join(',\n');
  return `${insp ? `${insp}{position:relative}\n` : ''}${dots}{content:'';position:absolute;right:2px;top:2px;width:6px;height:6px;border-radius:50%;background:#ff9f1c;box-shadow:0 0 0 1px rgba(0,0,0,.45);opacity:calc(.55 + .45 * var(--midi,0));pointer-events:none;z-index:2}`;
}

export class MidiController {
  readonly store: Store<MidiUi> = createStore<MidiUi>({ status: 'idle', devices: [], learning: null, last: null, dialog: false, recording: null });
  private access: MIDIAccess | null = null;
  private starting: Promise<boolean> | null = null;
  private states = new Map<string, MapState>();
  private pending = new Map<string, { node: string; param: string; value: unknown }>();
  private raf = 0;
  private live = new Map<string, number>();
  private rec: { id: string; node: string; param: string; start: number; samples: AutoSample[]; lastSec: number; began: boolean; range: { min: number; max: number } } | null = null;
  private offPlayer: (() => void) | null = null;
  private offEditor: (() => void) | null = null;
  private style: HTMLStyleElement | null = null;
  private lastMap: MidiMap | undefined;

  constructor(
    private ed: Editor,
    private io: Io,
  ) {}

  /** Wire up the dot stylesheet and the player (for recording). Returns a cleanup. */
  init(): () => void {
    this.refreshDots();
    this.offEditor = this.ed.store.subscribe(() => {
      const map = this.ed.state.graph.midiMap;
      if (map !== this.lastMap) {
        this.lastMap = map;
        this.refreshDots();
        if (map?.mappings.length && this.store.get().status === 'idle') void this.autoStart();
      }
    });
    this.offPlayer = this.io.player.subscribe((st) => this.onPlayer(st.seconds, st.playing));
    void this.autoStart();
    return () => this.dispose();
  }

  dispose(): void {
    this.offEditor?.();
    this.offPlayer?.();
    cancelAnimationFrame(this.raf);
    this.style?.remove();
    this.style = null;
    this.stop();
  }

  /* --------------------------------------------------------------- access */

  /** Start listening only when the browser already allows MIDI (no surprise permission prompt when a project opens). */
  private async autoStart(): Promise<void> {
    if (!this.ed.state.graph.midiMap?.mappings.length || this.access) return;
    try {
      const st = await navigator.permissions?.query({ name: 'midi' as PermissionName });
      if (st?.state === 'granted') await this.start();
    } catch {
      /* permissions API without 'midi': wait for the user */
    }
  }

  /** Ask for MIDI (a permission prompt the first time). Resolves true when listening. */
  start(): Promise<boolean> {
    if (this.access) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!navigator.requestMIDIAccess) {
        this.store.set((s) => ({ ...s, status: 'unsupported' }));
        return false;
      }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.access.onstatechange = () => this.attach();
        this.attach();
        this.store.set((s) => ({ ...s, status: 'ready' }));
        return true;
      } catch {
        this.store.set((s) => ({ ...s, status: 'denied' }));
        return false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private attach(): void {
    if (!this.access) return;
    const names: string[] = [];
    for (const input of this.access.inputs.values()) {
      names.push(input.name || input.id);
      input.onmidimessage = (e) => {
        if (!e.data) return;
        const msg = parseMidi(e.data, input.id, input.name ?? undefined);
        if (msg) this.onMessage(msg);
      };
    }
    this.store.set((s) => ({ ...s, devices: names }));
  }

  private stop(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access.onstatechange = null;
    this.access = null;
  }

  /** Human-readable reason MIDI is not available, for the dialog and toasts. */
  statusText(): string {
    switch (this.store.get().status) {
      case 'unsupported':
        return 'This browser has no Web MIDI. Use the desktop app, Chrome or Edge.';
      case 'denied':
        return 'MIDI access was blocked. Allow MIDI for this site (the lock icon in the address bar, then Site settings), then try again.';
      case 'ready':
        return this.store.get().devices.length ? `${this.store.get().devices.length} MIDI input${this.store.get().devices.length > 1 ? 's' : ''} connected.` : 'MIDI is on, but no input is connected. Plug in a controller.';
      default:
        return 'MIDI is off until you learn a control.';
    }
  }

  /* ----------------------------------------------------------- lookups */

  private nodeOf(id: string): { node: NodeInstance; def: AnyNodeDef } | null {
    const node = this.ed.state.level.nodes.find((n) => n.id === id);
    const def = node ? this.io.registry.get(node.type) : undefined;
    return node && def ? { node, def } : null;
  }

  paramDef(nodeId: string, param: string): ParamDef | undefined {
    const n = this.nodeOf(nodeId);
    return n ? ((n.def.params as Record<string, ParamDef>)[param] as ParamDef | undefined) : undefined;
  }

  shape(nodeId: string, param: string): ParamShape | null {
    return shapeOf(this.paramDef(nodeId, param));
  }

  label(nodeId: string, param: string): string {
    const n = this.nodeOf(nodeId);
    if (!n) return `${nodeId} ${param}`;
    const p = (n.def.params as Record<string, ParamDef>)[param];
    return `${n.node.label || n.def.title} · ${p?.label ?? param}`;
  }

  mappingsFor(nodeId: string, param: string): MidiMapping[] {
    return (this.ed.state.graph.midiMap?.mappings ?? []).filter((m) => m.node === nodeId && m.param === param);
  }

  /** Is the parameter driven by a wire (then a stored value would be ignored)? */
  private isWired(nodeId: string, param: string): boolean {
    return this.ed.state.level.edges.some((e) => e.to.node === nodeId && e.to.port === param);
  }

  /* ----------------------------------------------------------- editing */

  private setMap(fn: (m: MidiMapping[]) => MidiMapping[], key?: string): void {
    this.ed.edit((g) => {
      const next = fn(g.midiMap?.mappings ?? []);
      const doc: GraphDoc = { ...g };
      if (next.length) doc.midiMap = { mappings: next };
      else delete doc.midiMap;
      return doc;
    }, key);
  }

  updateMapping(id: string, patch: Partial<MidiMapping>): void {
    this.setMap((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)), `midimap:${id}`);
  }

  removeMapping(id: string): void {
    this.states.delete(id);
    this.setMap((ms) => ms.filter((m) => m.id !== id));
  }

  /** Remove every mapping of a parameter. */
  unlearn(nodeId: string, param: string): void {
    this.setMap((ms) => ms.filter((m) => !(m.node === nodeId && m.param === param)));
  }

  /** Drop mappings of nodes that no longer exist (the mappings dialog calls it when it opens). */
  prune(): void {
    const ids = new Set(this.ed.state.graph.nodes.map((n) => n.id));
    const pruned = pruneMap(this.ed.state.graph.midiMap, ids);
    if (pruned !== this.ed.state.graph.midiMap) this.setMap(() => pruned?.mappings ?? []);
  }

  /* --------------------------------------------------------------- learn */

  /** Wait for the next control the user moves and bind it to the parameter. */
  async learn(nodeId: string, param: string): Promise<void> {
    if (!this.shape(nodeId, param)) return this.ed.toast('MIDI can drive numbers, switches and choices.', 'info');
    const ok = await this.start();
    if (!ok) return this.ed.toast(this.statusText(), 'error');
    if (!this.store.get().devices.length) this.ed.toast('No MIDI input found. Plug in a controller; waiting for it.', 'info');
    this.store.set((s) => ({ ...s, learning: { node: nodeId, param, label: this.label(nodeId, param) } }));
  }

  cancelLearn(): void {
    if (this.store.get().learning) this.store.set((s) => ({ ...s, learning: null }));
  }

  /* ------------------------------------------------------------ messages */

  /** Public so tests and the on-screen pad can feed messages. */
  onMessage(msg: MidiMsg): void {
    const ui = this.store.get();
    const text = `${describeSource(sourceOf(msg))}${msg.deviceName ? ` · ${msg.deviceName}` : ''}`;
    if (msg.kind !== 'note' || msg.pressed) this.store.set((s) => ({ ...s, last: { text, at: Date.now() } }));
    if (ui.learning) {
      const wheelNoise = msg.kind === 'bend' && Math.abs(msg.value - 0.5) < 0.15;
      if ((msg.kind === 'note' && !msg.pressed) || wheelNoise) return;
      const { node, param, label } = ui.learning;
      const shape = this.shape(node, param);
      this.store.set((s) => ({ ...s, learning: null }));
      if (!shape) return;
      const m = makeMapping(node, param, shape, sourceOf(msg), msg.deviceName);
      // a note on a switch is a button; anything else on a switch toggles at the half way mark
      this.setMap((ms) => [...ms, m]);
      this.ed.toast(`${label} is now on ${describeSource(m.source)}${msg.deviceName ? ` (${msg.deviceName})` : ''}.`, 'ok');
      return;
    }
    const map = this.ed.state.graph.midiMap;
    if (!map) return;
    for (const m of map.mappings) {
      const target = this.nodeOf(m.node);
      if (!target) continue;
      const shape = shapeOf((target.def.params as Record<string, ParamDef>)[m.param]);
      if (!shape || this.isWired(m.node, m.param)) continue;
      let st = this.states.get(m.id);
      if (!st) this.states.set(m.id, (st = newState()));
      const pend = this.pending.get(`${m.node} ${m.param}`);
      const cur = pend ? pend.value : (target.node.params[m.param] ?? (target.def.params as Record<string, ParamDef>)[m.param]?.default);
      const r = applyMessage(m, st, msg, cur, shape);
      if (!r) continue;
      this.live.set(m.id, r.position);
      this.pending.set(`${m.node} ${m.param}`, { node: m.node, param: m.param, value: r.value });
      if (this.rec && this.rec.node === m.node && this.rec.param === m.param && typeof r.value === 'number') {
        const dur = Math.max(1e-6, this.ed.state.graph.project.duration);
        this.rec.samples.push({ t: Math.min(1, this.io.player.getState().seconds / dur), v: r.value });
      }
    }
    if (this.pending.size && !this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.raf = 0;
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const it of items) this.ed.setParam(it.node, it.param, it.value);
    this.paintLive();
  }

  /** Position (0..1) a mapping's control was last seen at, for the live dot and the dialog. */
  position(id: string): number {
    return this.live.get(id) ?? 0;
  }

  private paintLive(): void {
    if (typeof document === "undefined") return;
    for (const [id, pos] of this.live) {
      const m = this.ed.state.graph.midiMap?.mappings.find((x) => x.id === id);
      if (!m) continue;
      const sel = `[data-param-node="${q(m.node)}"][data-param-key="${q(m.param)}"],[data-node-id="${q(m.node)}"] [data-param-key="${q(m.param)}"]`;
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => el.style.setProperty('--midi', String(pos)));
    }
  }

  private refreshDots(): void {
    if (typeof document === "undefined") return;
    const css = dotCss(this.ed.state.graph.midiMap);
    if (!css) {
      this.style?.remove();
      this.style = null;
      return;
    }
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.id = DOT_STYLE_ID;
      document.head.appendChild(this.style);
    }
    this.style.textContent = css;
  }

  /** Where a mapping's control would sit for the parameter's current value (for showing "knob is behind the value"). */
  controlPositionFor(m: MidiMapping): number {
    const n = this.nodeOf(m.node);
    const v = n?.node.params[m.param];
    return typeof v === 'number' ? controlFor(m, v) : 0;
  }

  /* ------------------------------------------------------------ recording */

  /** Record one pass of the loop while the user plays the mapped control, then turn it into a Keyframes curve wired to the parameter. */
  startRecording(mappingId: string): void {
    const m = this.ed.state.graph.midiMap?.mappings.find((x) => x.id === mappingId);
    const shape = m && this.shape(m.node, m.param);
    if (!m || !shape || shape.type !== 'number') return this.ed.toast('Only number settings can be recorded as keyframes.', 'info');
    if (this.isWired(m.node, m.param)) return this.ed.toast('That setting is already driven by a wire.', 'info');
    const g = this.ed.state.graph;
    if (!g.project.loop) this.ed.setProject({ loop: true });
    const cur = this.nodeOf(m.node)?.node.params[m.param];
    this.rec = { id: m.id, node: m.node, param: m.param, start: typeof cur === 'number' ? cur : m.min, samples: [], lastSec: -1, began: false, range: { min: Math.min(m.min, m.max), max: Math.max(m.min, m.max) } };
    this.store.set((s) => ({ ...s, recording: { mapping: m.id, label: this.label(m.node, m.param) } }));
    this.states.get(m.id) && (this.states.get(m.id)!.picked = true);
    this.io.player.seek(0);
    this.io.player.play();
    this.ed.toast('Recording one pass of the loop. Move the control; it stops when the loop ends.', 'info');
  }

  stopRecording(commit = true): void {
    const r = this.rec;
    this.rec = null;
    this.store.set((s) => ({ ...s, recording: null }));
    if (!r) return;
    this.io.player.pause();
    if (!commit || !r.samples.length) return this.ed.toast(commit ? 'Nothing was recorded.' : 'Recording canceled.', 'info');
    const g = this.ed.state.graph;
    const frames = Math.max(2, Math.round(g.project.fps * g.project.duration));
    const curve = automationCurve(r.samples, r.start, frames, r.range);
    this.ed.edit((doc) => {
      const target = doc.nodes.find((n) => n.id === r.node);
      if (!target) throw new Error('The node is gone.');
      const made = addNode(doc, this.io.registry, 'keyframes', { x: target.x - 280, y: target.y }, { curve, scale: 1, offset: 0 });
      return connect(made.graph, this.io.registry, { node: made.node.id, port: 'value' }, { node: r.node, port: r.param });
    });
    this.ed.toast(`Recorded ${curve.keys.length} keyframes into a Keyframes node wired to ${this.label(r.node, r.param)}.`, 'ok');
  }

  private onPlayer(seconds: number, playing: boolean): void {
    const r = this.rec;
    if (!r) return;
    if (!r.began) {
      if (playing) r.began = true; // wait for playback to really start
      else return;
    }
    if (seconds < r.lastSec - 1e-6 || !playing) return this.stopRecording(true); // wrapped around, or the user paused
    r.lastSec = Math.max(r.lastSec, seconds);
  }
}
