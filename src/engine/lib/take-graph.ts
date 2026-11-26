/**
 * "Record the source, apply the effects afterwards": the graph side of it, pure.
 *
 * A phone cannot run a heavy effect chain at the full frame rate, so a recording of what the viewer shows stutters. Recording the
 * camera itself costs almost nothing, so the Recorder can record every live picture that feeds it as a raw clip, and when the user
 * stops, the same graph is rendered again offline with each live input replaced by a Media In that plays its raw clip. Every frame
 * is then rendered at the project time it was seen at, however long a frame takes.
 *
 *  - `findLiveInputs`: the live picture nodes (Webcam, Phone Camera, URL / Stream) that feed a Recorder, inside groups too.
 *  - `findMotionInputs`: the motion nodes (Phone Motion, AR Camera) that feed it and read live sensors.
 *  - `buildTakeGraph`: the copy to render. The user's document is never changed.
 *  - `takeFrameTime`: project time of a frame of the take (the clock the player used while recording).
 *  - `soundPlan`: which sound goes into the clip.
 */
import { upstream } from '../graph';
import { flattenGraph, GROUP_TYPE, PATH_SEP } from '../group';
import type { Edge, GraphDoc, NodeInstance } from '../types';
import { isLivePictureType, type LivePictureType } from './live-source';

type Params = Record<string, unknown>;

/** Name of the Output a take is rendered through: what the exporter calls the job in its messages. */
export const TAKE_OUTPUT_LABEL = 'Recorder take';

/** More live pictures than this are not recorded side by side: every one is a video encoder running at once. */
export const MAX_TAKE_SOURCES = 4;

export interface LiveInput {
  /** Path id of the node as the user sees it (`group/node`; a node inside a Repeat is one node, whatever the pass). */
  id: string;
  type: LivePictureType;
  /** Its params as the engine sees them (values shown on a group already written in), without the definition's defaults. */
  params: Params;
}

/** A path id without the pass markers of Repeat groups: the node as the user sees it. */
const logicalId = (flatId: string): string =>
  flatId
    .split(PATH_SEP)
    .filter((p) => !p.startsWith('~'))
    .join(PATH_SEP);

/** The plain graph and the id the Recorder has in it, or null when the Recorder is not there. */
function flatRecorder(graph: GraphDoc, recorderId: string): { flat: GraphDoc; id: string } | null {
  const view = flattenGraph(graph);
  const id = view.alias.get(recorderId) ?? recorderId;
  return view.graph.nodes.some((n) => n.id === id) ? { flat: view.graph, id } : null;
}

/** Ids of everything that feeds the PICTURE input of the Recorder (a camera that only gives it sound is not a picture source). */
function pictureUpstream(flat: GraphDoc, recorderId: string): Set<string> {
  const seen = new Set<string>();
  for (const e of flat.edges) if (e.to.node === recorderId && e.to.port === 'image') for (const id of upstream(flat, e.from.node)) seen.add(id);
  return seen;
}

/** The live picture nodes that feed Recorder `recorderId` (a path id), in document order. Bypassed ones give no picture and are left out. */
export function findLiveInputs(graph: GraphDoc, recorderId: string): LiveInput[] {
  const at = flatRecorder(graph, recorderId);
  if (!at) return [];
  const up = pictureUpstream(at.flat, at.id);
  const out = new Map<string, LiveInput>();
  for (const n of at.flat.nodes) {
    if (!up.has(n.id) || n.bypass || !isLivePictureType(n.type)) continue;
    const id = logicalId(n.id);
    if (!out.has(id)) out.set(id, { id, type: n.type, params: n.params });
  }
  return [...out.values()];
}

export interface MotionInput {
  id: string;
  type: 'phone-motion' | 'ar-camera';
  params: Params;
}

/** Motion nodes that feed the Recorder and follow live sensors (one that already plays a recorded take needs nothing). */
export function findMotionInputs(graph: GraphDoc, recorderId: string): MotionInput[] {
  const at = flatRecorder(graph, recorderId);
  if (!at) return [];
  const up = pictureUpstream(at.flat, at.id);
  const out = new Map<string, MotionInput>();
  for (const n of at.flat.nodes) {
    if (!up.has(n.id) || n.bypass || (n.type !== 'phone-motion' && n.type !== 'ar-camera')) continue;
    if (n.params.source === 'recorded' && n.params.take) continue;
    const id = logicalId(n.id);
    if (!out.has(id)) out.set(id, { id, type: n.type, params: n.params });
  }
  return [...out.values()];
}

/** Which sound a recording carries: the one wired into the Recorder, else the mix that is playing, or none. */
export function soundPlan(wanted: boolean, wired: boolean): 'none' | 'wired' | 'mix' {
  return !wanted ? 'none' : wired ? 'wired' : 'mix';
}

/* ----------------------------------------------- the clock ----------------------------------------------- */

/**
 * Project time of frame `frame` of a take, the way the player counted while it was recorded. `loopFrames` = the project length in
 * frames when the project was looping (the clock wraps there), null when time ran on. `pass` counts the wraps.
 */
export function takeFrameTime(frame: number, fps: number, loopFrames: number | null): { seconds: number; pass: number } {
  const f = Math.max(0, Math.floor(frame));
  if (!loopFrames || loopFrames < 1) return { seconds: f / fps, pass: 0 };
  return { seconds: (f % loopFrames) / fps, pass: Math.floor(f / loopFrames) };
}

