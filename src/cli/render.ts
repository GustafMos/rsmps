/**
 * The batch renderer: one engine, one GPU, every (item x output) job written to disk.
 * Pure orchestration; argument parsing lives in main.ts and graph preparation in prepare.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import type { PcmAudio } from '../engine/audio/api';
import { renderAudioOffline } from '../engine/audio/offline';
import { hasAudioOutput } from '../engine/audio/runner';
import type { Registry } from '../engine/define';
import { Engine, defaultParams } from '../engine/engine';
import { Gpu, createHeadlessDevice } from '../engine/gpu/gpu';
import { batchCount, outputNodes, upstream } from '../engine/graph';
import type { AssetInfo, GraphDoc, ImageValue, MaskValue, NodeInstance } from '../engine/types';
import { fitAudio } from '../io/audio-util';
import { resolvePattern, sequencePattern, uniqueName, type NameTokens } from '../io/naming';
import { layoutSheet, sheetMetadata } from '../io/spritesheet';
import { errorMessage, totalFramesOf } from '../io/util';
import { CODECS, imageExt, normalizeImageFormat, parseCodec, VideoWriter, writePcmFile, writeStill, type CodecSpec, type ImageFormat } from './encode';
import { NodeHost } from './host';

type Img = ImageValue | MaskValue;
export type Kind = 'image' | 'sequence' | 'video' | 'spritesheet';

export interface Reporter {
  info(msg: string): void;
  warn(msg: string): void;
  /** Machine-readable event (printed only with --json). */
  event(e: Record<string, unknown>): void;
  /** Frame-level progress (text mode shows a single updating line). */
  progress(label: string, done: number, total: number): void;
}

export const silentReporter: Reporter = { info() {}, warn() {}, event() {}, progress() {} };

export interface Overrides {
  /** Force an export kind on every output. */
  kind?: Kind;
  imageFormat?: ImageFormat;
  codec?: CodecSpec;
  quality?: number;
  bitrate?: number;
}

export interface RenderOptions {
  graph: GraphDoc;
  registry: Registry;
  outDir: string;
  /** Output node ids or labels; empty = every image-out. */
  outputs?: string[];
  /** 0-based batch item indices; undefined = all. */
  items?: number[];
  overrides?: Overrides;
  /** Per item, use the duration of the first video source instead of the graph's. */
  durationFromSource?: boolean;
  sequenceFps: number;
  dryRun?: boolean;
  reporter?: Reporter;
  /** Share a GPU (tests). */
  gpu?: Gpu;
}

export interface PlannedFile {
  item: number;
  output: string;
  kind: string;
  /** Path relative to outDir (a folder for sequences). */
  path: string;
  frames: number;
  width?: number;
  height?: number;
  note?: string;
}

export interface RenderSummary {
  items: number;
  jobs: number;
  files: string[];
  errors: { item: number; output: string; message: string }[];
  skipped: string[];
  plan: PlannedFile[];
  seconds: number;
}

interface OutParams {
  name: string;
  kind: 'auto' | Kind | 'print';
  imageFormat: ImageFormat;
  quality: number;
  codec: string;
  bitrate: number;
  scale: number;
  columns: number;
  padding: number;
}

function readParams(registry: Registry, node: NodeInstance, ov: Overrides): OutParams {
  const def = registry.get(node.type);
  const p = { ...(def ? defaultParams(def) : {}), ...node.params } as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const kinds = ['auto', 'image', 'sequence', 'video', 'spritesheet', 'print'];
  const kind = (kinds.includes(p.kind as string) ? p.kind : 'auto') as OutParams['kind'];
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name : '{name}',
    kind: ov.kind ?? kind,
    imageFormat: ov.imageFormat ?? normalizeImageFormat(String(p.imageFormat ?? 'png')) ?? 'png',
    quality: ov.quality ?? Math.min(1, Math.max(0.1, num(p.quality, 0.92))),
    codec: typeof p.codec === 'string' ? p.codec : 'avc',
    bitrate: ov.bitrate ?? Math.max(0.5, num(p.bitrate, 12)),
    scale: Math.max(1, Math.round(num(p.scale, 1))),
    columns: Math.max(0, Math.round(num(p.columns, 0))),
    padding: Math.max(0, Math.round(num(p.padding, 0))),
  };
}

