/**
 * A World AR take as a finished video, the graph side of it, pure. The AR view shows the viewed node's picture over the camera;
 * this builds the copy of the project that renders exactly that offline, frame by frame, from the recorded camera clip and take
 * (the same idea as the Recorder's "smooth" take, see take-graph.ts).
 */
import { upstream } from '../graph';
import { flattenGraph } from '../group';
import type { Edge, GraphDoc, NodeInstance } from '../types';
import { clipParams } from './take-graph';
import type { WorldTake } from './world-take';

type Params = Record<string, unknown>;

export const AR_VIDEO_OUTPUT_LABEL = 'AR video';

export interface ArVideoOptions {
  /** Path ids of the World AR Camera node that holds the take and of the node the AR view showed. */
  arId: string;
  viewedId: string;
  /** The image output of the viewed node. */
  viewedPort: string;
  take: WorldTake;
  /** The camera clip's id in Media, or null (movement only: the graph is rendered alone, over black). */
  clipAsset: string | null;
  /** Size of the video (the clip's, capped). */
  width: number;
  height: number;
  /** Params of the Output node that is added to render from. */
  output: Params;
}

export interface ArVideoGraph {
  graph: GraphDoc;
  outputId: string;
  /** The Media In nodes that stand in for the camera (Picture output, Webcams). */
  clipNodes: string[];
}

/**
 * The copy of `graph` that renders a World AR take as a video, like the AR view showed it. The user's document is never changed.
 *
 *  - The World AR Camera plays the take. `startAt` is the clip frame its first pose belongs to, so the project clock IS the clip
 *    clock: frame n of the video = frame n of the clip = the pose noted with that picture (frames the clip skipped hold the pose
 *    before, the way the clip holds its picture).
 *  - Its Picture output and every Webcam above the viewed node become a Media In playing the camera clip (same ids, same wires).
 *  - The video is the viewed node's picture merged OVER the clip with its own alpha, always. That is what the AR view did (object
 *    over camera) and it cannot draw the camera twice: a graph that already uses the Picture as an opaque background covers the
 *    clip with that same picture, and one that does not shows the clip wherever it is transparent.
 *  - The project size is the clip's, because the AR camera's lens follows the shape of the canvas.
 * Null when one of the nodes is gone.
 */