/* ----------------------------------------------- the copy ------------------------------------------------ */

export interface TakeClip {
  /** The live node it replaces (`LiveInput.id`). */
  id: string;
  /** The raw clip in Media. */
  assetId: string;
  /** Take time (seconds since the clock started) at which the clip's first frame was taken; a clip that started late is positive. */
  startsAt: number;
}

export interface TakeGraphOptions {
  /** 'run': time ran on, so the copy has Loop off like the player had. 'loop': the project settings stay. */
  time: 'run' | 'loop';
  /** Seconds of take time already behind the start of this pass of a looping project (pass * project length); 0 otherwise. */
  passStart?: number;
  /** Params of the Output node that is added to render from (frame, codec...). */
  output: Params;
  /** Motion takes recorded with the picture, by motion node id. */
  motion?: ReadonlyMap<string, unknown>;
}

/** Params of the Media In that stands in for a live node: the whole clip once, at its own size and speed, silent. */
export function clipParams(clip: TakeClip, passStart = 0): Params {
  return {
    assets: [clip.assetId],
    trim: [0, 1],
    fps: 0,
    // the live node gives the camera's own size, so effects measured in pixels see the same picture
    fullRes: true,
    loopVideo: false,
    // Media In shows clip time = project time + offset. The clip's frame 0 belongs at take time `startsAt`.
    offset: passStart - clip.startsAt,
    volume: 0,
    mute: true,
  };
}

/** Change the node with path id `id` (at any depth of groups) and the wires of its level. Returns the same document when it is not there. */
function editAtPath(graph: GraphDoc, id: string, fn: (node: NodeInstance, edges: Edge[]) => { node: NodeInstance; edges: Edge[] }): GraphDoc {
  const parts = id.split(PATH_SEP);
  const level = (nodes: NodeInstance[], edges: Edge[], depth: number): { nodes: NodeInstance[]; edges: Edge[] } | null => {
    const i = nodes.findIndex((n) => n.id === parts[depth]);
    if (i < 0) return null;
    if (depth === parts.length - 1) {
      const r = fn(nodes[i], edges);
      return { nodes: nodes.map((n, k) => (k === i ? r.node : n)), edges: r.edges };
    }
    const g = nodes[i];
    if (g.type !== GROUP_TYPE || !Array.isArray(g.params.nodes)) return null;
    const inner = level(g.params.nodes as NodeInstance[], Array.isArray(g.params.edges) ? (g.params.edges as Edge[]) : [], depth + 1);
    if (!inner) return null;
    return { nodes: nodes.map((n, k) => (k === i ? { ...g, params: { ...g.params, nodes: inner.nodes, edges: inner.edges } } : n)), edges };
  };
  const top = level(graph.nodes, graph.edges, 0);
  return top ? { ...graph, nodes: top.nodes, edges: top.edges } : graph;
}

/**
 * The copy of `graph` to render a take from: every recorded live node is a Media In playing its raw clip (same id, so everything
 * wired to its picture stays wired; wires from its other sockets go, the recorded sound is the sound), motion nodes play the take
 * recorded with it, and an Output node renders the picture that flows through the Recorder. Null when the Recorder is gone.
 *
 * The project length is NOT changed to the take's length: effects that count in "times per project" (anything animated from the
 * loop position) would stretch. The exporter is told how many frames to render and the time of each instead (`takeFrameTime`).
 */
export function buildTakeGraph(graph: GraphDoc, recorderId: string, clips: readonly TakeClip[], o: TakeGraphOptions): { graph: GraphDoc; outputId: string } | null {
  let g = graph;
  for (const clip of clips) {
    g = editAtPath(g, clip.id, (node, edges) => ({
      node: { id: node.id, type: 'media-in', x: node.x, y: node.y, params: clipParams(clip, o.passStart ?? 0), ...(node.label ? { label: node.label } : {}) },
      edges: edges.filter((e) => e.from.node !== node.id || e.from.port === 'image'),
    }));
  }
  for (const [id, take] of o.motion ?? []) {
    g = editAtPath(g, id, (node, edges) => ({ node: { ...node, params: { ...node.params, take, source: 'recorded', takeSmoothing: 0, loopTake: false } }, edges }));
  }
  if (o.time === 'run' && g.project.loop) g = { ...g, project: { ...g.project, loop: false } };
  // The exporter renders Output nodes of the top level. A Recorder inside a group is reached by rendering the plain (ungrouped) form.
  let recorder = recorderId;
  if (recorderId.includes(PATH_SEP)) {
    const at = flatRecorder(g, recorderId);
    if (!at) return null;
    g = at.flat;
    recorder = at.id;
  }
  const node = g.nodes.find((n) => n.id === recorder);
  if (!node) return null;
  let outputId = 'take-out';
  for (let i = 2; g.nodes.some((n) => n.id === outputId); i++) outputId = `take-out-${i}`;
  return {
    graph: {
      ...g,
      nodes: [...g.nodes, { id: outputId, type: 'image-out', x: node.x + 260, y: node.y, label: TAKE_OUTPUT_LABEL, params: { ...o.output, enabled: true, kind: 'video' } }],
      edges: [...g.edges, { id: `${outputId}-wire`, from: { node: recorder, port: 'image' }, to: { node: outputId, port: 'image' } }],
    },
    outputId,
  };
}