function assetIdFor(node: NodeInstance, item: number): string | null {
  const assets = node.params.assets;
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const id = assets[item % assets.length];
  return typeof id === 'string' ? id : null;
}

/** Output nodes this CLI can render, after the --outputs filter. */
export function selectOutputs(graph: GraphDoc, registry: Registry, filter: string[] = []): { nodes: NodeInstance[]; skipped: string[] } {
  const skipped: string[] = [];
  const all = outputNodes(graph, registry);
  const wanted = filter.map((f) => f.toLowerCase());
  const nodes: NodeInstance[] = [];
  for (const n of all) {
    if (wanted.length && !wanted.includes(n.id.toLowerCase()) && !wanted.includes((n.label ?? '').toLowerCase())) continue;
    if (n.type !== 'image-out') continue; // audio-out and plugin sinks are not image exports
    if (!wanted.length && (n.bypass || n.params.enabled === false)) continue; // switched off; name it with --outputs to render it anyway
    nodes.push(n);
  }
  for (const f of wanted) {
    if (!all.some((n) => n.id.toLowerCase() === f || (n.label ?? '').toLowerCase() === f)) throw new Error(`No output node matches "${f}". Outputs: ${all.map((n) => n.label || n.id).join(', ') || 'none'}`);
  }
  return { nodes, skipped };
}

