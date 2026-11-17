/**
 * Exporter: renders output nodes at final quality and encodes them.
 *
 * Every pixel path stays on the GPU: evaluation -> optional nearest upscale pass -> WebGPU
 * OffscreenCanvas -> convertToBlob (images) or VideoFrame -> mediabunny (video). Sprite sheets are
 * assembled with texture-to-texture copies. Per-item failures never abort a batch: they are
 * collected into errors.txt. Cancellation is honoured between frames.
 */
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { zipSync } from 'fflate';
import type { PcmAudio } from '../engine/audio/api';
import type { Registry } from '../engine/define';
import { defaultParams } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import { batchCount, enabledOutputs, outputNodes, upstream } from '../engine/graph';
import type { GraphDoc, ImageValue, MaskValue, NodeInstance } from '../engine/types';
import type { ExportRequest, ExportedFile, Exporter } from './api';
import type { AudioBridge } from './audio-bridge';
import { fitAudio } from './audio-util';
import { conformImage, enlargeNearest, type PassFormat } from './frame-gpu';
import { effectiveConform, isCustomFrame, pixelPlan, readFrameParams, resolveFrame } from './frame';
import { encodeWav } from './wav';
import { OffscreenPresenter, canEncodeAvif, presentToBlob, presentToFrame } from './encode';
import { choosePipeline, fileTimestamps, isReordered, sourceOptions } from './encode-order';
import { GpuWatch, scopeMessage } from './gpu-watch';
import type { EvalResult } from '../engine/engine';
import { SILENT_TRACKS, type SignalRouter } from './signals';
import type { EvalGate } from './gate';
import type { Library } from './library';
import { imageExtension, resolvePattern, sanitizeFileName, sequencePattern, uniqueName, type NameTokens } from './naming';
import { exportPrint, readPrintParams, type PrintParams } from './print/export';
import { layoutSheet } from './spritesheet';
import { encodePngRgba } from './png-encode';
import { writeSheetMeta } from './spritesheet-meta';
import { bleedTransparent, buildSheets, type Bitmap } from './spritesheet-pack';
import { buildOfLayout, buildOptionsOf, needsCpuSheet, readSheetParams, tagsOfClips, type SheetParams } from './spritesheet-params';
import { isDesktop, type FfmpegExportClient } from './desktop';
import { audioRow, encoderMissing, ffmpegFallbackCodec, ffmpegMissingMessage, ffmpegOnlyCodec, rowByValue, stillRow, videoRoute, type CodecRow, type FfmpegCodec } from './export-codecs';
import { MEMORY_LIMIT, beginOwnVideo, encodeAudioOwn, encodeStillOwn, estimateBytes, frameModeOf, hapFormatOf, streamsToSink, tooBigMessage } from './own-export';
import { createHapGpuCompressor, type HapGpuCompressor, type HapSession } from './encoders';
import { browserSinkEnv, openOutputSink, type OpenedSink } from './sinks';
import type { EncodeSession } from './encoders';
import { missingEncoderMessage } from './ffmpeg-encoders';
import { isVideoPreset, resolveVideoPreset } from '../engine/lib/video-presets';
import { savedEntry, streamToFfmpeg } from './export-ffmpeg';
import type { ProcessApi } from './api';
import { ProcessPendingError } from './processes';
import { errorMessage, hashString, isAbort, throwIfAborted, totalFramesOf, yieldToEventLoop } from './util';

export interface ExporterDeps {
  gpu: Gpu;
  gate: EvalGate;
  registry: Registry;
  library: Library;
  audio: AudioBridge;
  router?: SignalRouter;
  /** Pausing the player for the duration of an export keeps it from evaluating (and recycling textures) between frames. */
  player?: { hold(): () => void };
  watch?: GpuWatch;
  governor?: { enter(mode: 'export'): () => void };
  /** Desktop app only: FFmpeg export endpoints (ProRes-compatible, alpha formats). Absent in the web version. */
  ffmpeg?: FfmpegExportClient | null;
  /** Process mode: the export gate. Without it exports never check processes. */
  processes?: ProcessApi;
}

/** Thrown inside the WebCodecs path when it cannot encode H.264 / H.265 and FFmpeg can. */
class FfmpegFallback extends Error {
  constructor(public codec: FfmpegCodec) {
    super('Use FFmpeg');
  }
}

type Img = ImageValue | MaskValue;
type Kind = 'image' | 'sequence' | 'video' | 'spritesheet' | 'print';

interface OutParams {
  name: string;
  kind: 'auto' | Kind;
  /** A still row's value (png, webp, jpeg, avif, qoi, tiff, tga, bmp, exr, hdr, tiff16, dpx, ico, ppm, jp2). */
  imageFormat: string;
  quality: number;
  codec: string;
  bitrate: number;
  /** Every frame is a key frame (intra-only): bigger files, but VJ software and editors loop and scrub them frame-exactly. */
  allKeys: boolean;
  /** The Output's video "For" preset (general = none); resolved against what is available when the export runs. */
  videoFor?: string;
  /** HAP: 'fast' = GPU / no refinement, 'better' = CPU refinement (slow). */
  hapQuality: 'fast' | 'better';
  /** HAP: Snappy compression ("Smaller files"). */
  hapSnappy: boolean;
  gifPalette: 'local' | 'global';
  gifDither: 'none' | 'ordered' | 'floyd';
  gifColors: number;
  gifLoop: number;
  scale: number;
  columns: number;
  padding: number;
  pixelSize: number;
  exportArtSize: boolean;
  /** Sprite sheet and game export settings (the "For" preset already applied). */
  sheet: SheetParams;
  print: PrintParams;
}

interface Job {
  out: NodeInstance;
  params: OutParams;
  item: number;
  itemCount: number;
  /** Source asset base name for {name}. */
  sourceName: string;
  weight: number;
  label: string;
  /** Set by sequence / spritesheet exports that deliver art-size frames. */
  artMode?: boolean;
  /** Float stills (EXR, HDR, 16-bit TIFF): the conform and enlarge passes keep rgba16float instead of rounding to 8 bits. */
  keepFloat?: boolean;
  /** Sprite sheet from all batch items: the items that feed this one sheet. */
  sheetItems?: number[];
}

interface Run {
  req: ExportRequest;
  used: Set<string>;
  warnings: string[];
  progress: (fraction: number, label: string) => void;
}

interface Composed {
  drawable: { texture: GPUTexture; width: number; height: number };
  release(): void;
}

/** Cache budgets while an export runs (bytes of GPU texture memory). */
const EXPORT_ENGINE_CACHE = 192 * 1024 * 1024;
const EXPORT_MEDIA_CACHE = 128 * 1024 * 1024;

const MIME: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', avif: 'image/avif' };
const STILL_MIME: Record<string, string> = { qoi: 'image/qoi', tiff: 'image/tiff', tiff16: 'image/tiff', tga: 'image/x-tga', bmp: 'image/bmp', exr: 'image/x-exr', hdr: 'image/vnd.radiance', dpx: 'image/x-dpx', ico: 'image/vnd.microsoft.icon', ppm: 'image/x-portable-pixmap', jp2: 'image/jp2' };

export class ExporterImpl implements Exporter {
  private presenters = new Map<boolean, OffscreenPresenter>();

  constructor(private d: ExporterDeps) {}

  /** Late-bound: the process runtime needs the project store, which is created after the exporter. */
  setProcesses(p: ProcessApi | undefined): void {
    this.d.processes = p;
  }

  /* -------------------------------------------------------------------------------------------- */

