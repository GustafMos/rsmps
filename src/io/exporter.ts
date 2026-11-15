/**
 * Exporter: renders output nodes at final quality and encodes them.
 *
 * Every pixel path stays on the GPU: evaluation -> optional nearest upscale pass -> WebGPU
 * OffscreenCanvas -> convertToBlob (images) or VideoFrame -> mediabunny (video). Spritesheets are
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
import { conformImage, enlargeNearest } from './frame-gpu';
import { effectiveConform, isCustomFrame, pixelPlan, readFrameParams, resolveFrame } from './frame';
import { encodeWav } from './wav';
import { OffscreenPresenter, frameFromCanvas, presentToBlob } from './encode';
import { GpuWatch, scopeMessage } from './gpu-watch';
import type { EvalResult } from '../engine/engine';
import { SILENT_TRACKS, type SignalRouter } from './signals';
import type { EvalGate } from './gate';
import type { Library } from './library';
import { imageExtension, resolvePattern, sanitizeFileName, sequencePattern, uniqueName, type NameTokens } from './naming';
import { exportPrint, readPrintParams, type PrintParams } from './print/export';
import { layoutSheet, sheetMetadata } from './spritesheet';
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
}

type Img = ImageValue | MaskValue;
type Kind = 'image' | 'sequence' | 'video' | 'spritesheet' | 'print';

interface OutParams {
  name: string;
  kind: 'auto' | Kind;
  imageFormat: 'png' | 'webp' | 'jpeg';
  quality: number;
  codec: string;
  bitrate: number;
  scale: number;
  columns: number;
  padding: number;
  pixelSize: number;
  exportArtSize: boolean;
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

const MIME: Record<OutParams['imageFormat'], string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' };

export class ExporterImpl implements Exporter {
  private presenters = new Map<boolean, OffscreenPresenter>();

  constructor(private d: ExporterDeps) {}

  /* -------------------------------------------------------------------------------------------- */

  async run(req: ExportRequest): Promise<ExportedFile[]> {
    // Video frames must be frame-exact while exporting (the browser-player fallback may not use real-time playback).
    this.d.library.exact = true;
    const unhold = this.d.player?.hold(); // no player evaluations between export frames
    this.d.watch?.take();
    // An export touches every frame once: the engine / frame caches are not worth hundreds of MB then, and the memory is what keeps
    // large frames (1080x1920 with 20+ intermediate textures) from running the GPU out of memory.
    const engineBudget = this.d.gate.setCacheBudget(EXPORT_ENGINE_CACHE);
    const mediaBudget = this.d.library.setFrameBudget(EXPORT_MEDIA_CACHE);
    await this.d.gate.exclusive(() => this.d.gpu.trim()); // never while an evaluation is mid-render
    try {
      return await this.runExact(req);
    } finally {
      this.d.gate.setCacheBudget(engineBudget);
      this.d.library.setFrameBudget(mediaBudget);
      await this.d.gate.exclusive(() => this.d.gpu.trim());
      this.d.library.exact = false;
      this.releaseConformed();
      unhold?.();
    }
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
        const sourceName = this.sourceName(graph, out.id, item) ?? graph.name ?? 'output';
        const upstreamVideo = this.firstAssetOfKind(graph, out.id, item, 'video') !== null;
        let weight = 1;
        if (params.kind === 'sequence' || params.kind === 'video' || params.kind === 'spritesheet') weight = frames;
        else if (params.kind === 'print') weight = Math.max(1, Math.ceil(frames / params.print.step));
        else if (params.kind === 'auto') weight = upstreamVideo ? frames : 1;
        jobs.push({ out, params, item, itemCount, sourceName, weight, label: `${out.label || sanitizeFileName(sourceName)}${itemCount > 1 ? ` #${item + 1}` : ''}` });
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
    const sigs = this.d.router && this.d.audio.hasSignals(graph, registry) ? this.d.router : null;
    let sigItem = -1;
    try {
    for (current = 0; current < jobs.length; current++) {
      const job = jobs[current];
      throwIfAborted(req.signal);
      run.progress(0, job.label);
      if (sigs && job.item !== sigItem) {
        sigItem = job.item;
        await this.prepareSignals(sigs, run, frames);
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
    if (req.zip && files.length > 1) {
      return [{ name: `${sanitizeFileName(graph.name || 'export')}.zip`, blob: await zipFiles(files) }];
    }
    return files;
  }

  /**
   * Deterministic bridge values for one batch item: analyse the audio offline once, route Host.signal to the
   * per-frame tracks and drop engine results cached with other (live or previous-item) values.
   */
  private async prepareSignals(router: SignalRouter, run: Run, frames: number): Promise<void> {
    const { audio, registry, library } = this.d;
    const graph = run.req.graph;
    const fps = graph.project.fps;
    router.beginExport(SILENT_TRACKS(fps)); // from now on no live value can leak in
    try {
      const tracks = await audio.analyzeSignals(graph, registry, (id) => library.assetAudio(id), { duration: frames / fps, fps, loop: graph.project.loop });
      if (tracks) router.beginExport(tracks);
      else run.warnings.push('Sound analysis is unavailable; sound-driven values export as 0.');
    } catch (err) {
      run.warnings.push(`Sound analysis failed (${errorMessage(err)}); sound-driven values export as 0.`);
    }
    await this.d.gate.clearEngine();
  }

  download(files: ExportedFile[]): void {
    files.forEach((file, i) => {
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
      imageFormat: oneOf(p.imageFormat, ['png', 'webp', 'jpeg'] as const, 'png'),
      quality: Math.min(1, Math.max(0.1, num(p.quality, 0.92))),
      codec: typeof p.codec === 'string' ? p.codec : 'avc',
      bitrate: Math.max(0.5, num(p.bitrate, 12)),
      scale: Math.max(1, Math.round(num(p.scale, 1))),
      pixelSize: readFrameParams(p).pixelSize,
      exportArtSize: p.exportArtSize === true,
      columns: Math.max(0, Math.round(num(p.columns, 0))),
      padding: Math.max(0, Math.round(num(p.padding, 0))),
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

  /** Sound-only export: everything the enabled Audio Outs play, as one file. */
  private async exportAudio(job: Job, run: Run): Promise<ExportedFile[]> {
    const { audio, registry, library } = this.d;
    const graph = run.req.graph;
    const duration = totalFramesOf(graph.project) / graph.project.fps;
    const rendered = await audio.renderOffline(graph, registry, (id) => library.assetAudio(id), { duration, loop: graph.project.loop });
    if (!rendered || !rendered.channels.length || !rendered.channels[0].length) throw new Error('There is no enabled Audio Out with sound wired to it.');
    const pcm = fitAudio(rendered, 0, duration, false);
    const base = sanitizeFileName(graph.name || 'audio');
    const format = run.req.audioFormat ?? 'wav';
    run.progress(0.5, `${base}`);
    if (format !== 'wav') {
      const blob = await this.encodeCompressedAudio(pcm, format).catch(() => null);
      if (blob) return [{ name: this.claim(run, `${base}.${format}`), blob }];
      run.warnings.push(`This browser cannot encode ${format === 'm4a' ? 'AAC' : 'Opus'} audio; exported WAV instead.`);
    }
    run.progress(1, `${base}.wav`);
    return [{ name: this.claim(run, `${base}.wav`), blob: new Blob([encodeWav(pcm, 32) as BlobPart], { type: 'audio/wav' }) }];
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
        return this.exportVideo(job, run);
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
      const out = gpu.scoped(() => {
        const conformed = conformImage(gpu, img, fp.pixelSize > 1 ? art : target, effectiveConform(fp), fp.conformAnchor);
        const final = job.artMode ? conformed : enlargeNearest(gpu, conformed, fp.pixelSize);
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
  private compose(img: Img, scale: number, even: boolean): Composed {
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

  private async encodeImage(img: Img, p: OutParams): Promise<Blob> {
    const { gpu } = this.d;
    gpu.retain(img.texture);
    const comp = this.compose(img, p.scale, false);
    try {
      const mime = MIME[p.imageFormat];
      // present() and convertToBlob() must run in the same task: no await between them.
      return await presentToBlob(this.presenter(p.imageFormat === 'jpeg'), comp.drawable, mime, p.imageFormat === 'png' ? undefined : p.quality);
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
    const img = await this.renderFrame(job, run, 0);
    const blob = await this.encodeImage(img, job.params);
    const w = img.width * job.params.scale;
    const h = img.height * job.params.scale;
    const name = `${resolvePattern(job.params.name, this.tokens(job, w, h))}.${imageExtension(blob.type)}`;
    run.progress(1, name);
    return [{ name: this.claim(run, name), blob }];
  }

  private async exportSequence(job: Job, run: Run): Promise<ExportedFile[]> {
    job.artMode = job.params.exportArtSize;
    const graph = run.req.graph;
    const frames = totalFramesOf(graph.project);
    const pattern = sequencePattern(job.params.name);
    const files: ExportedFile[] = [];
    for (let f = 0; f < frames; f++) {
      throwIfAborted(run.req.signal);
      const img = await this.renderFrame(job, run, f);
      const blob = await this.encodeImage(img, job.params);
      const name = `${resolvePattern(pattern, this.tokens(job, img.width * job.params.scale, img.height * job.params.scale, f, frames))}.${imageExtension(blob.type)}`;
      files.push({ name: this.claim(run, name), blob });
      run.progress((f + 1) / frames, `${name} · frame ${f + 1}/${frames}`);
      await yieldToEventLoop();
    }
    return files;
  }

  /* ------------------------------------- spritesheet -------------------------------------------- */

  private async exportSheet(job: Job, run: Run): Promise<ExportedFile[]> {
    job.artMode = job.params.exportArtSize;
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
              throw new Error(`The spritesheet would be ${layout.width}x${layout.height}, larger than this GPU supports (${maxDim}). Use fewer frames, a smaller size or more columns.`);
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
      const jsonName = this.claim(run, `${base}.json`);
      const meta = sheetMetadata(layout, imageName, project.fps, project.loop);
      run.progress(1, imageName);
      return [
        { name: imageName, blob: png },
        { name: jsonName, blob: new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }) },
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
            chosen = await this.pickCodec(job.params.codec, width, height, fps, quality);
            output = new Output({ format: chosen.webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
            videoSource = new VideoSampleSource({ codec: chosen.codec, quality });
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
          const canvas = presenter.present(comp.drawable);
          const vf = frameFromCanvas(canvas, { timestamp: Math.round((f / fps) * 1e6), duration: Math.round(1e6 / fps) });
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
        const rendered = await audio.renderOffline(graph, registry, (id) => library.assetAudio(id), { duration, loop: graph.project.loop });
        // The offline renderer works in whole blocks: cut/pad to exactly the video's duration.
        if (rendered && rendered.channels.length && rendered.channels[0].length) return fitAudio(rendered, 0, duration, false);
      }
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

async function zipFiles(files: ExportedFile[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.blob.arrayBuffer());
  // Images and video are already compressed: store them, deflate only the text.
  const data = zipSync(entries, { level: 0 });
  return new Blob([data as BlobPart], { type: 'application/zip' });
}