export async function renderGraphBatch(opts: RenderOptions): Promise<RenderSummary> {
  const t0 = Date.now();
  const rep = opts.reporter ?? silentReporter;
  const { registry } = opts;
  const ov = opts.overrides ?? {};
  const graph = opts.graph;
  const summary: RenderSummary = { items: 0, jobs: 0, files: [], errors: [], skipped: [], plan: [], seconds: 0 };

  const { nodes: outs } = selectOutputs(graph, registry, opts.outputs);
  const usable: NodeInstance[] = [];
  for (const out of outs) {
    const p = readParams(registry, out, ov);
    if (p.kind === 'print') {
      const msg = `Output "${out.label || out.id}" uses export kind 'print', which the CLI renderer does not support yet: skipped.`;
      summary.skipped.push(msg);
      rep.warn(msg);
    } else usable.push(out);
  }
  if (usable.length === 0) throw new Error('This graph has no exportable Output node (image-out). Add one and connect an image to it.');

  const count = batchCount(graph, registry);
  const items = (opts.items ?? Array.from({ length: count }, (_, i) => i)).filter((i) => i >= 0 && i < count);
  if (items.length === 0) throw new Error(`No batch items selected (the graph has ${count}).`);
  summary.items = items.length;

  if (graph.nodes.some((n) => n.type === 'text' && !n.bypass)) {
    rep.warn('This graph uses a Text node: text cannot be rasterised headlessly, so it renders empty.');
  }

  const dry = !!opts.dryRun;
  let gpu = opts.gpu ?? null;
  if (!dry && !gpu) gpu = new Gpu(await createHeadlessDevice());
  const host = new NodeHost(gpu as Gpu, { sequenceFps: opts.sequenceFps });
  const engine = dry ? null : new Engine(gpu as Gpu, registry, host);
  if (engine) engine.cacheBudget = 512 * 1024 * 1024;

  const used = new Set<string>();
  const tmp = dry ? null : mkdtempSync(join(tmpdir(), 'rsmps-'));
  const total = items.length * usable.length;
  let jobNo = 0;

  try {
    for (const item of items) {
      // 1. Make this item's assets known to the host.
      const itemAssets = new Set<string>();
      let prepError: string | null = null;
      for (const n of graph.nodes) {
        const def = registry.get(n.type);
        if (!def || n.bypass) continue;
        for (const [key, p] of Object.entries(def.params)) {
          if ((p as { type: string }).type !== 'assets') continue;
          const list = n.params[key];
          if (!Array.isArray(list)) continue;
          const accept = (p as { accept?: string }).accept;
          const ids = accept === 'image-video' ? [list[item % Math.max(1, list.length)]] : list;
          for (const id of ids) if (typeof id === 'string') itemAssets.add(id);
        }
      }
      let sourceAsset: AssetInfo | null = null;
      try {
        for (const id of itemAssets) await host.register(id);
      } catch (err) {
        prepError = errorMessage(err);
      }

      let itemGraph = graph;
      for (const out of usable) {
        jobNo++;
        const label = out.label || out.id;
        const up = upstream(graph, out.id);
        const media = graph.nodes.filter((n) => up.has(n.id) && n.type === 'media-in');
        let sourceName = graph.name || 'output';
        sourceAsset = null;
        let firstVideo: { node: NodeInstance; info: AssetInfo } | null = null;
        for (const m of media) {
          const id = assetIdFor(m, item);
          const info = id ? host.assetInfo(id) : null;
          if (info && !sourceAsset) {
            sourceAsset = info;
            sourceName = info.name;
          }
          if (info?.kind === 'video' && !firstVideo) firstVideo = { node: m, info };
        }
        if (!sourceAsset && media.length) {
          const id = assetIdFor(media[0], item);
          if (id) sourceName = id.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
        }

        itemGraph = graph;
        if (opts.durationFromSource && firstVideo && firstVideo.info.duration > 0) {
          itemGraph = { ...graph, project: { ...graph.project, duration: firstVideo.info.duration } };
        }
        const params = readParams(registry, out, ov);
        const frames = totalFramesOf(itemGraph.project);
        const where = `item ${item + 1}/${count} · ${label}`;
        rep.event({ event: 'job-start', item: item + 1, output: label, job: jobNo, jobs: total });
        rep.info(`[${jobNo}/${total}] ${sourceName} → ${label}`);

        try {
          if (prepError) throw new Error(prepError);
          const tokens = (w: number, h: number, frame?: number, frameCount?: number): NameTokens => ({ name: sourceName, index: item, count, width: w, height: h, frame, frameCount });
          let kind: Kind;
          if (params.kind === 'auto') {
            if (ov.codec || firstVideo) kind = 'video';
            else if (dry) kind = frames > 1 ? 'video' : 'image';
            else kind = (await hasMotion(engine!, itemGraph, out.id, item, count, frames)) ? 'video' : 'image';
          } else if (params.kind === 'print') throw new Error("export kind 'print' is not supported by the CLI renderer");
          else kind = params.kind;
          const codec: CodecSpec = ov.codec ?? CODECS[parseCodec(params.codec) ?? 'h264'];
          const w0 = itemGraph.project.width;
          const h0 = itemGraph.project.height;
          const sw = w0 * params.scale;
          const sh = h0 * params.scale;

          if (dry) {
            const planned = planFiles(kind, params, codec, tokens, frames, sw, sh, used);
            summary.plan.push({ item: item + 1, output: label, kind: kind === 'video' ? `video (${codec.label})` : kind, frames: kind === 'image' ? 1 : frames, width: sw, height: sh, ...planned });
            continue;
          }

          const ctx: JobCtx = { engine: engine!, gpu: gpu as Gpu, host, graph: itemGraph, out, item, count, frames, params, tokens, used, outDir: opts.outDir, tmp: tmp!, rep, firstVideo, registry, label, where };
          let written: string[];
          switch (kind) {
            case 'image':
              written = await exportImage(ctx);
              break;
            case 'sequence':
              written = await exportSequence(ctx);
              break;
            case 'spritesheet':
              written = await exportSheet(ctx);
              break;
            case 'video':
              written = await exportVideo(ctx, codec);
              break;
          }
          for (const f of written) {
            summary.files.push(f);
            rep.event({ event: 'file', item: item + 1, output: label, path: f });
          }
          summary.jobs++;
        } catch (err) {
          const message = errorMessage(err);
          summary.errors.push({ item: item + 1, output: label, message });
          rep.warn(`${where}: ${message}`);
          rep.event({ event: 'error', item: item + 1, output: label, message });
        }
      }

      // 3. Free this item's decoded media and cached node results.
      if (engine) {
        engine.clear();
        host.dropCaches();
        for (const id of itemAssets) host.forget(id);
      }
    }
  } finally {
    host.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  summary.seconds = (Date.now() - t0) / 1000;
  return summary;
}

/* ------------------------------------------------------------------------------------------------ */

interface JobCtx {
  engine: Engine;
  gpu: Gpu;
  host: NodeHost;
  graph: GraphDoc;
  out: NodeInstance;
  item: number;
  count: number;
  frames: number;
  params: OutParams;
  tokens: (w: number, h: number, frame?: number, frameCount?: number) => NameTokens;
  used: Set<string>;
  outDir: string;
  tmp: string;
  rep: Reporter;
  firstVideo: { node: NodeInstance; info: AssetInfo } | null;
  registry: Registry;
  label: string;
  where: string;
}

function planFiles(kind: Kind, p: OutParams, codec: CodecSpec, tokens: JobCtx['tokens'], frames: number, w: number, h: number, used: Set<string>): { path: string; note?: string } {
  switch (kind) {
    case 'image':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.${imageExt(p.imageFormat)}`) };
    case 'video':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.${codec.ext}`) };
    case 'spritesheet':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.png`), note: 'plus a .json next to it' };
    case 'sequence': {
      const dir = uniqueName(used, sequenceDir(p.name, tokens(w, h)));
      return { path: `${dir}/${resolvePattern(sequencePattern(p.name), tokens(w, h, 0, frames))}.${imageExt(p.imageFormat)}`, note: `${frames} files` };
    }
  }
}

function sequenceDir(pattern: string, t: NameTokens): string {
  return resolvePattern(pattern.replace(/[_\-. ]*\{frame\}/gi, ''), t);
}

async function renderFrame(c: JobCtx, frame: number): Promise<Img> {
  const res = await c.engine.evaluate({
    graph: c.graph,
    node: c.out.id,
    seconds: frame / c.graph.project.fps,
    item: c.item,
    itemCount: c.count,
    proxy: 1,
    quality: 'final',
  });
  const v = res.value;
  if (v && typeof v === 'object' && 'texture' in v) {
    c.gpu.retain(v.texture);
    for (const [id, msg] of res.errors) c.rep.warn(`${c.where}: ${nodeLabel(c.graph, id)}: ${msg}`);
    return v as Img;
  }
  const [id, msg] = [...res.errors][0] ?? [];
  throw new Error(msg ? `${nodeLabel(c.graph, id!)}: ${msg}` : 'Nothing is connected to this output.');
}

function nodeLabel(g: GraphDoc, id: string): string {
  const n = g.nodes.find((x) => x.id === id);
  return n ? n.label || n.type : id;
}

/** Cheap motion test for kind 'auto': do frames 0, 1 and the middle differ? */
async function hasMotion(engine: Engine, graph: GraphDoc, out: string, item: number, count: number, frames: number): Promise<boolean> {
  if (frames <= 1) return false;
  const picks = [...new Set([0, 1, Math.floor(frames / 2)])].filter((f) => f < frames);
  let first: Uint8ClampedArray | null = null;
  const gpu = engine.gpu;
  for (const f of picks) {
    const res = await engine.evaluate({ graph, node: out, seconds: f / graph.project.fps, item, itemCount: count, proxy: 1, quality: 'final' });
    const v = res.value;
    if (!v || typeof v !== 'object' || !('texture' in v)) return false;
    gpu.retain(v.texture);
    let px: Uint8ClampedArray;
    try {
      px = await gpu.read(v as Img, false);
    } finally {
      gpu.release(v.texture);
    }
    if (!first) first = px;
    else if (px.length !== first.length || Buffer.compare(Buffer.from(px.buffer), Buffer.from(first.buffer)) !== 0) return true;
  }
  return false;
}

interface Composed {
  drawable: { texture: GPUTexture; width: number; height: number };
  release(): void;
}

/** Nearest upscale and/or pad to even size in one GPU pass. */
function compose(gpu: Gpu, img: Img, scale: number, even: boolean): Composed {
  const w = img.width * scale;
  const h = img.height * scale;
  const W = even ? Math.ceil(w / 2) * 2 : w;
  const H = even ? Math.ceil(h / 2) * 2 : h;
  if (W === img.width && H === img.height) return { drawable: img, release: () => undefined };
  const maxDim = gpu.device.limits.maxTextureDimension2D;
  if (W > maxDim || H > maxDim) throw new Error(`The output would be ${W}x${H}, larger than this GPU supports (${maxDim}). Lower the pixel upscale.`);
  const out = gpu.pass({
    label: 'cli-compose',
    size: { width: W, height: H },
    textures: { src: img },
    uniforms: { scale, srcSize: [img.width, img.height] },
    wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = vec2i(floor(px / u.scale));
  if (p.x >= i32(u.srcSize.x) || p.y >= i32(u.srcSize.y)) { return vec4f(0.0); }
  return textureLoad(src, p, 0);
}`,
  });
  gpu.retain(out.texture);
  return { drawable: { texture: out.texture, width: W, height: H }, release: () => gpu.release(out.texture) };
}

