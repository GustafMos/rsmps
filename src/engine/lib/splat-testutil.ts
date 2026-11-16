/** Test helpers for the splat nodes (tests only). */
import { mkdirSync } from 'node:fs';
import { addNode, connect, createGraph } from '../graph';
import type { Harness } from '../testing';
import type { CameraValue, GraphDoc, Host, ImageValue, Value } from '../types';
import { writePng, PNG_DIR, type Img } from './gen-3d-testutil';
import { writeSplatPly } from './splat-ply';
import type { SplatCloud } from './splat-cloud';

export const SPLAT_PNG_DIR = `${PNG_DIR}/splat`;

/** A host whose assets are in-memory byte buffers (id -> bytes). */
export function splatHost(files: Map<string, ArrayBuffer>): Host {
  return {
    assetInfo: (id) => (files.has(id) ? { id, name: id, kind: 'splat', width: 0, height: 0, duration: 0, fps: 0, hasAudio: false } : null),
    assetFrame: async () => null,
    assetBytes: async (id) => files.get(id) ?? null,
  };
}

export function putCloud(files: Map<string, ArrayBuffer>, id: string, cloud: SplatCloud): string {
  files.set(id, writeSplatPly(cloud));
  return id;
}

export function cam(over: Partial<CameraValue> = {}): CameraValue {
  return { kind: 'camera', projection: 'perspective', fov: 40, orthoSize: 4, position: [0, 0, -4], target: [0, 0, 0], roll: 0, shift: [0, 0], ...over };
}

let n = 0;
/** Register a node that outputs a fixed camera, and return its type id. */
export function cameraSource(t: Harness, c: CameraValue): string {
  const id = `test-camera-${++n}`;
  t.registry.register({ id, title: id, category: 'input', description: 'test camera', inputs: {}, outputs: { out: { type: 'camera' } }, params: {}, render: () => ({ out: c }) });
  return id;
}

export interface Wire {
  camera?: CameraValue;
  captureCamera?: CameraValue;
  size?: ImageValue;
  image?: ImageValue;
  depth?: ImageValue;
}

/** Build `type` with params and wired inputs (cameras and images). Returns the graph and the node id. */
export function buildNode(t: Harness, type: string, params: Record<string, unknown>, wire: Wire, project?: Record<string, number | boolean>): { graph: GraphDoc; id: string } {
  let graph = createGraph('t');
  graph.project = { ...graph.project, width: 128, height: 96, fps: 10, duration: 2, loop: true, ...project };
  const a = addNode(graph, t.registry, type, { x: 0, y: 0 }, params);
  graph = a.graph;
  for (const [port, v] of Object.entries(wire)) {
    if (!v) continue;
    const srcType = (v as CameraValue).kind === 'camera' ? cameraSource(t, v as CameraValue) : t.source(v as ImageValue);
    const s = addNode(graph, t.registry, srcType);
    graph = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: a.node.id, port });
  }
  return { graph, id: a.node.id };
}

export async function evalPort(t: Harness, g: { graph: GraphDoc; id: string }, port = 'image', opts: { seconds?: number; proxy?: number; quality?: 'preview' | 'final' } = {}): Promise<Value | null> {
  const r = await t.engine.evaluate({ graph: g.graph, node: g.id, port, seconds: opts.seconds, proxy: opts.proxy, quality: opts.quality });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  return r.value;
}

export function save(name: string, px: Img, backdrop = false): string {
  mkdirSync(SPLAT_PNG_DIR, { recursive: true });
  return writePng(`splat/${name}`, px, backdrop);
}

/** Alpha-weighted centroid and second moments (pixels) of a straight-RGBA render. */
export function moments(px: { data: Uint8ClampedArray; width: number; height: number }, channel = 3) {
  let sw = 0, sx = 0, sy = 0;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
    const w = px.data[(y * px.width + x) * 4 + channel];
    sw += w; sx += w * (x + 0.5); sy += w * (y + 0.5);
  }
  if (sw === 0) return { w: 0, cx: 0, cy: 0, xx: 0, xy: 0, yy: 0 };
  const cx = sx / sw, cy = sy / sw;
  let xx = 0, xy = 0, yy = 0;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
    const w = px.data[(y * px.width + x) * 4 + channel];
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    xx += w * dx * dx; xy += w * dx * dy; yy += w * dy * dy;
  }
  return { w: sw, cx, cy, xx: xx / sw, xy: xy / sw, yy: yy / sw };
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Read an rgba16float image back as floats (4 per pixel). */
export async function readHalf(t: Harness, image: ImageValue): Promise<Float32Array> {
  const { width, height } = image;
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buf = t.gpu.scratch(bytesPerRow * height, GPUBufferUsage.MAP_READ, 'test readback');
  const enc = t.gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: image.texture }, { buffer: buf, bytesPerRow, rowsPerImage: height }, [width, height]);
  t.gpu.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ, 0, bytesPerRow * height);
  const src = new Uint16Array(buf.getMappedRange(0, bytesPerRow * height).slice(0));
  buf.unmap();
  t.gpu.releaseScratch(buf);
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) out[y * width * 4 + x] = halfToFloat(src[(y * bytesPerRow) / 2 + x]);
  return out;
}
