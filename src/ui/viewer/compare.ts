/**
 * Viewer snapshots and A/B compare: the pure parts (strip model, wipe geometry, CSS recipe per mode, "bypass compare" source).
 * Compositing is done by the browser on top of the viewer canvas (an <img> of snapshot A inside the same transformed stage, so zoom and
 * pan are linked for free); the engine is not touched. No DOM here, so it is unit-tested.
 */
import type { Registry } from '../../engine/define';
import type { GraphDoc } from '../../engine/types';

export const SNAPSHOT_CAP = 12;

export type CompareMode = 'off' | 'wipe' | 'side' | 'toggle' | 'onion' | 'diff';
export const COMPARE_MODES: { id: Exclude<CompareMode, 'off'>; label: string; hint: string }[] = [
  { id: 'wipe', label: 'Wipe', hint: 'Drag the line; the snapshot is on the left of it' },
  { id: 'side', label: 'Side by side', hint: 'Snapshot left, live right (the live side refreshes when paused)' },
  { id: 'toggle', label: 'Toggle', hint: 'Hold the A/B key to see the snapshot' },
  { id: 'onion', label: 'Onion', hint: 'Blend the snapshot over the live image' },
  { id: 'diff', label: 'Difference', hint: 'Absolute difference times gain: black means identical' },
];

export interface Snap {
  id: string;
  frame: number;
  nodeId: string | null;
  nodeName: string;
  /** Epoch ms. */
  t: number;
  label: string;
  width: number;
  height: number;
  /** Preview scale (percent) the pixels were taken at. */
  previewPct: number;
  /** Where the pixels came from: the viewer ("this view") or a one-off evaluation of another node. */
  kind: 'view' | 'node';
}

export interface StripChange {
  strip: Snap[];
  /** Snapshots that fell out of the strip (release their pixels). */
  evicted: Snap[];
}

/** Add a snapshot; at the cap the least recently used one goes. `used` maps id to last use time (selecting counts as use). */
export function stripAdd(strip: readonly Snap[], snap: Snap, used: ReadonlyMap<string, number>, cap = SNAPSHOT_CAP): StripChange {
  const next = [...strip, snap];
  const evicted: Snap[] = [];
  while (next.length > cap) {
    let victim = 0;
    let oldest = Infinity;
    for (let i = 0; i < next.length - 1; i++) {
      const u = used.get(next[i].id) ?? next[i].t;
      if (u < oldest) {
        oldest = u;
        victim = i;
      }
    }
    evicted.push(...next.splice(victim, 1));
  }
  return { strip: next, evicted };
}

export const stripRemove = (strip: readonly Snap[], id: string): Snap[] => strip.filter((s) => s.id !== id);
export const stripRename = (strip: readonly Snap[], id: string, label: string): Snap[] => strip.map((s) => (s.id === id ? { ...s, label: label.trim().slice(0, 40) } : s));