/** Render a frame and read it back: straight alpha, or premultiplied (= over black) for opaque targets. */
async function frameBytes(c: JobCtx, frame: number, scale: number, even: boolean, straight: boolean): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = await renderFrame(c, frame);
  c.gpu.begin();
  try {
    const comp = compose(c.gpu, img, scale, even);
    try {
      const data = await c.gpu.read(comp.drawable, straight);
      return { data, width: comp.drawable.width, height: comp.drawable.height };
    } finally {
      comp.release();
    }
  } finally {
    c.gpu.end();
    c.gpu.release(img.texture);
  }
}

function rel(c: JobCtx, abs: string): string {
  return relative(c.outDir, abs).replace(/\\/g, '/');
}

async function exportImage(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const opaque = p.imageFormat === 'jpeg';
  const f = await frameBytes(c, 0, p.scale, false, !opaque);
  const name = uniqueName(c.used, `${resolvePattern(p.name, c.tokens(f.width, f.height))}.${imageExt(p.imageFormat)}`);
  await writeStill(join(c.outDir, name), f.data, f.width, f.height, p.imageFormat, p.quality);
  return [name];
}

async function exportSequence(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const pattern = sequencePattern(p.name);
  const opaque = p.imageFormat === 'jpeg';
  const files: string[] = [];
  let dir = '';
  for (let f = 0; f < c.frames; f++) {
    const px = await frameBytes(c, f, p.scale, false, !opaque);
    if (!dir) dir = uniqueName(c.used, sequenceDir(p.name, c.tokens(px.width, px.height)));
    const name = `${dir}/${resolvePattern(pattern, c.tokens(px.width, px.height, f, c.frames))}.${imageExt(p.imageFormat)}`;
    await writeStill(join(c.outDir, name), px.data, px.width, px.height, p.imageFormat, p.quality);
    files.push(name);
    c.rep.progress(c.label, f + 1, c.frames);
  }
  return files;
}