export function buildWorldArVideoGraph(graph: GraphDoc, o: ArVideoOptions): ArVideoGraph | null {
  const view = flattenGraph(graph);
  const ar = view.alias.get(o.arId) ?? o.arId;
  let shown = view.alias.get(o.viewedId) ?? o.viewedId;
  let shownPort = o.viewedPort;
  const flat = view.graph;
  const arNode = flat.nodes.find((n) => n.id === ar);
  if (!arNode || !flat.nodes.some((n) => n.id === shown)) return null;
  // An Image Out has no picture of its own: what the AR view showed on it is what is wired into it. Without this the video
  // would merge a node that gives nothing, and only the camera clip would be in it.
  for (let guard = 0; flat.nodes.find((n) => n.id === shown)?.type === 'image-out' && guard < 16; guard++) {
    const feed = flat.edges.find((e) => e.to.node === shown && e.to.port === 'image');
    if (!feed) return null;
    shown = feed.from.node;
    shownPort = feed.from.port;
  }
  const used = new Set(flat.nodes.map((n) => n.id));
  const fresh = (base: string): string => {
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };
  const clip = (id: string, x: number, y: number, label: string | undefined): NodeInstance => ({
    id,
    type: 'media-in',
    x,
    y,
    params: o.clipAsset ? clipParams({ id, assetId: o.clipAsset, startsAt: 0 }) : { assets: [], volume: 0, mute: true },
    ...(label ? { label } : {}),
  });
  const up = upstream(flat, shown);
  const cams = new Set<string>();
  if (o.clipAsset) for (const n of flat.nodes) if (up.has(n.id) && !n.bypass && n.type === 'camera-in') cams.add(n.id);
  const nodes: NodeInstance[] = flat.nodes.map((n) => {
    if (cams.has(n.id)) return clip(n.id, n.x, n.y, n.label);
    if (n.id !== ar) return n;
    return { ...n, params: { ...n.params, take: o.take, startAt: (o.take.clipFirst ?? 0) / o.take.fps, loopTake: false, live: null, liveTick: '' } };
  });
  const pictureId = fresh('ar-clip');
  const edges: Edge[] = [];
  let pictureUsed = false;
  for (const e of flat.edges) {
    if (e.from.node === ar && e.from.port === 'picture') {
      pictureUsed = true;
      edges.push({ ...e, from: { node: pictureId, port: 'image' } });
    } else if (cams.has(e.from.node) && e.from.port !== 'image') continue; // the recorded sound is the clip's, not the live camera's
    else edges.push(e);
  }
  const extra: NodeInstance[] = [];
  if (pictureUsed || o.clipAsset) extra.push(clip(pictureId, arNode.x, arNode.y + 160, 'AR camera clip'));
  let last = { node: shown, port: shownPort };
  if (o.clipAsset) {
    const mergeId = fresh('ar-video-merge');
    extra.push({ id: mergeId, type: 'merge', x: arNode.x + 200, y: arNode.y + 120, label: 'Object over camera', params: { mode: 'normal', opacity: 1, fit: 'stretch', center: [0.5, 0.5], scale: 1 } });
    // A take that zoomed: the camera clip is the full picture, so the video zooms it the way the AR view did, by the take's zoom at
    // each frame (the World AR Camera's Zoom output into a Transform's scale, about the middle). The object is already zoomed: the
    // played-back lens carries the same factor. Takes without a zoom track add nothing.
    let backdrop = { node: pictureId, port: 'image' };
    if (o.take.tracks.zm) {
      const zoomId = fresh('ar-video-zoom');
      extra.push({ id: zoomId, type: 'transform', x: arNode.x + 100, y: arNode.y + 160, label: 'Camera zoom', params: { translate: [0, 0], rotate: 0, scale: 1, stretch: [1, 1], pivot: [0.5, 0.5], edge: 'clamp', filter: 'linear' } });
      edges.push({ id: `${zoomId}-src`, from: backdrop, to: { node: zoomId, port: 'image' } });
      edges.push({ id: `${zoomId}-zoom`, from: { node: ar, port: 'zoom' }, to: { node: zoomId, port: 'scale' } });
      backdrop = { node: zoomId, port: 'image' };
    }
    edges.push({ id: `${mergeId}-bg`, from: backdrop, to: { node: mergeId, port: 'background' } });
    edges.push({ id: `${mergeId}-fg`, from: last, to: { node: mergeId, port: 'foreground' } });
    last = { node: mergeId, port: 'image' };
  }
  const outputId = fresh('ar-video-out');
  extra.push({ id: outputId, type: 'image-out', x: arNode.x + 420, y: arNode.y, label: AR_VIDEO_OUTPUT_LABEL, params: { ...o.output, enabled: true, kind: 'video' } });
  edges.push({ id: `${outputId}-wire`, from: last, to: { node: outputId, port: 'image' } });
  const { fps, frames } = o.take;
  return {
    graph: { ...flat, project: { ...flat.project, width: o.width, height: o.height, fps, duration: Math.max(flat.project.duration, frames / fps), loop: false }, nodes: [...nodes, ...extra], edges },
    outputId,
    clipNodes: [...cams, ...(extra.some((n) => n.id === pictureId) ? [pictureId] : [])],
  };
}

/** Size of the AR video: the clip's, no longer than `maxSide` on its long side, even numbers. Without a clip, `fallback`. */
export function arVideoSize(clip: { width: number; height: number } | null, fallback: { width: number; height: number }, maxSide: number): { width: number; height: number } {
  const src = clip && clip.width > 1 && clip.height > 1 ? clip : fallback;
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(src.width), height: even(src.height) };
}

/** Frames of the video: the clip's length at the take's rate, or the take's own length when there is no clip. */
export function arVideoFrames(take: WorldTake, clipSeconds: number | null): number {
  if (!clipSeconds || !(clipSeconds > 0)) return take.frames;
  return Math.max(1, Math.round(clipSeconds * take.fps));
}