  async run(req0: ExportRequest): Promise<ExportedFile[]> {
    const req = await this.processGate(req0);
    // Video frames must be frame-exact while exporting (the browser-player fallback may not use real-time playback).
    this.d.library.exact = true;
    const unhold = this.d.player?.hold(); // no player evaluations between export frames
    this.d.watch?.take();
    // An export touches every frame once: the engine / frame caches are not worth hundreds of MB then, and the memory is what keeps
    // large frames (1080x1920 with 20+ intermediate textures) from running the GPU out of memory.
    // With the memory governor the export mode of the shared budget applies; without it fixed budgets are used.
    const leaveMode = this.d.governor?.enter('export');
    const engineBudget = leaveMode ? 0 : this.d.gate.setCacheBudget(EXPORT_ENGINE_CACHE);
    const mediaBudget = leaveMode ? 0 : this.d.library.setFrameBudget(EXPORT_MEDIA_CACHE);
    await this.d.gate.exclusive(() => this.d.gpu.trim()); // never while an evaluation is mid-render
    try {
      return await this.runExact(req);
    } finally {
      if (leaveMode) leaveMode();
      else {
        this.d.gate.setCacheBudget(engineBudget);
        this.d.library.setFrameBudget(mediaBudget);
      }
      await this.d.gate.exclusive(() => this.d.gpu.trim());
      this.d.library.exact = false;
      this.releaseConformed();
      // The WebGPU canvases used for encoding keep swap-chain textures alive: give them back instead of holding them until the next export.
      for (const p of this.presenters.values()) p.dispose();
      this.presenters.clear();
      unhold?.();
    }
  }

  /**
   * Export gate for process mode: an export must not silently contain a stand-in. When a process upstream of the outputs is not done,
   * either run it first (`req.runProcesses`, results are reported through `onProcessResult` so the app can store them in the nodes)
   * or stop with a ProcessPendingError that lists them.
   */
  private async processGate(req: ExportRequest): Promise<ExportRequest> {
    const procs = this.d.processes;
    if (!procs) return req;
    const pending = procs.pending(req.graph, req.outputs);
    if (!pending.length) return req;
    if (!req.runProcesses) throw new ProcessPendingError(pending);
    const graph = await procs.runPending(req.graph, req.outputs, {
      signal: req.signal,
      item: req.item,
      onResult: req.onProcessResult,
      onProgress: (p) => req.onProgress?.({ fraction: 0, label: p.label }),
    });
    return { ...req, graph };
  }