async function exportSheet(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const project = c.graph.project;
  let layout: ReturnType<typeof layoutSheet> | null = null;
  let sheet: Buffer | null = null;
  for (let f = 0; f < c.frames; f++) {
    const px = await frameBytes(c, f, p.scale, false, true);
    if (!layout) {
      layout = layoutSheet(c.frames, px.width, px.height, p.columns, p.padding);
      if (layout.width * layout.height * 4 > 2 ** 31 - 1) throw new Error(`The spritesheet would be ${layout.width}x${layout.height}: too large. Use fewer frames, a smaller size or more columns.`);
      sheet = Buffer.alloc(layout.width * layout.height * 4);
    }
    if (px.width !== layout.frameWidth || px.height !== layout.frameHeight) throw new Error('Frame size changed during export.');
    const r = layout.rects[f];
    const src = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength);
    for (let y = 0; y < r.h; y++) src.copy(sheet!, ((r.y + y) * layout.width + r.x) * 4, y * r.w * 4, (y + 1) * r.w * 4);
    c.rep.progress(c.label, f + 1, c.frames);
  }
  if (!layout || !sheet) throw new Error('No frames were rendered.');
  const base = resolvePattern(p.name, c.tokens(layout.width, layout.height));
  const imageName = uniqueName(c.used, `${base}.png`);
  const jsonName = uniqueName(c.used, `${base}.json`);
  mkdirSync(c.outDir, { recursive: true });
  await sharp(sheet, { raw: { width: layout.width, height: layout.height, channels: 4 } }).png().toFile(join(c.outDir, imageName));
  const meta = sheetMetadata(layout, imageName, project.fps, project.loop);
  writeFileSync(join(c.outDir, jsonName), JSON.stringify(meta, null, 2));
  return [imageName, jsonName];
}

