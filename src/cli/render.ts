/**
 * The batch renderer: one engine, one GPU, every (item x output) job written to disk.
 * Pure orchestration; argument parsing lives in main.ts and graph preparation in prepare.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
import { resolvePattern, sanitizeFileName, sequencePattern, uniqueName, type NameTokens } from '../io/naming';
import { exportPrint, readPrintParams, type PrintParams } from '../io/print/export';
import { distinctColors, formatReport, type ReportEntry } from '../io/export-report';
import { encodePngRgba } from '../io/png-encode';
import { writeSheetMeta } from '../io/spritesheet-meta';
import { bleedTransparent, buildSheets, type Bitmap } from '../io/spritesheet-pack';
import { buildOptionsOf, readSheetParams, tagsOfClips, type SheetParams } from '../io/spritesheet-params';
import { errorMessage, totalFramesOf } from '../io/util';
import { isVideoPreset, resolveVideoPreset } from '../engine/lib/video-presets';
import { CODECS, availableEncoders, ffmpegSoundFile, imageExt, normalizeImageFormat, parseCodec, VideoWriter, writePcmFile, writeStill, writeStillFloat, type CodecSpec, type ImageFormat } from './encode';
import { NodeFileSink } from './file-sink';
import { createHapGpuCompressor, type HapGpuCompressor, type HapSession } from '../io/encoders';
import type { EncodeSession, JpegEncoder } from '../io/encoders';
import { type CodecRow, stillRow } from '../io/export-codecs';
import { beginOwnVideo, encodeAudioOwn, frameModeOf, hapFormatOf } from '../io/own-export';
import { fileTimestamps, isReordered } from '../io/encode-order';
import { readFileSync } from 'node:fs';
import { NodeHost } from './host';
import { pendingProcesses } from '../engine/process';
import { EvalGate } from '../io/gate';
import { MemoryProcessLibrary, ProcessRuntime, pendingMessage } from '../io/processes';

type Img = ImageValue | MaskValue;
export type Kind = 'image' | 'sequence' | 'video' | 'spritesheet' | 'print';

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
  /** Sound-only export (--format wav|flac|mp3 ...): every item's Audio Output mix as one sound file. */
  sound?: CodecRow;
  quality?: number;
  bitrate?: number;
  /** Output node params forced on every output (the sheet / game flags: sheetLayout, sheetMeta, preset, extrude, powerOfTwo, sheetTrim, maxSheet, bleed, padding, columns). */
  outputParams?: Record<string, unknown>;
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
  /** Write export-report.json / export-report.txt into the output folder (file size, colors, off-palette fraction, frames per file). */
  report?: 'json' | 'text';
  reporter?: Reporter;
  /** Share a GPU (tests). */
  gpu?: Gpu;
  /**
   * Process mode (docs/ENGINE.md): what to do when an Output needs a process that is not done (a stand-in would be exported).
   * 'fail' (default) stops with the list; 'run' runs them first, in memory, for this render only (`--process`).
   */
  processes?: 'fail' | 'run';
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
  report: ReportEntry[];
}

interface OutParams {
  name: string;
  kind: 'auto' | Kind;
  print: PrintParams;
  imageFormat: ImageFormat;
  quality: number;
  hapQuality: 'fast' | 'better';
  hapSnappy: boolean;
  gifPalette: 'local' | 'global';
  gifDither: 'none' | 'ordered' | 'floyd';
  gifColors: number;
  gifLoop: number;
  codec: string;
  bitrate: number;
  /** The video "For" preset (general = none). */
  videoFor: string;
  /** Every frame a key frame (set by a "For" preset when it falls back to H.264 / VP9). */
  allKeys: boolean;
  scale: number;
  columns: number;
  padding: number;
  sheet: SheetParams;
}