/** "label · frame 12 · Blur · 14:03" */
export function snapCaption(s: Snap): string {
  const d = new Date(s.t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${s.label ? `${s.label} · ` : ''}frame ${s.frame} · ${s.nodeName} · ${hh}:${mm}`;
}

/* ------------------------------ wipe geometry ------------------------------ */

const round = (n: number): number => Math.round(n * 100) / 100;

function dir(angle: number): { dx: number; dy: number } {
  const a = (((angle % 360) + 360) % 360) * (Math.PI / 180);
  return { dx: Math.sin(a), dy: -Math.cos(a) };
}

/**
 * Polygon (CSS clip-path, percent of the image box) of the region on the LEFT of a line through the point (pos, 0.5).
 * `angle` in degrees: 0 = vertical line (snapshot on the left), 90 = horizontal line (snapshot on top), 180 = vertical, flipped.
 * The line is extended past the box so the clip covers whole sides at any angle. `aspect` = width / height keeps the angle true on screen.
 */
export function wipePolygon(pos: number, angle: number, aspect = 1): string {
  const p = Math.min(1, Math.max(0, pos));
  const { dx, dy } = dir(angle);
  const cx = p * aspect;
  const cy = 0.5;
  const big = 4 * Math.max(aspect, 1);
  const nx = dy; // left normal of (dx, dy) in y-down coordinates
  const ny = -dx;
  const pts: [number, number][] = [
    [cx - dx * big, cy - dy * big],
    [cx + dx * big, cy + dy * big],
    [cx + dx * big + nx * big, cy + dy * big + ny * big],
    [cx - dx * big + nx * big, cy - dy * big + ny * big],
  ];
  return `polygon(${pts.map(([x, y]) => `${round((x / aspect) * 100)}% ${round(y * 100)}%`).join(', ')})`;
}

/** End points of the wipe line in percent of the image box (long enough to cross the box at any angle). */
export function wipeLine(pos: number, angle: number, aspect = 1): { x1: number; y1: number; x2: number; y2: number } {
  const { dx, dy } = dir(angle);
  const cx = Math.min(1, Math.max(0, pos)) * aspect;
  const big = 4 * Math.max(aspect, 1);
  const f = (s: number): [number, number] => [((cx + dx * s) / aspect) * 100, (0.5 + dy * s) * 100];
  const [x1, y1] = f(-big);
  const [x2, y2] = f(big);
  return { x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2) };
}

/** The wipe position (0..1) that puts the line through a pointer at (u, v) in image coordinates (0..1), keeping the angle. */
export function wipePosFromPointer(u: number, v: number, angle: number, aspect = 1): number {
  const { dx, dy } = dir(angle);
  const nx = dy;
  const ny = -dx;
  if (Math.abs(nx) < 1e-6) return 0.5; // a horizontal line has no x position
  const d = (u - 0.5) * aspect * nx + (v - 0.5) * ny; // signed distance of the pointer from the center line along the normal
  return Math.min(1, Math.max(0, 0.5 + d / (aspect * nx)));
}

/* ------------------------------ style per mode ------------------------------ */

export interface CompareParams {
  mode: CompareMode;
  wipePos: number;
  wipeAngle: number;
  onion: number;
  gain: number;
  /** Toggle mode: the A/B key is held (show the snapshot). */
  flipped: boolean;
  aspect: number;
}

export interface OverlayStyle {
  /** Snapshot <img> drawn over the live canvas inside the stage. */
  overlay: { visible: boolean; opacity: number; clipPath: string; mixBlendMode: 'normal' | 'difference' };
  /** Filter on the whole stage (the difference gain). */
  stageFilter: string;
  /** The live stage is hidden (side by side shows two panes instead). */
  hideStage: boolean;
}

export function overlayStyle(p: CompareParams): OverlayStyle {
  const off: OverlayStyle = { overlay: { visible: false, opacity: 1, clipPath: 'none', mixBlendMode: 'normal' }, stageFilter: 'none', hideStage: false };
  switch (p.mode) {
    case 'wipe':
      return { ...off, overlay: { visible: true, opacity: 1, clipPath: wipePolygon(p.wipePos, p.wipeAngle, p.aspect), mixBlendMode: 'normal' } };
    case 'toggle':
      return { ...off, overlay: { visible: p.flipped, opacity: 1, clipPath: 'none', mixBlendMode: 'normal' } };
    case 'onion':
      return { ...off, overlay: { visible: true, opacity: Math.min(1, Math.max(0, p.onion)), clipPath: 'none', mixBlendMode: 'normal' } };
    case 'diff':
      return { overlay: { visible: true, opacity: 1, clipPath: 'none', mixBlendMode: 'difference' }, stageFilter: `brightness(${Math.min(32, Math.max(1, p.gain))})`, hideStage: false };
    case 'side':
      return { ...off, hideStage: true };
    default:
      return off;
  }
}

/* ------------------------------ compare with a node ------------------------------ */

/** The node feeding the first wired image input of `nodeId` (its "before"), for one-click bypass compare. Top-level nodes only. */
export function firstImageInputSource(graph: GraphDoc, registry: Pick<Registry, 'get'>, nodeId: string): string | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && registry.get(node.type);
  if (!node || !def) return null;
  const ports = Object.keys(def.inputs).filter((k) => (def.inputs as Record<string, { type: string }>)[k].type === 'image');
  for (const port of ports) {
    const e = graph.edges.find((x) => x.to.node === nodeId && x.to.port === port);
    if (e) return e.from.node;
  }
  return null;
}

/** Cost note shown while a compare runs during playback. */
export const PLAYBACK_NOTE = 'Comparing while playing can lower the frame rate; pause for an exact comparison.';