  private async runExact(req: ExportRequest): Promise<ExportedFile[]> {
    const { registry } = this.d;
    const graph = req.graph;
    const ids = req.outputs.length ? req.outputs : enabledOutputs(graph, registry).map((n) => n.id);
    const picked = ids.map((id) => graph.nodes.find((n) => n.id === id)).filter((n): n is NodeInstance => !!n && registry.get(n.type)?.category === 'output');
    const outs = picked.filter((n) => this.hasInput(n, 'image'));
    // Audio Outs are muxed into videos. They are exported as a sound file only when asked for by id, or when the graph has no
    // picture output at all (then sound alone is the obvious intent).
    const audioOuts = picked.filter((n) => !this.hasInput(n, 'image') && this.hasInput(n, 'audio')).filter(() => req.outputs.length > 0 || outs.length === 0);
    if (outs.length === 0 && audioOuts.length === 0) throw new Error('This graph has no Output node to export. Add an Output node and connect an image to it.');

    const itemCount = batchCount(graph, registry);
    const items = req.items === 'all' ? Array.from({ length: itemCount }, (_, i) => i) : [Math.min(Math.max(0, req.item), itemCount - 1)];
    const frames = totalFramesOf(graph.project);

    const jobs: Job[] = [];
    for (const item of items) {
      for (const out of outs) {
        const params = this.readParams(out);
        // One sheet for the whole batch: only the first item makes the job, it renders every item.
        const sheetAll = params.kind === 'spritesheet' && params.sheet.from === 'batch';
        if (sheetAll && item !== items[0]) continue;
        const sourceName = this.sourceName(graph, out.id, item) ?? graph.name ?? 'output';
        const upstreamVideo = this.firstAssetOfKind(graph, out.id, item, 'video') !== null;
        let weight = 1;
        if (params.kind === 'sequence' || params.kind === 'video' || params.kind === 'spritesheet') weight = frames;
        else if (params.kind === 'print') weight = Math.max(1, Math.ceil(frames / params.print.step));
        else if (params.kind === 'auto') weight = upstreamVideo ? frames : 1;
        if (sheetAll) weight *= items.length;
        jobs.push({ out, params, item, itemCount, sourceName: sheetAll ? graph.name || 'sheet' : sourceName, weight, label: `${out.label || sanitizeFileName(sourceName)}${itemCount > 1 && !sheetAll ? ` #${item + 1}` : ''}`, sheetItems: sheetAll ? items : undefined });
      }
    }

    if (audioOuts.length) {
      jobs.push({ out: audioOuts[0], params: this.readParams(audioOuts[0]), item: items[0], itemCount, sourceName: graph.name || 'audio', weight: 1, label: 'Audio' });
    }

    const run: Run = {
      req,
      used: new Set(),
      warnings: [],
      progress: () => undefined,
    };
    let doneWeight = 0;
    let current = 0;
    run.progress = (fraction, label) => {
      const total = jobs.reduce((s, j) => s + j.weight, 0);
      const f = (doneWeight + jobs[current].weight * Math.min(1, Math.max(0, fraction))) / Math.max(1, total);
      req.onProgress?.({ fraction: Math.min(1, f), label });
    };

    const files: ExportedFile[] = [];
    const errors: string[] = [];
    // Phone Motion also needs the router in export mode: live phone values answer 0 there, so the node reads its recorded take (or says so).
    const audioSignals = this.d.audio.hasSignals(graph, registry);
    const sigs = this.d.router && (audioSignals || graph.nodes.some((n) => n.type === 'phone-motion')) ? this.d.router : null;
    let sigItem = -1;
    try {
    for (current = 0; current < jobs.length; current++) {
      const job = jobs[current];
      throwIfAborted(req.signal);
      run.progress(0, job.label);
      if (sigs && job.item !== sigItem) {
        sigItem = job.item;
        await this.prepareSignals(sigs, run, frames, job.item, audioSignals);
      }
      try {
        files.push(...(await this.exportJob(job, run)));
      } catch (err) {
        if (isAbort(err) || req.signal?.aborted) throw err;
        errors.push(`${job.label}: ${errorMessage(err)}`);
      }
      doneWeight += job.weight;
      await yieldToEventLoop();
    }
    } finally {
      this.releaseConformed();
      if (sigs) {
        sigs.endExport();
        await this.d.gate.clearEngine().catch(() => undefined); // drop frames rendered with export signals
      }
    }
    req.onProgress?.({ fraction: 1, label: 'Done' });

    const notes = [...errors, ...run.warnings.map((w) => `warning: ${w}`)];
    if (notes.length) {
      files.push({ name: uniqueName(run.used, 'errors.txt'), blob: new Blob([notes.join('\n') + '\n'], { type: 'text/plain' }) });
    }
    // Files FFmpeg already saved through the native dialog are not part of a ZIP.
    const saved = files.filter((f) => f.savedPath);
    const rest = files.filter((f) => !f.savedPath);
    if (req.zip && rest.length > 1) {
      return [...saved, { name: `${sanitizeFileName(graph.name || 'export')}.zip`, blob: await zipFiles(rest) }];
    }
    return [...saved, ...rest];
  }

  /**
   * Deterministic bridge values for one batch item: analyse the audio offline once, route Host.signal to the
   * per-frame tracks and drop engine results cached with other (live or previous-item) values.
   */
  private async prepareSignals(router: SignalRouter, run: Run, frames: number, item: number, analyse = true): Promise<void> {
    const { audio, registry, library } = this.d;
    const graph = run.req.graph;
    const fps = graph.project.fps;
    router.beginExport(SILENT_TRACKS(fps)); // from now on no live value can leak in
    if (!analyse) {
      await this.d.gate.clearEngine();
      return;
    }
    try {
      const tracks = await audio.analyzeSignals(graph, registry, (id) => library.assetAudio(id), { duration: frames / fps, fps, loop: graph.project.loop, item });
      if (tracks) router.beginExport(tracks);
      else run.warnings.push('Sound analysis is unavailable; sound-driven values export as 0.');
    } catch (err) {
      run.warnings.push(`Sound analysis failed (${errorMessage(err)}); sound-driven values export as 0.`);
    }
    await this.d.gate.clearEngine();
  }

  download(files: ExportedFile[]): void {
    files.filter((f) => !f.savedPath).forEach((file, i) => {
      setTimeout(() => {
        const url = URL.createObjectURL(file.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }, i * 250);
    });
  }

  /* ------------------------------------- planning ----------------------------------------------- */

  private readParams(node: NodeInstance): OutParams {
    const def = this.d.registry.get(node.type);
    const p = { ...(def ? defaultParams(def) : {}), ...node.params } as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
    return {
      name: typeof p.name === 'string' && p.name.trim() ? p.name : '{name}',
      kind: oneOf(p.kind, ['auto', 'image', 'sequence', 'video', 'spritesheet', 'print'] as const, 'auto'),
      imageFormat: typeof p.imageFormat === 'string' && stillRow(p.imageFormat) ? stillRow(p.imageFormat)!.value : 'png',
      quality: Math.min(1, Math.max(0.1, num(p.quality, 0.92))),
      codec: typeof p.codec === 'string' ? p.codec : 'avc',
      bitrate: Math.max(0.5, num(p.bitrate, 12)),
      allKeys: p.allKeys === true,
      videoFor: isVideoPreset(p.videoFor) ? p.videoFor : 'general',
      hapQuality: oneOf(p.hapQuality, ['fast', 'better'] as const, 'fast'),
      hapSnappy: p.hapSnappy !== false,
      gifPalette: oneOf(p.gifPalette, ['local', 'global'] as const, 'local'),
      gifDither: oneOf(p.gifDither, ['none', 'ordered', 'floyd'] as const, 'ordered'),
      gifColors: Math.min(256, Math.max(2, Math.round(num(p.gifColors, 256)))),
      gifLoop: Math.max(0, Math.round(num(p.gifLoop, 0))),
      scale: Math.max(1, Math.round(num(p.scale, 1))),
      pixelSize: readFrameParams(p).pixelSize,
      exportArtSize: p.exportArtSize === true,
      columns: Math.max(0, Math.round(num(p.columns, 0))),
      padding: Math.max(0, Math.round(num(p.padding, 0))),
      sheet: readSheetParams(p),
      print: readPrintParams(p),
    };
  }

  /** media-in nodes upstream of an output, in document order. */
  private mediaNodes(graph: GraphDoc, outId: string): NodeInstance[] {
    const up = upstream(graph, outId);
    return graph.nodes.filter((n) => up.has(n.id) && n.type === 'media-in');
  }

  private assetIdFor(node: NodeInstance, item: number): string | null {
    const assets = node.params.assets;
    if (!Array.isArray(assets) || assets.length === 0) return null;
    const id = assets[item % assets.length];
    return typeof id === 'string' ? id : null;
  }

  private sourceName(graph: GraphDoc, outId: string, item: number): string | null {
    for (const n of this.mediaNodes(graph, outId)) {
      const id = this.assetIdFor(n, item);
      const info = id ? this.d.library.assetInfo(id) : null;
      if (info) return info.name;
    }
    return null;
  }

  private firstAssetOfKind(graph: GraphDoc, outId: string, item: number, kind: 'video' | 'image'): { node: NodeInstance; assetId: string } | null {
    for (const n of this.mediaNodes(graph, outId)) {
      const id = this.assetIdFor(n, item);
      const info = id ? this.d.library.assetInfo(id) : null;
      if (id && info?.kind === kind) return { node: n, assetId: id };
    }
    return null;
  }

  /* ------------------------------------- one job ------------------------------------------------ */

  private hasInput(n: NodeInstance, type: string): boolean {
    const def = this.d.registry.get(n.type);
    return !!def && Object.values(def.inputs).some((i) => (i as { type: string }).type === type);
  }

  /** The sound file format of an Audio Output: the request's legacy name, else the node's "Sound file" setting, else 32-bit float WAV. */
  private soundFormatOf(job: Job, run: Run): CodecRow {
    const legacy: Record<string, string> = { wav: 'wav32f', m4a: 'aac', webm: 'webm-opus' };
    const asked = run.req.audioFormat;
    if (asked) return audioRow(legacy[asked] ?? asked) ?? audioRow('wav32f')!;
    const def = this.d.registry.get(job.out.type);
    const p = { ...(def ? defaultParams(def) : {}), ...job.out.params } as Record<string, unknown>;
    return (typeof p.soundFormat === 'string' ? audioRow(p.soundFormat) : null) ?? audioRow('wav32f')!;
  }

  /** Sound-only export: everything the enabled Audio Outs play, as one file. */
  private async exportAudio(job: Job, run: Run): Promise<ExportedFile[]> {
    const { audio, registry, library } = this.d;
    const graph = run.req.graph;
    const duration = totalFramesOf(graph.project) / graph.project.fps;
    const rendered = await audio.renderOffline(graph, registry, (id) => library.assetAudio(id), { duration, loop: graph.project.loop, item: job.item });
    if (!rendered || !rendered.channels.length || !rendered.channels[0].length) throw new Error('There is no enabled Audio Out with sound wired to it.');
    const pcm = fitAudio(rendered, 0, duration, false);
    const base = sanitizeFileName(graph.name || 'audio');
    let row = this.soundFormatOf(job, run);
    run.progress(0.5, `${base}`);
    const wav = audioRow('wav32f')!;
    const fallback = (why: string): ExportedFile => {
      run.warnings.push(`${row.label}: ${why}; exported ${wav.label} instead.`);
      row = wav;
      return { name: this.claim(run, `${base}.wav`), blob: new Blob(encodeAudioOwn(wav, pcm) as BlobPart[], { type: 'audio/wav' }) };
    };
    let file: ExportedFile | null = null;
    if (row.route === 'own') {
      const mime = row.ext === 'wav' ? 'audio/wav' : row.ext === 'aiff' ? 'audio/aiff' : 'audio/flac';
      file = { name: this.claim(run, `${base}.${row.ext}`), blob: new Blob(encodeAudioOwn(row, pcm) as BlobPart[], { type: mime }) };
    } else {
      // Where a browser can encode it, the browser does (AAC, Opus); FFmpeg (desktop) writes the rest and is the fallback for these two.
      if (row.route === 'builtin-webcodecs') {
        const kind = row.ext === 'm4a' ? 'm4a' : 'webm';
        const blob = await this.encodeCompressedAudio(pcm, kind).catch(() => null);
        if (blob) file = { name: this.claim(run, `${base}.${row.ext}`), blob };
      }
      if (!file) {
        const status = await this.ffmpegStatus();
        const client = this.d.ffmpeg;
        const fc = ffmpegOnlyCodec(row.value) ?? { id: row.id, label: row.label, even: false, alpha: false, ext: row.ext, encoder: row.encoders.join(' or '), encoders: row.encoders, bitrate: false };
        if (status.available && client?.convertAudio && !encoderMissing(fc, status.encoders)) {
          const nch = Math.min(2, pcm.channels.length);
          const inter = new Float32Array(pcm.channels[0].length * nch);
          for (let i = 0; i < pcm.channels[0].length; i++) for (let c = 0; c < nch; c++) inter[i * nch + c] = pcm.channels[c][i];
          try {
            const bytes = await client.convertAudio(row.id, inter, pcm.sampleRate, nch, run.req.signal);
            file = { name: this.claim(run, `${base}.${row.ext}`), blob: new Blob([bytes as BlobPart]) };
          } catch (err) {
            if (isAbort(err)) throw err;
            file = fallback(errorMessage(err));
          }
        } else {
          file = fallback(row.route === 'ffmpeg' ? ffmpegMissingMessage(isDesktop()) : `this browser cannot encode ${row.label}`);
        }
      }
    }
    run.progress(1, file.name);
    return [file];
  }

  private async encodeCompressedAudio(pcm: PcmAudio, format: 'm4a' | 'webm'): Promise<Blob | null> {
    const codecs: AudioCodec[] = format === 'm4a' ? ['aac'] : ['opus', 'vorbis'];
    const codec = await getFirstEncodableAudioCodec(codecs, { numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate }).catch(() => null);
    if (!codec) return null;
    const output = new Output({ format: format === 'm4a' ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
    const source = new AudioSampleSource({ codec, quality: new Quality({ bitrate: 192_000 }) });
    output.addAudioTrack(source);
    await output.start();
    const total = pcm.channels[0].length;
    const chunk = Math.round(pcm.sampleRate / 2);
    for (let at = 0; at < total; at += chunk) {
      const n = Math.min(chunk, total - at);
      const data = new Float32Array(n * pcm.channels.length);
      pcm.channels.forEach((c, k) => data.set(c.subarray(at, at + n), k * n));
      const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate, timestamp: at / pcm.sampleRate });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    return buffer ? new Blob([buffer], { type: format === 'm4a' ? 'audio/mp4' : 'audio/webm' }) : null;
  }

  private async exportJob(job: Job, run: Run): Promise<ExportedFile[]> {
    if (!this.hasInput(job.out, 'image')) return this.exportAudio(job, run);
    const graph = run.req.graph;
    let kind: Kind;
    if (job.params.kind === 'auto') {
      if (this.firstAssetOfKind(graph, job.out.id, job.item, 'video')) kind = 'video';
      else kind = (await this.hasMotion(job, run)) ? 'video' : 'image';
      if (kind === 'video') job.weight = totalFramesOf(graph.project);
    } else kind = job.params.kind;
    switch (kind) {
      case 'image':
        return this.exportImage(job, run);
      case 'sequence':
        return this.exportSequence(job, run);
      case 'spritesheet':
        return this.exportSheet(job, run);
      case 'video':
        return this.exportVideoRouted(job, run);
      case 'print':
        return this.exportPrintSheets(job, run);
    }
  }

  /** Auto mode: does the picture change over time? Compares a tiny readback signature of frames 0, 1 and the middle. */
  private async hasMotion(job: Job, run: Run): Promise<boolean> {
    const frames = totalFramesOf(run.req.graph.project);
    if (frames <= 1) return false;
    const picks = [...new Set([0, 1, Math.floor(frames / 2)])].filter((f) => f < frames);
    let first: string | null = null;
    for (const f of picks) {
      throwIfAborted(run.req.signal);
      const img = await this.renderFrame(job, run, f);
      this.d.gpu.retain(img.texture);
      let sig: string;
      try {
        sig = await this.signature(img);
      } finally {
        this.d.gpu.release(img.texture);
      }
      if (first === null) first = sig;
      else if (sig !== first) return true;
    }
    return false;
  }

  private async signature(img: Img): Promise<string> {
    const { gpu } = this.d;
    // The pass and the readback copy are submitted inside the scope (queue order keeps the temporary valid), then it is recycled.
    const pending = gpu.scoped(() => {
      const small = gpu.pass({
        label: 'export-signature',
        size: { width: 16, height: 16 },
        textures: { src: img },
        wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  let cell = 1.0 / 16.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / 4.0 - 0.5;
      acc += textureSampleLevel(src, smpNearest, uv + o * cell, 0.0);
    }
  }
  return acc / 16.0;
}`,
      });
      return gpu.read(small, false);
    });
    return hashString(Array.from(await pending).join(','));
  }

  /** Evaluate the output node at `frame`. The result texture is only valid until the next evaluation: retain it. */
  private conformed: GPUTexture | null = null;

  private releaseConformed(): void {
    if (this.conformed) this.d.gpu.release(this.conformed);
    this.conformed = null;
  }

  /** After a device loss was recovered: every GPU handle held here is invalid. */
  onDeviceReset(): void {
    this.conformed = null;
    this.presenters.clear();
  }

  private async renderFrame(job: Job, run: Run, frame: number): Promise<Img> {
    const graph = run.req.graph;
    this.releaseConformed();
    const fp = readFrameParams(job.out.params);
    const target = resolveFrame(graph.project, fp);
    const { gpu, gate } = this.d;
    const device = gpu.device;
    // Any GPU error while rendering this frame makes the picture WRONG (a failed pass leaves old texture content behind): catch it.
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    let gpuError: string | null = null;
    let res: EvalResult | null = null;
    let result: Img | null = null;
    let failure: unknown = null;
    try {
      res = await gate.evaluateHeld({
        canvas: isCustomFrame(graph.project, target) ? target : undefined,
        graph,
        node: job.out.id,
        seconds: frame / graph.project.fps,
        item: job.item,
        itemCount: job.itemCount,
        proxy: 1 / fp.pixelSize,
        quality: 'final',
      });
      await gpu.checkErrors(); // shader compile errors of this frame
      const v = res.value;
      if (!(v && typeof v === 'object' && 'texture' in v)) {
        const firstError = [...res.errors.values()][0];
        throw new Error(firstError ?? 'Nothing is connected to this output.');
      }
      const img = v as Img;
      // Conform to the art grid, then enlarge with hard pixels to the full frame (unless art-size export). The temporaries of
      // these passes are recycled when the scope closes; only the final texture is retained.
      const art = pixelPlan(target, fp.pixelSize).art;
      const keep: PassFormat | undefined = job.keepFloat && img.texture.format === 'rgba16float' ? 'rgba16float' : undefined;
      const out = gpu.scoped(() => {
        const conformed = conformImage(gpu, img, fp.pixelSize > 1 ? art : target, effectiveConform(fp), fp.conformAnchor, keep);
        const final = job.artMode ? conformed : enlargeNearest(gpu, conformed, fp.pixelSize, keep);
        if (final !== img) gpu.retain(final.texture);
        return final;
      });
      // One reference is held until the next renderFrame (or the end of the run); callers retain it again while encoding.
      if (out !== img) {
        gate.drop(res);
        this.conformed = out.texture;
      } else this.conformed = img.texture; // the gate's reference becomes the hold
      result = out;
    } catch (err) {
      failure = err;
      if (res && !result) gate.drop(res);
    }
    const oom = await device.popErrorScope();
    const validation = await device.popErrorScope();
    gpuError = scopeMessage('out-of-memory', oom) ?? scopeMessage('validation', validation) ?? this.d.watch?.take() ?? null;
    if (gpuError) {
      this.releaseConformed();
      throw new Error(`${gpuError}. Frame ${frame + 1} would be wrong, so the export was stopped. Close other tabs or lower the output size.`);
    }
    if (failure) throw failure;
    return result!;
  }

  /**
   * Nearest-neighbour upscale and/or pad to even dimensions in one GPU pass. Returns the input untouched
   * when nothing needs to change.
   */
  private compose(img: Img, scale: number, even: boolean, format?: PassFormat): Composed {
    const { gpu } = this.d;
    const w = img.width * scale;
    const h = img.height * scale;
    const W = even ? Math.ceil(w / 2) * 2 : w;
    const H = even ? Math.ceil(h / 2) * 2 : h;
    if (W === img.width && H === img.height) return { drawable: img, release: () => undefined };
    const maxDim = gpu.device.limits.maxTextureDimension2D;
    if (W > maxDim || H > maxDim) throw new Error(`The output would be ${W}x${H}, larger than this GPU supports (${maxDim}). Lower the pixel upscale.`);
    const out = gpu.scoped(() => {
      const o = gpu.pass({
        label: 'export-compose',
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
      gpu.retain(o.texture); // owned by the Composed below
      return o;
    });
    return { drawable: { texture: out.texture, width: W, height: H }, release: () => gpu.release(out.texture) };
  }

  private presenter(opaque: boolean): OffscreenPresenter {
    let p = this.presenters.get(opaque);
    if (!p) {
      p = new OffscreenPresenter(this.d.gpu, opaque);
      this.presenters.set(opaque, p);
    }
    return p;
  }

  /**
   * One still picture as a file. Browser formats (PNG, WebP, JPEG, AVIF) go through the canvas; the formats this app writes itself
   * (QOI, TIFF, TGA, BMP, ICO, PPM, OpenEXR, Radiance HDR, 16-bit TIFF) through src/io/own-export.ts; DPX and JPEG 2000 through FFmpeg.
   */
  private async encodeImage(img: Img, job: Job, run: Run): Promise<{ blob: Blob; ext: string }> {
    const { gpu } = this.d;
    const p = job.params;
    const row = stillRow(p.imageFormat);
    gpu.retain(img.texture);
    const own = row?.route === 'own' ? row : null;
    const comp = this.compose(img, p.scale, false, own?.float && img.texture.format === 'rgba16float' ? 'rgba16float' : undefined);
    try {
      const w = comp.drawable.width;
      const h = comp.drawable.height;
      if (own) {
        const px = own.float ? { half: await gpu.readFloat(comp.drawable) } : { rgba: await gpu.read(comp.drawable, true) };
        const bytes = await encodeStillOwn(own, px, w, h);
        return { blob: new Blob([bytes as BlobPart], { type: STILL_MIME[own.value] ?? 'application/octet-stream' }), ext: own.ext };
      }
      if (row?.route === 'ffmpeg') {
        const status = await this.ffmpegStatus();
        const client = this.d.ffmpeg;
        if (!status.available || !client?.convertStill) throw new Error(ffmpegMissingMessage(isDesktop()));
        const fc = ffmpegOnlyCodec(row.value)!;
        if (encoderMissing(fc, status.encoders)) throw new Error(missingEncoderMessage(fc.label, fc.encoder));
        const data = await gpu.read(comp.drawable, row.alpha);
        if (!row.alpha) for (let i = 3; i < data.length; i += 4) data[i] = 255;
        const bytes = await client.convertStill(row.id, data, w, h, run.req.signal);
        return { blob: new Blob([bytes as BlobPart], { type: STILL_MIME[row.value] ?? 'application/octet-stream' }), ext: row.ext };
      }
      let format = p.imageFormat;
      if (format === 'avif' && !(await canEncodeAvif())) {
        run.warnings.push(`${job.label}: this browser cannot encode AVIF, so PNG was written instead.`);
        format = 'png';
      }
      if (p.sheet.bleedStills && format === 'png') {
        // The canvas path is premultiplied and loses the colour under alpha 0: read straight pixels, bleed, write the PNG ourselves.
        const px = await gpu.read(comp.drawable as ImageValue, true);
        bleedTransparent(px, comp.drawable.width, comp.drawable.height);
        return { blob: new Blob([(await encodePngRgba(px, comp.drawable.width, comp.drawable.height)) as BlobPart], { type: 'image/png' }), ext: 'png' };
      }
      const mime = MIME[format] ?? 'image/png';
      // present() and convertToBlob() must run in the same task: no await between them.
      const blob = await presentToBlob(this.presenter(format === 'jpeg'), comp.drawable, mime, format === 'png' ? undefined : p.quality);
      return { blob, ext: blob.type === 'image/avif' ? 'avif' : imageExtension(blob.type) };
    } finally {
      comp.release();
      gpu.release(img.texture);
    }
  }

  private tokens(job: Job, w: number, h: number, frame?: number, frameCount?: number): NameTokens {
    return { name: job.sourceName, index: job.item, count: job.itemCount, width: w, height: h, frame, frameCount };
  }

  private claim(run: Run, name: string): string {
    return uniqueName(run.used, name);
  }

  /* ------------------------------------- stills ------------------------------------------------- */

  private async exportImage(job: Job, run: Run): Promise<ExportedFile[]> {
    job.keepFloat = stillRow(job.params.imageFormat)?.float === true;
    const img = await this.renderFrame(job, run, 0);
    const { blob, ext } = await this.encodeImage(img, job, run);
    const w = img.width * job.params.scale;
    const h = img.height * job.params.scale;
    const name = `${resolvePattern(job.params.name, this.tokens(job, w, h))}.${ext}`;
    run.progress(1, name);
    return [{ name: this.claim(run, name), blob }];
  }

  private async exportSequence(job: Job, run: Run): Promise<ExportedFile[]> {
    job.artMode = job.params.exportArtSize;
    job.keepFloat = stillRow(job.params.imageFormat)?.float === true;
    const graph = run.req.graph;
    const frames = totalFramesOf(graph.project);
    const pattern = sequencePattern(job.params.name);
    const files: ExportedFile[] = [];
    for (let f = 0; f < frames; f++) {
      throwIfAborted(run.req.signal);
      const img = await this.renderFrame(job, run, f);
      const { blob, ext } = await this.encodeImage(img, job, run);
      const name = `${resolvePattern(pattern, this.tokens(job, img.width * job.params.scale, img.height * job.params.scale, f, frames))}.${ext}`;
      files.push({ name: this.claim(run, name), blob });
      run.progress((f + 1) / frames, `${name} · frame ${f + 1}/${frames}`);
      await yieldToEventLoop();
    }
    return files;
  }

  /* ------------------------------------- spritesheet -------------------------------------------- */

  private async exportSheet(job: Job, run: Run): Promise<ExportedFile[]> {
    job.artMode = job.params.exportArtSize;
    if (needsCpuSheet(job.params.sheet)) return this.exportSheetCpu(job, run);
    return this.exportSheetGrid(job, run);
  }

  /** Layouts the GPU copy cannot do (row, packed, trim, extrude, power of two, pages, bleed, a whole batch): frames are read back and assembled by spritesheet-pack. */
  private async exportSheetCpu(job: Job, run: Run): Promise<ExportedFile[]> {
    const { gpu } = this.d;
    const graph = run.req.graph;
    const project = graph.project;
    const sp = job.params.sheet;
    const frames = totalFramesOf(project);
    const itemList = job.sheetItems ?? [job.item];
    const home = job.item;
    const bitmaps: Bitmap[] = [];
    const clips: { name: string; frames: number }[] = [];
    let bytes = 0;
    try {
      for (const item of itemList) {
        job.item = item;
        const name = sp.animName && itemList.length === 1 ? sp.animName : sanitizeFileName(this.sourceName(graph, job.out.id, item) ?? job.sourceName);
        clips.push({ name: sp.animName && itemList.length > 1 ? `${sp.animName}_${name}` : name, frames });
        for (let f = 0; f < frames; f++) {
          throwIfAborted(run.req.signal);
          const img = await this.renderFrame(job, run, f);
          gpu.retain(img.texture);
          const comp = this.compose(img, job.params.scale, false);
          try {
            const data = await gpu.read(comp.drawable as ImageValue, true);
            bytes += data.byteLength;
            if (bytes > 1.5e9) throw new Error('The frames of this sprite sheet need more than 1.5 GB of memory. Use fewer frames or a smaller size.');
            bitmaps.push({ width: comp.drawable.width, height: comp.drawable.height, data });
          } finally {
            comp.release();
            gpu.release(img.texture);
          }
          run.progress((bitmaps.length / (frames * itemList.length)) * 0.9, `Sheet · frame ${bitmaps.length}/${frames * itemList.length}`);
          await yieldToEventLoop();
        }
      }
    } finally {
      job.item = home;
    }
    const build = buildSheets(bitmaps, buildOptionsOf(sp));
    const maxDim = gpu.device.limits.maxTextureDimension2D;
    for (const pg of build.pages) if (pg.width > maxDim || pg.height > maxDim) run.warnings.push(`${job.label}: a sheet page is ${pg.width}x${pg.height}, larger than this GPU's texture limit (${maxDim}); engines may refuse it.`);
    const base = resolvePattern(job.params.name, this.tokens(job, build.pages[0].width, build.pages[0].height));
    const files: ExportedFile[] = [];
    const imageNames: string[] = [];
    for (const pg of build.pages) {
      const png = await encodePngRgba(pg.data, pg.width, pg.height);
      const name = this.claim(run, `${base}${pg.index ? `_${pg.index + 1}` : ''}.png`);
      imageNames.push(name);
      files.push({ name, blob: new Blob([png as BlobPart], { type: 'image/png' }) });
      await yieldToEventLoop();
    }
    const fps = project.fps;
    const meta = writeSheetMeta(sp.meta, {
      baseName: sanitizeFileName(base),
      images: imageNames,
      build,
      durationsMs: bitmaps.map(() => 1000 / fps),
      tags: tagsOfClips(clips),
      fps,
      loop: project.loop,
      padding: sp.padding,
      extrude: sp.extrude,
      pivot: sp.pivot,
    });
    for (const m of meta) files.push({ name: this.claim(run, `${base}${m.suffix}.${m.ext}`), blob: new Blob([m.text], { type: m.ext === 'css' ? 'text/css' : 'application/json' }) });
    run.progress(1, imageNames[0]);
    return files;
  }

  /** The plain grid: frames are copied texture to texture on the GPU, no readback. */
  private async exportSheetGrid(job: Job, run: Run): Promise<ExportedFile[]> {
    const { gpu } = this.d;
    const graph = run.req.graph;
    const project = graph.project;
    const frames = totalFramesOf(project);
    let sheet: { texture: GPUTexture; width: number; height: number } | null = null;
    let layout: ReturnType<typeof layoutSheet> | null = null;
    try {
      for (let f = 0; f < frames; f++) {
        throwIfAborted(run.req.signal);
        const img = await this.renderFrame(job, run, f);
        gpu.retain(img.texture);
        const comp = this.compose(img, job.params.scale, false);
        try {
          if (!layout) {
            layout = layoutSheet(frames, comp.drawable.width, comp.drawable.height, job.params.columns, job.params.padding);
            const maxDim = gpu.device.limits.maxTextureDimension2D;
            if (layout.width > maxDim || layout.height > maxDim) {
              throw new Error(`The sprite sheet would be ${layout.width}x${layout.height}, larger than this GPU supports (${maxDim}). Use fewer frames, a smaller size or more columns.`);
            }
            const cleared = gpu.pass({ label: 'sheet-clear', size: { width: layout.width, height: layout.height }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' });
            gpu.retain(cleared.texture);
            sheet = { texture: cleared.texture, width: layout.width, height: layout.height };
          }
          const d = comp.drawable;
          if (d.width !== layout.frameWidth || d.height !== layout.frameHeight) throw new Error('Frame size changed during export.');
          let src = d.texture;
          let converted: ImageValue | null = null;
          if (src.format !== sheet!.texture.format) {
            converted = gpu.pass({
              label: 'sheet-convert',
              size: d,
              textures: { src: d },
              wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }',
            });
            gpu.retain(converted.texture);
            src = converted.texture;
          }
          const r = layout.rects[f];
          const enc = gpu.device.createCommandEncoder();
          enc.copyTextureToTexture({ texture: src }, { texture: sheet!.texture, origin: [r.x, r.y] }, [r.w, r.h]);
          gpu.device.queue.submit([enc.finish()]);
          if (converted) {
            // The copy is queued; the pool may reuse the texture only after later submissions, which are ordered.
            gpu.release(converted.texture);
          }
        } finally {
          comp.release();
          gpu.release(img.texture);
        }
        run.progress(((f + 1) / frames) * 0.95, `Sheet · frame ${f + 1}/${frames}`);
        await yieldToEventLoop();
      }
      if (!sheet || !layout) throw new Error('No frames were rendered.');
      const png = await this.presenterBlob(sheet, 'image/png');
      const base = resolvePattern(job.params.name, this.tokens(job, layout.width, layout.height));
      const imageName = this.claim(run, `${base}.png`);
      const sp = job.params.sheet;
      const metaFiles = writeSheetMeta(sp.meta, {
        baseName: sanitizeFileName(base),
        images: [imageName],
        build: buildOfLayout(layout),
        durationsMs: Array.from({ length: frames }, () => 1000 / project.fps),
        tags: tagsOfClips([{ name: sp.animName || sanitizeFileName(job.sourceName), frames }]),
        fps: project.fps,
        loop: project.loop,
        padding: layout.padding,
        extrude: 0,
        pivot: sp.pivot,
      });
      run.progress(1, imageName);
      return [
        { name: imageName, blob: png },
        ...metaFiles.map((m) => ({ name: this.claim(run, `${base}${m.suffix}.${m.ext}`), blob: new Blob([m.text], { type: m.ext === 'css' ? 'text/css' : 'application/json' }) })),
      ];
    } finally {
      if (sheet) gpu.release((sheet as { texture: GPUTexture }).texture);
    }
  }

  private presenterBlob(img: { texture: GPUTexture; width: number; height: number }, mime: string): Promise<Blob> {
    return presentToBlob(this.presenter(false), img, mime);
  }

  /* ------------------------------------- print sheets ------------------------------------------- */

  private async exportPrintSheets(job: Job, run: Run): Promise<ExportedFile[]> {
    const graph = run.req.graph;
    const baseName = resolvePattern(job.params.name, this.tokens(job, 0, 0));
    return exportPrint({
      params: job.params.print,
      title: sanitizeFileName(baseName),
      frames: totalFramesOf(graph.project),
      fps: graph.project.fps,
      signal: run.req.signal,
      renderFrame: async (f) => {
        const { gpu } = this.d;
        const img = await this.renderFrame(job, run, f);
        gpu.retain(img.texture);
        try {
          return { width: img.width, height: img.height, data: await gpu.read(img, true) };
        } finally {
          gpu.release(img.texture);
        }
      },
      progress: (fraction, label) => run.progress(fraction, label),
      claim: (name) => this.claim(run, name),
      yieldNow: yieldToEventLoop,
    });
  }

  /* ------------------------------------- video -------------------------------------------------- */

  /** FFmpeg-only formats stream to the desktop app; everything else is the WebCodecs path (with FFmpeg as a fallback for H.264 / H.265). */
  private async exportVideoRouted(job0: Job, run: Run): Promise<ExportedFile[]> {
    const status = await this.ffmpegStatus();
    let job = job0;
    // The "For" preset is resolved here, with what is really available, never earlier.
    if (job0.params.videoFor && job0.params.videoFor !== 'general') {
      const proj = run.req.graph?.project;
      const px = proj ? proj.width * proj.height * job0.params.scale * job0.params.scale : NaN;
      const r = resolveVideoPreset(job0.params.videoFor, { codec: job0.params.codec, bitrate: job0.params.bitrate, allKeys: job0.params.allKeys }, { ffmpeg: status.available, encoders: status.encoders ? new Set(status.encoders) : null }, Number.isFinite(px) && px > 0 ? px : undefined);
      job = { ...job0, params: { ...job0.params, codec: r.codec, bitrate: r.bitrate, allKeys: r.allKeys } };
      if (r.note) run.warnings.push(`${job.label}: ${r.note}`);
    }
    const own = rowByValue(job.params.codec);
    if (own && videoRoute(job.params.codec, status.available) === 'own') return this.exportVideoOwn(job, run, own);
    const only = ffmpegOnlyCodec(job.params.codec);
    if (only) {
      const route = videoRoute(job.params.codec, status.available);
      if (route === 'missing') throw new Error(ffmpegMissingMessage(isDesktop()));
      if (encoderMissing(only, status.encoders)) throw new Error(missingEncoderMessage(only.label, only.encoder));
      return this.exportVideoFfmpeg(job, run, only);
    }
    try {
      return await this.exportVideo(job, run);
    } catch (err) {
      if (!(err instanceof FfmpegFallback)) throw err;
      run.warnings.push(`${job.label}: this app's built-in encoder cannot make ${err.codec.id === 'hevc' ? 'H.265' : 'H.264'} video, so FFmpeg was used.`);
      return this.exportVideoFfmpeg(job, run, err.codec);
    }
  }

  private async ffmpegStatus(): Promise<{ available: boolean; encoders: string[] | null }> {
    try {
      const i = await this.d.ffmpeg?.info();
      return { available: i?.available === true, encoders: i?.available === true ? (i.encoders ?? null) : null };
    } catch {
      return { available: false, encoders: null };
    }
  }

  private async ffmpegReady(): Promise<boolean> {
    return (await this.ffmpegStatus()).available;
  }

  private async exportVideoFfmpeg(job: Job, run: Run, codec: FfmpegCodec): Promise<ExportedFile[]> {
    const { gpu, ffmpeg } = this.d;
    if (!ffmpeg) throw new Error(ffmpegMissingMessage(isDesktop()));
    const project = run.req.graph.project;
    const frames = totalFramesOf(project);
    const render = async (f: number) => {
      throwIfAborted(run.req.signal);
      const img = await this.renderFrame(job, run, f);
      gpu.retain(img.texture);
      const comp = this.compose(img, job.params.scale, codec.even);
      try {
        // Formats without alpha get the picture over black (premultiplied), exactly what the WebCodecs path does.
        const data = await gpu.read(comp.drawable, codec.alpha);
        return { width: comp.drawable.width, height: comp.drawable.height, data };
      } finally {
        comp.release();
        gpu.release(img.texture);
      }
    };
    const result = await streamToFfmpeg({
      client: ffmpeg,
      codec,
      fps: project.fps,
      frames,
      bitrateMbps: job.params.bitrate,
      allKeys: job.params.allKeys,
      signal: run.req.signal,
      name: (size) => resolvePattern(job.params.name, this.tokens(job, size.width, size.height)),
      render,
      audio: () => this.videoAudio(job, run, frames / project.fps),
      onProgress: (fraction, label) => run.progress(fraction, label),
      yieldNow: yieldToEventLoop,
    });
    if (!result.saved || !result.path) throw new DOMException('Save canceled', 'AbortError'); // the user closed the Save dialog
    run.progress(1, result.path);
    return [savedEntry(result.path)];
  }

  /**
   * Formats this app writes itself (HAP, Motion JPEG, PNG and uncompressed MOV, GIF, APNG): no FFmpeg, no WebCodecs. Frames come from the same
   * render loop as every video export; MOV files stream to a sink (the desktop file, a File System Access file, or memory with a size check).
   */
  private async exportVideoOwn(job: Job, run: Run, row: CodecRow): Promise<ExportedFile[]> {
    const { gpu } = this.d;
    const project = run.req.graph.project;
    const frames = totalFramesOf(project);
    const fps = project.fps;
    const p = job.params;
    let session: EncodeSession | null = null;
    let opened: OpenedSink | null = null;
    let hapGpu: HapGpuCompressor | null = null;
    let mode = frameModeOf(row, p, true);
    let pcm: PcmAudio | null = null;
    let audioPos = 0;
    let outW = 0;
    let outH = 0;
    const hapFmt = hapFormatOf(row);
    const audioChunk = () => Math.max(1024, Math.round((pcm?.sampleRate ?? 48000) / 10));
    const pushAudio = async (seconds: number, all = false) => {
      if (!pcm || !session?.addAudio) return;
      const total = pcm.channels[0].length;
      const limit = all ? total : Math.min(total, Math.ceil(seconds * pcm.sampleRate));
      while (audioPos < limit) {
        const n = Math.min(audioChunk(), limit - audioPos);
        await session.addAudio(pcm.channels.map((c) => c.slice(audioPos, audioPos + n)));
        audioPos += n;
      }
    };
    try {
      for (let f = 0; f < frames; f++) {
        throwIfAborted(run.req.signal);
        const img = await this.renderFrame(job, run, f);
        gpu.retain(img.texture);
        const comp = this.compose(img, p.scale, false);
        try {
          const { width, height } = comp.drawable;
          if (!session) {
            outW = width;
            outH = height;
            if (hapFmt && mode === 'hap-gpu') {
              try {
                hapGpu = createHapGpuCompressor(gpu, width, height, hapFmt);
              } catch (err) {
                run.warnings.push(`${job.label}: GPU HAP compression is unavailable here (${errorMessage(err)}); the CPU was used (slower).`);
                mode = frameModeOf(row, { hapQuality: 'better' }, false);
              }
            }
            pcm = row.audio && row.kind === 'video' ? await this.videoAudio(job, run, frames / fps) : null;
            const estimate = estimateBytes(row, { width, height, frames, hapSnappy: p.hapSnappy });
            const name = `${resolvePattern(p.name, this.tokens(job, width, height))}.${row.ext}`;
            if (streamsToSink(row)) {
              opened = await openOutputSink(browserSinkEnv(this.d.ffmpeg), { name, mime: 'video/quicktime', estimate, signal: run.req.signal });
              if (opened.kind === 'memory' && estimate > 4e8) run.warnings.push(`${job.label}: this export (about ${(estimate / 1e9).toFixed(1)} GB) is kept in memory. A browser with file saving (Chrome, Edge) or the desktop app writes straight to disk.`);
            } else if (estimate > MEMORY_LIMIT) throw new Error(tooBigMessage(estimate));
            session = beginOwnVideo({
              row,
              width,
              height,
              fps,
              frames,
              hapQuality: p.hapQuality,
              hapSnappy: p.hapSnappy,
              gif: { palette: p.gifPalette, dither: p.gifDither, colors: p.gifColors, loop: p.gifLoop },
              audio: pcm ? { sampleRate: pcm.sampleRate, channels: pcm.channels.length } : null,
              sink: opened?.sink,
            });
          }
          if (mode === 'hap-gpu' && hapGpu) {
            // The compressor reads 8-bit pictures; a float image is converted (clamped) first.
            let src = comp.drawable.texture;
            let converted: ImageValue | null = null;
            if (src.format !== 'rgba8unorm') {
              converted = gpu.pass({ label: 'hap-convert', size: comp.drawable, textures: { src: comp.drawable }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }' });
              gpu.retain(converted.texture);
              src = converted.texture;
            }
            try {
              await (session as HapSession).addTexture(await hapGpu.compress({ texture: src }));
            } finally {
              if (converted) gpu.release(converted.texture);
            }
          } else {
            // Straight alpha for formats that keep it, the picture over black (premultiplied, alpha 255) for the rest.
            const data = await gpu.read(comp.drawable, mode === 'straight');
            if (mode !== 'straight') for (let i = 3; i < data.length; i += 4) data[i] = 255;
            await session.addFrame(data);
          }
        } finally {
          comp.release();
          gpu.release(img.texture);
        }
        await pushAudio((f + 1) / fps + 0.1);
        run.progress(((f + 1) / frames) * 0.97, `${job.label} · frame ${f + 1}/${frames}`);
        await yieldToEventLoop();
      }
      if (!session) throw new Error('No frames were rendered.');
      await pushAudio(0, true);
      run.progress(0.98, `${job.label} · finishing`);
      const parts = await session.finish();
      const mime = row.kind === 'video' ? 'video/quicktime' : row.ext === 'gif' ? 'image/gif' : 'image/png';
      const name = `${resolvePattern(p.name, this.tokens(job, outW, outH))}.${row.ext}`;
      let file: ExportedFile;
      let bytes = 0;
      if (opened) {
        const o = opened;
        const result = await o.result();
        bytes = result.bytes;
        await this.sanityCheckMov(job, run, o, frames, bytes);
        file = result.savedPath ? { name: result.name, blob: result.blob, savedPath: result.savedPath } : { name: this.claim(run, result.name), blob: result.blob };
        opened = null;
      } else {
        const blob = new Blob(parts as BlobPart[], { type: mime });
        bytes = blob.size;
        file = { name: this.claim(run, name), blob };
      }
      run.progress(1, file.savedPath ?? file.name);
      return [file];
    } catch (err) {
      if (opened) await (opened as OpenedSink).abort().catch(() => undefined);
      throw err;
    } finally {
      hapGpu?.dispose();
    }
  }

  /** Last line of defense for the files the app writes itself: read the MOV back and compare frame count and timing. Advisory; never fails the export. */
  private async sanityCheckMov(job: Job, run: Run, o: OpenedSink, frames: number, bytes: number): Promise<void> {
    if (bytes > 6e8) return; // reading a file this large back would need the memory the sink saved
    try {
      const buf = await o.readBack();
      if (!buf) return;
      const stamps = await fileTimestamps(buf);
      if (!stamps.length) {
        run.warnings.push(`${job.label}: the written file could not be read back to check it (a player may still open it).`);
        return;
      }
      if (stamps.length !== frames) run.warnings.push(`${job.label}: the video holds ${stamps.length} frames, ${frames} were rendered. Export again; if it repeats, use an image sequence.`);
      else if (isReordered(stamps)) run.warnings.push(`${job.label}: the written file stores its frames out of order.`);
    } catch {
      /* advisory */
    }
  }

  private async exportVideo(job: Job, run: Run): Promise<ExportedFile[]> {
    const { gpu } = this.d;
    const graph = run.req.graph;
    const project = graph.project;
    const frames = totalFramesOf(project);
    const fps = project.fps;
    const presenter = this.presenter(true);

    let output: Output | null = null;
    let videoSource: VideoSampleSource | null = null;
    let audioSource: AudioSampleSource | null = null;
    let pcm: PcmAudio | null = null;
    let audioPos = 0;
    const audioChunk = () => Math.max(1024, Math.round((pcm?.sampleRate ?? 48000) / 10));
    let chosen: { codec: VideoCodec; webm: boolean } | null = null;
    let outW = 0;
    let outH = 0;
    /** Whole frames added to every timestamp so the file starts at 0 (measured per browser and codec). */
    let shiftFrames = 0;

    const pushAudioUpTo = async (seconds: number, all = false) => {
      if (!pcm || !audioSource) return;
      const total = pcm.channels[0].length;
      const limit = all ? total : Math.min(total, Math.ceil(seconds * pcm.sampleRate));
      while (audioPos < limit) {
        const n = Math.min(audioChunk(), total - audioPos);
        const nch = pcm.channels.length;
        const data = new Float32Array(n * nch);
        for (let c = 0; c < nch; c++) data.set(pcm.channels[c].subarray(audioPos, audioPos + n), c * n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: nch, sampleRate: pcm.sampleRate, timestamp: audioPos / pcm.sampleRate });
        try {
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
        audioPos += n;
      }
    };

    try {
      for (let f = 0; f < frames; f++) {
        throwIfAborted(run.req.signal);
        const img = await this.renderFrame(job, run, f);
        gpu.retain(img.texture);
        const comp = this.compose(img, job.params.scale, true);
        try {
          if (!output) {
            const { width, height } = comp.drawable;
            outW = width;
            outH = height;
            const quality = new Quality({ bitrate: job.params.bitrate * 1_000_000 });
            const fallback = ffmpegFallbackCodec(job.params.codec);
            if (fallback && !(await canEncodeVideo(job.params.codec as VideoCodec, { width, height, frameRate: fps, quality }).catch(() => false)) && (await this.ffmpegReady())) throw new FfmpegFallback(fallback);
            chosen = await this.pickCodec(job.params.codec, width, height, fps, quality);
            if (chosen.codec !== job.params.codec) run.warnings.push(`${job.label}: this browser cannot encode ${String(job.params.codec).toUpperCase()}; the video was written as ${chosen.codec.toUpperCase()} instead.`);
            output = new Output({ format: chosen.webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
            // Frame order and timing are MEASURED, not assumed (see encode-order.ts): a few tiny frames go through this exact pipeline
            // first, and the export then uses settings that keep frames in order and start the file at time 0.
            const pick = await choosePipeline(chosen, { width, height, fps }, job.params.allKeys, undefined, (codec) =>
              VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: job.params.bitrate * 1_000_000, avc: { format: 'avc' } })
                .then((r) => r.supported === true)
                .catch(() => false),
            );
            shiftFrames = pick.shiftFrames;
            if (pick.note) run.warnings.push(`${job.label}: ${pick.note}`);
            videoSource = new VideoSampleSource({ codec: chosen.codec, quality, ...sourceOptions(pick.options, fps) });
            output.addVideoTrack(videoSource, { frameRate: fps });
            pcm = await this.videoAudio(job, run, frames / fps);
            if (pcm) {
              const codecs: AudioCodec[] = chosen.webm ? ['opus', 'vorbis'] : ['aac', 'opus', 'mp3'];
              const codec = await getFirstEncodableAudioCodec(codecs, { numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate }).catch(() => null);
              if (codec) {
                audioSource = new AudioSampleSource({ codec, quality: new Quality({ bitrate: 160_000 }) });
                output.addAudioTrack(audioSource);
              } else {
                run.warnings.push(`${job.label}: this browser cannot encode audio for the chosen container; exported without sound.`);
                pcm = null;
              }
            }
            await output.start();
          }
          // present() and VideoFrame creation must happen in the same task.
          const vf = await presentToFrame(presenter, comp.drawable, { timestamp: Math.round(((f + shiftFrames) / fps) * 1e6), duration: Math.round(1e6 / fps) });
          const sample = new VideoSample(vf);
          try {
            await videoSource!.add(sample);
          } finally {
            sample.close();
          }
        } finally {
          comp.release();
          gpu.release(img.texture);
        }
        await pushAudioUpTo(((f + 1) / fps) + 0.1);
        run.progress(((f + 1) / frames) * 0.97, `${job.label} · frame ${f + 1}/${frames}`);
        await yieldToEventLoop();
      }
      if (!output || !chosen) throw new Error('No frames were rendered.');
      await pushAudioUpTo(0, true);
      await output.finalize();
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) throw new Error('Video encoding produced no data.');
      // Last line of defense for every codec: look at the file that was written. Anything off is reported, never silent.
      try {
        const stamps = await fileTimestamps(buffer);
        if (stamps.length) {
          const firstFrame = Math.round(Math.min(...stamps) * fps);
          if (stamps.length !== frames) run.warnings.push(`${job.label}: the video holds ${stamps.length} frames, ${frames} were rendered. Export again; if it repeats, use VP9 or an image sequence.`);
          else if (isReordered(stamps)) run.warnings.push(`${job.label}: this video stores its frames out of order (the encoder used B-frames). Some players and VJ software stutter on such files, especially at the loop point. Turn on "All key frames" on the Output, or choose VP9 or AV1.`);
          else if (firstFrame !== 0) run.warnings.push(`${job.label}: the video starts ${Math.abs(firstFrame)} frame${Math.abs(firstFrame) === 1 ? '' : 's'} ${firstFrame < 0 ? 'early' : 'late'}, so a player may drop or hold a frame at the loop point. Choose VP9 or AV1 on the Output, or export an image sequence.`);
        }
      } catch {
        /* the check is advisory: an unreadable file is reported by the player that opens it */
      }
      output = null;
      const ext = chosen.webm ? 'webm' : 'mp4';
      const mime = chosen.webm ? 'video/webm' : 'video/mp4';
      const name = `${resolvePattern(job.params.name, this.tokens(job, outW, outH))}.${ext}`;
      run.progress(1, name);
      return [{ name: this.claim(run, name), blob: new Blob([buffer], { type: mime }) }];
    } catch (err) {
      if (output) await output.cancel().catch(() => undefined);
      throw err;
    }
  }

  private async pickCodec(requested: string, width: number, height: number, fps: number, quality: Quality): Promise<{ codec: VideoCodec; webm: boolean }> {
    const order = [...new Set([requested, 'avc', 'vp9', 'hevc', 'av1'])] as VideoCodec[];
    for (const codec of order) {
      const webm = codec === 'vp9';
      const format = webm ? new WebMOutputFormat() : new Mp4OutputFormat();
      if (!format.getSupportedVideoCodecs().includes(codec)) continue;
      if (await canEncodeVideo(codec, { width, height, frameRate: fps, quality }).catch(() => false)) return { codec, webm };
    }
    throw new Error(`This browser cannot encode ${width}x${height} video (tried H.264, VP9, H.265, AV1). Try a smaller size or use an image sequence.`);
  }

  /** Audio for an exported video: the graph's audio output, else the first video source's own sound. */
  private async videoAudio(job: Job, run: Run, duration: number): Promise<PcmAudio | null> {
    const { audio, registry, library } = this.d;
    const graph = run.req.graph;
    try {
      // Audio Outs exist but every one is switched off (or bypassed): the user asked for no sound, so no track at all.
      const audioNodes = graph.nodes.filter((n) => this.hasInput(n, 'audio') && registry.get(n.type)?.category === 'output');
      if (audioNodes.length > 0 && audioNodes.every((n) => n.bypass || n.params.enabled === false)) return null;
      if (audio.hasExportAudio(graph, registry)) {
        const rendered = await audio.renderOffline(graph, registry, (id) => library.assetAudio(id), { duration, loop: graph.project.loop, item: job.item });
        // The offline renderer works in whole blocks: cut/pad to exactly the video's duration.
        if (rendered && rendered.channels.length && rendered.channels[0].length) return fitAudio(rendered, 0, duration, false);
      }
      // A Media Timeline upstream: the first file's sound would be the wrong sound for the edit. Its sound comes through an Audio Output only.
      if (upstreamHas(graph, job.out.id, 'media-timeline')) return null;
      for (const n of this.mediaNodes(graph, job.out.id)) {
        const id = this.assetIdFor(n, job.item);
        const info = id ? library.assetInfo(id) : null;
        if (!id || info?.kind !== 'video' || !info.hasAudio) continue;
        const source = await library.assetAudio(id);
        if (!source) continue;
        const offset = typeof n.params.offset === 'number' ? n.params.offset : 0;
        const loop = n.params.loopVideo !== false;
        return fitAudio(source, offset, duration, loop);
      }
    } catch (err) {
      run.warnings.push(`${job.label}: audio could not be prepared (${errorMessage(err)}); exported without sound.`);
    }
    return null;
  }
}

/** True when a node of this type is upstream of `outId`. */
function upstreamHas(graph: GraphDoc, outId: string, type: string): boolean {
  const up = upstream(graph, outId);
  return graph.nodes.some((n) => up.has(n.id) && n.type === type);
}

async function zipFiles(files: ExportedFile[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.blob.arrayBuffer());
  // Images and video are already compressed: store them, deflate only the text.
  const data = zipSync(entries, { level: 0 });
  return new Blob([data as BlobPart], { type: 'application/zip' });
}