function readParams(registry: Registry, node: NodeInstance, ov: Overrides): OutParams {
  const def = registry.get(node.type);
  const p = { ...(def ? defaultParams(def) : {}), ...node.params, ...(ov.outputParams ?? {}) } as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const kinds = ['auto', 'image', 'sequence', 'video', 'spritesheet', 'print'];
  const kind = (kinds.includes(p.kind as string) ? p.kind : 'auto') as OutParams['kind'];
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name : '{name}',
    kind: ov.kind ?? kind,
    print: readPrintParams(p),
    imageFormat: ov.imageFormat ?? normalizeImageFormat(String(p.imageFormat ?? 'png')) ?? 'png',
    quality: ov.quality ?? Math.min(1, Math.max(0.1, num(p.quality, 0.92))),
    hapQuality: p.hapQuality === 'better' ? 'better' : 'fast',
    hapSnappy: p.hapSnappy !== false,
    gifPalette: p.gifPalette === 'global' ? 'global' : 'local',
    gifDither: p.gifDither === 'none' || p.gifDither === 'floyd' ? p.gifDither : 'ordered',
    gifColors: Math.min(256, Math.max(2, Math.round(num(p.gifColors, 256)))),
    gifLoop: Math.max(0, Math.round(num(p.gifLoop, 0))),
    codec: typeof p.codec === 'string' ? p.codec : 'avc',
    bitrate: ov.bitrate ?? Math.max(0.5, num(p.bitrate, 12)),
    videoFor: isVideoPreset(p.videoFor) ? p.videoFor : 'general',
    allKeys: p.allKeys === true,
    scale: Math.max(1, Math.round(num(p.scale, 1))),
    columns: Math.max(0, Math.round(num(p.columns, 0))),
    padding: Math.max(0, Math.round(num(p.padding, 0))),
    sheet: readSheetParams(p),
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
  let graph = opts.graph;
  const summary: RenderSummary = { items: 0, jobs: 0, files: [], errors: [], skipped: [], plan: [], seconds: 0, report: [] };

  const { nodes: outs } = selectOutputs(graph, registry, opts.outputs);
  const usable: NodeInstance[] = outs;
  if (usable.length === 0 && !ov.sound) throw new Error('This graph has no exportable Output node (image-out). Add one and connect an image to it.');

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

  /** Make one batch item's assets known to the host. Returns an error message, or null. */
  const registerItemAssets = async (item: number): Promise<{ error: string | null; assets: Set<string> }> => {
    const itemAssets = new Set<string>();
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
    try {
      for (const id of itemAssets) await host.register(id);
    } catch (err) {
      return { error: errorMessage(err), assets: itemAssets };
    }
    return { error: null, assets: itemAssets };
  };

  // Export gate for process mode: never export a stand-in silently.
  if (engine) {
    const pending = pendingProcesses(graph, registry, (id) => engine.processStatus(graph, id), usable.map((n) => n.id));
    if (pending.length) {
      if (opts.processes !== 'run') {
        throw new Error(`${pendingMessage(pending)}
Run them in the app, or pass --process to run them first (headless, results are kept in memory for this render only).`);
      }
      const store = new MemoryProcessLibrary();
      store.gpu = gpu as Gpu;
      store.onChange = () => engine.clear();
      host.attachProcessStore(store);
      const runtime = new ProcessRuntime({
        engine,
        gpu: gpu as Gpu,
        registry,
        gate: new EvalGate(engine),
        library: store,
        host,
        activeProject: async () => 'cli',
        encode: async () => {
          throw new Error('A process that stores picture sequences (Cache / Bake) cannot run headlessly; bake it in the app.');
        },
      });
      rep.info(`Running ${pending.length} process${pending.length === 1 ? '' : 'es'} first: ${pending.map((p) => `${p.label} (${p.title})`).join(', ')}`);
      const prep = await registerItemAssets(items[0]);
      if (prep.error) throw new Error(prep.error);
      graph = await runtime.runPending(graph, usable.map((n) => n.id), {
        item: items[0],
        onProgress: (p) => rep.progress(p.label, Math.round(p.fraction * 100), 100),
      });
    }
  }

  const used = new Set<string>();
  const tmp = dry ? null : mkdtempSync(join(tmpdir(), 'rsmps-'));
  const total = items.length * usable.length;
  let jobNo = 0;

  try {
    for (const item of items) {
      // 1. Make this item's assets known to the host.
      const { error: prepError, assets: itemAssets } = await registerItemAssets(item);
      let sourceAsset: AssetInfo | null = null;

      let itemGraph = graph;
      if (ov.sound) {
        jobNo++;
        const where = `item ${item + 1}/${count} · sound`;
        rep.event({ event: 'job-start', item: item + 1, output: 'sound', job: jobNo, jobs: items.length });
        try {
          if (prepError) throw new Error(prepError);
          const written = await exportSound({ graph, registry, host, row: ov.sound, outDir: opts.outDir, tmp: tmp ?? tmpdir(), used, item, count, rep, where });
          for (const f of written) {
            summary.files.push(f);
            rep.event({ event: 'file', item: item + 1, output: 'sound', path: f });
          }
          summary.jobs++;
        } catch (err) {
          const message = errorMessage(err);
          summary.errors.push({ item: item + 1, output: 'sound', message });
          rep.warn(`${where}: ${message}`);
          rep.event({ event: 'error', item: item + 1, output: 'sound', message });
        }
        if (engine) {
          engine.clear();
          host.dropCaches();
          for (const id of itemAssets) host.forget(id);
        }
        continue;
      }
      for (const out of usable) {
        // One sheet for the whole batch: the first item makes it (it renders every item itself).
        if (batchSheetOut(out, ov, registry) && item !== items[0]) continue;
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
          } else kind = params.kind;
          let codec: CodecSpec = ov.codec ?? CODECS[parseCodec(params.codec) ?? 'h264'];
          const w0 = itemGraph.project.width;
          const h0 = itemGraph.project.height;
          const sw = w0 * params.scale;
          const sh = h0 * params.scale;
          if (kind === 'video' && !ov.codec && params.videoFor !== 'general') {
            // The "For" preset is resolved against the FFmpeg that is really installed.
            const have = await availableEncoders();
            const r = resolveVideoPreset(params.videoFor, { codec: params.codec, bitrate: params.bitrate, allKeys: params.allKeys }, { ffmpeg: true, encoders: have.size ? have : null }, sw * sh);
            codec = CODECS[parseCodec(r.codec) ?? 'h264'];
            params.bitrate = r.bitrate;
            params.allKeys = r.allKeys;
            if (r.note) rep.warn(`${where}: ${r.note}`);
          }

          if (dry) {
            const planned = planFiles(kind, params, codec, tokens, frames, sw, sh, used);
            summary.plan.push({ item: item + 1, output: label, kind: kind === 'video' ? `video (${codec.label})` : kind, frames: kind === 'image' ? 1 : frames, width: sw, height: sh, ...planned });
            continue;
          }

          const ctx: JobCtx = {
            engine: engine!, gpu: gpu as Gpu, host, graph: itemGraph, out, item, count, frames, params, tokens, used, outDir: opts.outDir, tmp: tmp!, rep, firstVideo, registry, label, where,
            report: opts.report ? summary.report : null,
            allItems: items,
            prepareItem: async (i) => {
              const r = await registerItemAssets(i);
              if (r.error) throw new Error(r.error);
              return () => {
                engine!.clear();
                host.dropCaches();
                for (const id of r.assets) host.forget(id);
              };
            },
            itemName: (i) => {
              for (const m of graph.nodes.filter((n) => up.has(n.id) && n.type === 'media-in')) {
                const id = assetIdFor(m, i);
                const info = id ? host.assetInfo(id) : null;
                if (info) return info.name;
              }
              return null;
            },
          };
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
            case 'print':
              written = await exportPrintSheets(ctx);
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
  if (opts.report && !dry && summary.report.length) {
    const name = opts.report === 'json' ? 'export-report.json' : 'export-report.txt';
    writeFileSync(join(opts.outDir, name), formatReport(summary.report, opts.report));
    summary.files.push(name);
  }
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
  /** Report entries are collected here when a report was asked for. */
  report: ReportEntry[] | null;
  /** Batch items that feed one sheet, and how to make one of them current (returns what to call to drop it again). */
  allItems: number[];
  prepareItem: (item: number) => Promise<() => void>;
  itemName: (item: number) => string | null;
}

/** An Output that makes one sheet from every batch item. */
function batchSheetOut(out: NodeInstance, ov: Overrides, registry: Registry): boolean {
  const p = readParams(registry, out, ov);
  return p.kind === 'spritesheet' && p.sheet.from === 'batch';
}

/** The largest offPalette that Palette Lock nodes upstream of the Output report at frame 0, or null when the chain has none. */
async function offPaletteOf(c: JobCtx): Promise<number | null> {
  const up = upstream(c.graph, c.out.id);
  let worst: number | null = null;
  for (const n of c.graph.nodes) {
    if (!up.has(n.id) || n.type !== 'palette-lock' || n.bypass) continue;
    const res = await c.engine.evaluate({ graph: c.graph, node: n.id, port: 'offPalette', seconds: 0, item: c.item, itemCount: c.count, proxy: 1, quality: 'final' });
    if (typeof res.value === 'number' && res.value >= 0) worst = Math.max(worst ?? 0, res.value);
  }
  return worst;
}

async function addReport(c: JobCtx, e: Omit<ReportEntry, 'bytes' | 'offPalette' | 'file'> & { files: string[] }): Promise<void> {
  if (!c.report) return;
  const off = await offPaletteOf(c);
  for (const file of e.files) {
    let bytes = 0;
    try {
      bytes = statSync(join(c.outDir, file)).size;
    } catch {
      /* not written yet / missing: report 0 */
    }
    const { files: _f, ...rest } = e;
    c.report.push({ ...rest, file, bytes, offPalette: off });
  }
}

/** PNG with straight alpha; with "bleed" the colour under transparent pixels is the nearest opaque colour (sharp would not promise to keep it). */
async function writePng(file: string, data: Uint8ClampedArray, width: number, height: number, bleed: boolean): Promise<void> {
  if (!bleed) return writeStill(file, data, width, height, 'png', 1);
  bleedTransparent(data, width, height);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await encodePngRgba(data, width, height));
}

function planFiles(kind: Kind, p: OutParams, codec: CodecSpec, tokens: JobCtx['tokens'], frames: number, w: number, h: number, used: Set<string>): { path: string; note?: string } {
  switch (kind) {
    case 'image':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.${imageExt(p.imageFormat)}`) };
    case 'video':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.${codec.ext}`) };
    case 'spritesheet':
      return { path: uniqueName(used, `${resolvePattern(p.name, tokens(w, h))}.png`), note: 'plus a .json next to it' };
    case 'print': {
      const base = sanitizeFileName(resolvePattern(p.name, tokens(w, h)));
      return { path: uniqueName(used, p.print.output === 'png' ? `${base}_page_01.png` : `${base}.pdf`), note: p.print.output === 'both' ? 'PDF plus one PNG per page' : p.print.output === 'png' ? 'one PNG per page' : undefined };
    }
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
function compose(gpu: Gpu, img: Img, scale: number, even: boolean, format?: 'rgba8unorm' | 'rgba16float'): Composed {
  const w = img.width * scale;
  const h = img.height * scale;
  const W = even ? Math.ceil(w / 2) * 2 : w;
  const H = even ? Math.ceil(h / 2) * 2 : h;
  if (W === img.width && H === img.height) return { drawable: img, release: () => undefined };
  const maxDim = gpu.device.limits.maxTextureDimension2D;
  if (W > maxDim || H > maxDim) throw new Error(`The output would be ${W}x${H}, larger than this GPU supports (${maxDim}). Lower the pixel upscale.`);
  const out = gpu.pass({
    label: 'cli-compose',
    format,
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

/** Print sheets for drawing on paper: the exporter's own sheet code, fed with frames from this engine. Writes the PDF and/or page PNGs. */
export async function exportPrintSheets(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const title = sanitizeFileName(resolvePattern(p.name, c.tokens(c.graph.project.width, c.graph.project.height)));
  const files = await exportPrint({
    params: p.print,
    title,
    frames: c.frames,
    fps: c.graph.project.fps,
    renderFrame: async (f) => {
      const px = await frameBytes(c, f, 1, false, true);
      return { width: px.width, height: px.height, data: px.data };
    },
    progress: (fraction) => c.rep.progress(c.label, Math.round(fraction * 100), 100),
    claim: (name) => uniqueName(c.used, name),
    yieldNow: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  mkdirSync(c.outDir, { recursive: true });
  const names: string[] = [];
  for (const f of files) {
    writeFileSync(join(c.outDir, f.name), Buffer.from(await f.blob.arrayBuffer()));
    names.push(f.name);
  }
  return names;
}

/** Formats that take the picture over black (premultiplied) from us: JPEG and the FFmpeg formats without alpha. Own formats composite themselves. */
function wantsPremultiplied(format: string): boolean {
  const row = stillRow(format);
  return format === 'jpeg' || (row?.route === 'ffmpeg' && !row.alpha);
}

/** Half-float pixels of a frame (float stills: OpenEXR, Radiance HDR, 16-bit TIFF). */
async function frameHalf(c: JobCtx, frame: number, scale: number): Promise<{ half: Uint16Array; width: number; height: number }> {
  const img = await renderFrame(c, frame);
  c.gpu.begin();
  try {
    const comp = compose(c.gpu, img, scale, false, img.texture.format === 'rgba16float' ? 'rgba16float' : undefined);
    try {
      return { half: await c.gpu.readFloat(comp.drawable), width: comp.drawable.width, height: comp.drawable.height };
    } finally {
      comp.release();
    }
  } finally {
    c.gpu.end();
    c.gpu.release(img.texture);
  }
}

async function exportImage(c: JobCtx): Promise<string[]> {
  const p = c.params;
  if (stillRow(p.imageFormat)?.float) {
    const f = await frameHalf(c, 0, p.scale);
    const name = uniqueName(c.used, `${resolvePattern(p.name, c.tokens(f.width, f.height))}.${imageExt(p.imageFormat)}`);
    await writeStillFloat(join(c.outDir, name), f.half, f.width, f.height, p.imageFormat);
    await addReport(c, { files: [name], kind: 'image', item: c.item + 1, width: f.width, height: f.height, frames: 1, colors: 0 });
    return [name];
  }
  const opaque = wantsPremultiplied(p.imageFormat);
  const f = await frameBytes(c, 0, p.scale, false, !opaque);
  const name = uniqueName(c.used, `${resolvePattern(p.name, c.tokens(f.width, f.height))}.${imageExt(p.imageFormat)}`);
  const colors = c.report ? distinctColors(f.data) : 0;
  if (p.imageFormat === 'png' && p.sheet.bleedStills) await writePng(join(c.outDir, name), f.data, f.width, f.height, true);
  else await writeStill(join(c.outDir, name), f.data, f.width, f.height, p.imageFormat, p.quality);
  await addReport(c, { files: [name], kind: 'image', item: c.item + 1, width: f.width, height: f.height, frames: 1, colors });
  return [name];
}

async function exportSequence(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const pattern = sequencePattern(p.name);
  const opaque = wantsPremultiplied(p.imageFormat);
  const float = stillRow(p.imageFormat)?.float === true;
  const files: string[] = [];
  let dir = '';
  for (let f = 0; f < c.frames; f++) {
    if (float) {
      const h = await frameHalf(c, f, p.scale);
      if (!dir) dir = uniqueName(c.used, sequenceDir(p.name, c.tokens(h.width, h.height)));
      const fname = `${dir}/${resolvePattern(pattern, c.tokens(h.width, h.height, f, c.frames))}.${imageExt(p.imageFormat)}`;
      await writeStillFloat(join(c.outDir, fname), h.half, h.width, h.height, p.imageFormat);
      await addReport(c, { files: [fname], kind: 'sequence', item: c.item + 1, width: h.width, height: h.height, frames: 1, colors: 0 });
      files.push(fname);
      c.rep.progress(c.label, f + 1, c.frames);
      continue;
    }
    const px = await frameBytes(c, f, p.scale, false, !opaque);
    if (!dir) dir = uniqueName(c.used, sequenceDir(p.name, c.tokens(px.width, px.height)));
    const name = `${dir}/${resolvePattern(pattern, c.tokens(px.width, px.height, f, c.frames))}.${imageExt(p.imageFormat)}`;
    const colors = c.report ? distinctColors(px.data) : 0;
    if (p.imageFormat === 'png' && p.sheet.bleedStills) await writePng(join(c.outDir, name), px.data, px.width, px.height, true);
    else await writeStill(join(c.outDir, name), px.data, px.width, px.height, p.imageFormat, p.quality);
    await addReport(c, { files: [name], kind: 'sequence', item: c.item + 1, width: px.width, height: px.height, frames: 1, colors });
    files.push(name);
    c.rep.progress(c.label, f + 1, c.frames);
  }
  return files;
}

async function exportSheet(c: JobCtx): Promise<string[]> {
  const p = c.params;
  const sp = p.sheet;
  const project = c.graph.project;
  const batch = sp.from === 'batch';
  const itemList = batch ? c.allItems : [c.item];
  const bitmaps: Bitmap[] = [];
  const clips: { name: string; frames: number }[] = [];
  const sourceName = c.tokens(0, 0).name;
  for (const item of itemList) {
    // A batch sheet walks the items itself: make each one's files known, render its frames, drop it again.
    const drop = batch ? await c.prepareItem(item) : null;
    try {
      const cc: JobCtx = { ...c, item };
      const name = batch ? sanitizeFileName(c.itemName(item) ?? `item${item + 1}`) : sourceName;
      if (!batch) clips.push({ name: sp.animName || sanitizeFileName(name), frames: c.frames });
      else clips.push({ name: sp.animName ? `${sp.animName}_${name}` : name, frames: c.frames });
      for (let f = 0; f < c.frames; f++) {
        const px = await frameBytes(cc, f, p.scale, false, true);
        bitmaps.push({ width: px.width, height: px.height, data: px.data });
        c.rep.progress(c.label, bitmaps.length, c.frames * itemList.length);
      }
    } finally {
      drop?.();
    }
  }
  const build = buildSheets(bitmaps, buildOptionsOf(sp));
  for (const pg of build.pages) if (pg.width * pg.height * 4 > 2 ** 31 - 1) throw new Error(`The sprite sheet would be ${pg.width}x${pg.height}: too large. Use fewer frames, a smaller size, more columns or a maximum sheet size.`);
  const base = resolvePattern(p.name, c.tokens(build.pages[0].width, build.pages[0].height));
  mkdirSync(c.outDir, { recursive: true });
  const images: string[] = [];
  const written: string[] = [];
  const colorSet = new Set<number>();
  for (const pg of build.pages) {
    const name = uniqueName(c.used, `${base}${pg.index ? `_${pg.index + 1}` : ''}.png`);
    images.push(name);
    if (c.report) distinctColors(pg.data, colorSet);
    if (sp.bleed) writeFileSync(join(c.outDir, name), await encodePngRgba(pg.data, pg.width, pg.height));
    else await sharp(Buffer.from(pg.data.buffer, pg.data.byteOffset, pg.data.byteLength), { raw: { width: pg.width, height: pg.height, channels: 4 } }).png().toFile(join(c.outDir, name));
    written.push(name);
  }
  const meta = writeSheetMeta(sp.meta, {
    baseName: sanitizeFileName(base),
    images,
    build,
    durationsMs: bitmaps.map(() => 1000 / project.fps),
    tags: tagsOfClips(clips),
    fps: project.fps,
    loop: project.loop,
    padding: sp.padding,
    extrude: sp.extrude,
    pivot: sp.pivot,
  });
  for (const m of meta) {
    const name = uniqueName(c.used, `${base}${m.suffix}.${m.ext}`);
    writeFileSync(join(c.outDir, name), m.text);
    written.push(name);
  }
  const first = build.pages[0];
  await addReport(c, { files: images, kind: 'spritesheet', item: c.item + 1, width: first.width, height: first.height, frames: bitmaps.length, colors: colorSet.size, pages: build.pages.length });
  return written;
}

/** Audio for a video export: the graph's audio output, else the first source video's own sound, else none. */
async function videoAudio(c: JobCtx, duration: number): Promise<PcmAudio | null> {
  const graph = c.graph;
  try {
    if (hasAudioOutput(graph, c.registry)) {
      const rendered = await renderAudioOffline(graph, c.registry, (id) => c.host.assetAudio(id), { duration, loop: graph.project.loop, item: c.item });
      if (rendered && rendered.channels.length && rendered.channels[0].length) return rendered;
    }
    const up = upstream(graph, c.out.id);
    // A Media Timeline upstream: the first file's sound would be the wrong sound for the edit (it comes through an Audio Output only).
    if (c.firstVideo?.info.hasAudio && !graph.nodes.some((n) => up.has(n.id) && n.type === 'media-timeline')) {
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

/** Motion JPEG in Node: sharp (libjpeg) writes each frame; the canvas the browser uses does not exist here. */
const sharpJpeg: JpegEncoder = async (rgba, width, height, quality) => {
  const buf = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: Math.round(quality * 100), chromaSubsampling: '4:2:0' })
    .toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** Formats the app writes itself (HAP, Motion JPEG, PNG and uncompressed MOV, GIF, APNG): no FFmpeg. MOV files stream straight to the file. */
async function exportVideoOwn(c: JobCtx, codec: CodecSpec): Promise<string[]> {
  const p = c.params;
  const row = codec.row;
  const fps = c.graph.project.fps;
  const { gpu } = c;
  let session: EncodeSession | null = null;
  let sink: NodeFileSink | null = null;
  let hapGpu: HapGpuCompressor | null = null;
  let mode = frameModeOf(row, p, true);
  const hapFmt = hapFormatOf(row);
  let pcm: PcmAudio | null = null;
  let audioPos = 0;
  let name = '';
  let outW = 0;
  let outH = 0;
  const pushAudio = async (seconds: number, all = false) => {
    if (!pcm || !session?.addAudio) return;
    const total = pcm.channels[0].length;
    const limit = all ? total : Math.min(total, Math.ceil(seconds * pcm.sampleRate));
    const chunk = Math.max(1024, Math.round(pcm.sampleRate / 10));
    while (audioPos < limit) {
      const n = Math.min(chunk, limit - audioPos);
      await session.addAudio(pcm.channels.map((ch) => ch.slice(audioPos, audioPos + n)));
      audioPos += n;
    }
  };
  try {
    for (let f = 0; f < c.frames; f++) {
      const img = await renderFrame(c, f);
      gpu.begin();
      try {
        const comp = compose(gpu, img, p.scale, false);
        try {
          const { width, height } = comp.drawable;
          if (!session) {
            outW = width;
            outH = height;
            if (hapFmt && mode === 'hap-gpu') {
              try {
                hapGpu = createHapGpuCompressor(gpu, width, height, hapFmt);
              } catch (err) {
                c.rep.warn(`${c.where}: GPU HAP compression is unavailable (${errorMessage(err)}); the CPU was used (slower).`);
                mode = frameModeOf(row, { hapQuality: 'better' }, false);
              }
            }
            pcm = row.audio && row.kind === 'video' ? await videoAudio(c, c.frames / fps) : null;
            name = uniqueName(c.used, `${resolvePattern(p.name, c.tokens(width, height))}.${row.ext}`);
            if (row.kind === 'video') sink = new NodeFileSink(join(c.outDir, name));
            session = beginOwnVideo({
              row,
              width,
              height,
              fps,
              frames: c.frames,
              hapQuality: p.hapQuality,
              hapSnappy: p.hapSnappy,
              gif: { palette: p.gifPalette, dither: p.gifDither, colors: p.gifColors, loop: p.gifLoop },
              jpeg: sharpJpeg,
              quality: 0.92,
              audio: pcm ? { sampleRate: pcm.sampleRate, channels: pcm.channels.length } : null,
              sink: sink ?? undefined,
            });
          }
          if (mode === 'hap-gpu' && hapGpu) {
            let src = comp.drawable.texture;
            if (src.format !== 'rgba8unorm') {
              src = gpu.pass({ label: 'hap-convert', size: comp.drawable, textures: { src: comp.drawable }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }' }).texture;
            }
            await (session as HapSession).addTexture(await hapGpu.compress({ texture: src }));
          } else {
            const data = await gpu.read(comp.drawable, mode === 'straight');
            if (mode !== 'straight') for (let i = 3; i < data.length; i += 4) data[i] = 255;
            await session.addFrame(data);
          }
        } finally {
          comp.release();
        }
      } finally {
        gpu.end();
        gpu.release(img.texture);
      }
      await pushAudio((f + 1) / fps + 0.1);
      c.rep.progress(c.label, f + 1, c.frames);
    }
    if (!session) throw new Error('No frames were rendered.');
    await pushAudio(0, true);
    const parts = await session.finish();
    if (!sink) {
      mkdirSync(c.outDir, { recursive: true });
      writeFileSync(join(c.outDir, name), Buffer.concat(parts.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
    } else {
      const size = statSync(join(c.outDir, name)).size;
      if (size < 6e8) {
        try {
          const b = readFileSync(join(c.outDir, name));
          // the demuxer logs a line for codecs it cannot decode (HAP...); only the packet timestamps are needed here
          const log = { error: console.error, warn: console.warn };
          console.error = () => undefined;
          console.warn = () => undefined;
          let stamps: number[];
          try {
            stamps = await fileTimestamps(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
          } finally {
            console.error = log.error;
            console.warn = log.warn;
          }
          if (stamps.length !== c.frames) c.rep.warn(`${c.where}: the written file holds ${stamps.length} frames, ${c.frames} were rendered.`);
          else if (isReordered(stamps)) c.rep.warn(`${c.where}: the written file stores its frames out of order.`);
        } catch {
          /* advisory */
        }
      }
    }
    void outW;
    void outH;
    return [name];
  } catch (err) {
    sink?.abort();
    throw err;
  } finally {
    hapGpu?.dispose();
  }
}

/** Sound only: the graph's Audio Output mix of one batch item as a sound file (own encoders, FFmpeg for the rest). */
async function exportSound(o: { graph: GraphDoc; registry: Registry; host: NodeHost; row: CodecRow; outDir: string; tmp: string; used: Set<string>; item: number; count: number; rep: Reporter; where: string }): Promise<string[]> {
  const { graph, registry, host, row } = o;
  if (!hasAudioOutput(graph, registry)) throw new Error('This graph has no Audio Output with sound wired to it.');
  const duration = totalFramesOf(graph.project) / graph.project.fps;
  const rendered = await renderAudioOffline(graph, registry, (id) => host.assetAudio(id), { duration, loop: graph.project.loop, item: o.item });
  if (!rendered || !rendered.channels.length || !rendered.channels[0].length) throw new Error('There is no enabled Audio Output with sound wired to it.');
  const pcm = fitAudio(rendered, 0, duration, false);
  let base = graph.name || 'audio';
  for (const n of graph.nodes) {
    const id = n.type === 'media-in' ? assetIdFor(n, o.item) : null;
    const info = id ? host.assetInfo(id) : null;
    if (info) {
      base = info.name;
      break;
    }
  }
  const name = uniqueName(o.used, `${sanitizeFileName(base)}.${row.ext}`);
  const file = join(o.outDir, name);
  mkdirSync(o.outDir, { recursive: true });
  if (row.route === 'own') {
    writeFileSync(file, Buffer.concat(encodeAudioOwn(row, pcm).map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
  } else {
    const pcmFile = join(o.tmp, `sound-${o.item}-${Date.now()}.f32`);
    const nch = Math.min(2, pcm.channels.length);
    writePcmFile(pcmFile, pcm.channels.slice(0, nch));
    await ffmpegSoundFile(row.id, pcmFile, pcm.sampleRate, nch, file);
  }
  return [name];
}

async function exportVideo(c: JobCtx, codec: CodecSpec): Promise<string[]> {
  if (codec.route === 'own') return exportVideoOwn(c, codec);
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
        writer = await VideoWriter.open({ file: join(c.outDir, name), width: px.width, height: px.height, fps, codec, bitrateMbps: p.bitrate, allKeys: p.allKeys, audio });
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