/** Audio for a video export: the graph's audio output, else the first source video's own sound, else none. */
async function videoAudio(c: JobCtx, duration: number): Promise<PcmAudio | null> {
  const graph = c.graph;
  try {
    if (hasAudioOutput(graph, c.registry)) {
      const rendered = await renderAudioOffline(graph, c.registry, (id) => c.host.assetAudio(id), { duration, loop: graph.project.loop });
      if (rendered && rendered.channels.length && rendered.channels[0].length) return rendered;
    }
    if (c.firstVideo?.info.hasAudio) {
      const source = await c.host.assetAudio(c.firstVideo.info.id);
      if (source) {
        const node = c.firstVideo.node;
        const offset = typeof node.params.offset === 'number' ? node.params.offset : 0;
        return fitAudio(source, offset, duration, node.params.loopVideo !== false);
      }
    }
  } catch (err) {
    c.rep.warn(`${c.where}: audio could not be prepared (${errorMessage(err)}); exported without sound.`);
  }
  return null;
}

async function exportVideo(c: JobCtx, codec: CodecSpec): Promise<string[]> {
  const p = c.params;
  const fps = c.graph.project.fps;
  let writer: VideoWriter | null = null;
  let name = '';
  try {
    for (let f = 0; f < c.frames; f++) {
      const px = await frameBytes(c, f, p.scale, codec.even, codec.alpha);
      if (!writer) {
        name = uniqueName(c.used, `${resolvePattern(p.name, c.tokens(px.width, px.height))}.${codec.ext}`);
        const pcm = await videoAudio(c, c.frames / fps);
        let audio: { file: string; sampleRate: number; channels: number } | undefined;
        if (pcm) {
          const file = join(c.tmp, `audio-${c.item}-${Date.now()}.f32`);
          writePcmFile(file, pcm.channels);
          audio = { file, sampleRate: pcm.sampleRate, channels: pcm.channels.length };
        }
        writer = await VideoWriter.open({ file: join(c.outDir, name), width: px.width, height: px.height, fps, codec, bitrateMbps: p.bitrate, audio });
      }
      if (!codec.alpha) for (let i = 3; i < px.data.length; i += 4) px.data[i] = 255; // premultiplied = composited over black
      await writer.write(px.data);
      c.rep.progress(c.label, f + 1, c.frames);
    }
    await writer!.finish();
    return [name];
  } catch (err) {
    await writer?.abort();
    throw err;
  }
}
