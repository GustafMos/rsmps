/**
 * Browser glue for scan-back: decodes photos, runs the pure pipeline in src/io/print, builds object URLs for
 * the UI and creates the image-sequence asset. All geometry and detection lives in src/io/print/scan.
 */
import type {
  BlankPlanInfo,
  MediaLibrary,
  NextRoundInput,
  PrintBlankOptions,
  ScanAnalyzeOptions,
  TextureOptions,
  TexturePreview,
  ScanApi,
  ScanCommitOptions,
  ScanFrame,
  ScanManualInput,
  ScanProgressHooks,
  ScanResult,
  ScanSession,
} from './api';
import type { AssetInfo } from '../engine/types';
import type { ExportedFile } from './api';
import { exportBlankSheets, exportNextRound, planBlankSheets } from './print/blank';
import { beatFrames, detectBeats } from './print/beats';
import { resolveHolds } from './print/holds';
import { cropTexture, defaultQuad, makeSeamless } from './print/texture';
import { encodePng } from './print/png';
import { createRaster, type RasterImage } from './print/raster';
import { extractDrawing, keepOnlyDrawing } from './print/scan/clean';
import { scanBatch } from './print/scan/batch';
import { decodeToRaster, estimateDecodedPixels } from './print/scan/decode';
import { runScanJob, type ScanJobReply, type ScanJobRequest } from './print/scan/job';
import { scanPage, type PageScan } from './print/scan/page';
import { assembleScan } from './print/scan/pipeline';
import {
  FALLBACK_BUDGET_BYTES,
  PoolAbortError,
  PoolJobError,
  PoolUnavailableError,
  ScanPool,
  UNKNOWN_PIXELS,
  concurrencyFor,
  defaultWorkerCount,
  estimateJobBytes,
  type PoolWorker,
} from './print/scan/pool';
import { errorMessage, yieldToEventLoop } from './util';

const MAX_PHOTO_SIDE = 5000;
const PHOTO_PREVIEW_SIDE = 1024;

async function rasterToJpeg(img: RasterImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

function pngBlob(img: RasterImage, opaque: boolean): Blob {
  return new Blob([encodePng(img, { opaque, level: 3 }) as BlobPart], { type: 'image/png' });
}

/**
 * Runs scan jobs: on a pool of reusable Web Workers (parallel; photos decoded and scanned off the UI thread; results moved
 * back as transferables), or, where workers do not exist or cannot be created, one at a time on the main thread with a yield
 * between photos. The choice is made per call, so a pool that fails to start simply hands every job to the main-thread path.
 */
class ScanRunner {
  private pool: ScanPool | null | undefined;
  private mainQueue: Promise<unknown> = Promise.resolve();

  constructor(private budget: () => number) {}

  private getPool(): ScanPool | null {
    if (this.pool !== undefined) return this.pool;
    try {
      if (typeof Worker === 'undefined') throw new Error('no workers');
      this.pool = new ScanPool({
        createWorker: () => new Worker(new URL('./print/scan/scan.worker.ts', import.meta.url), { type: 'module' }) as unknown as PoolWorker,
        maxWorkers: defaultWorkerCount(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined),
        memoryBudget: this.budget,
      });
    } catch {
      this.pool = null;
    }
    return this.pool;
  }

  /** How many of these jobs will certainly run at the same time. */
  concurrency(costs: number[]): number {
    const pool = this.getPool();
    if (!pool || pool.stats.unavailable) return 1;
    return concurrencyFor(costs, pool.stats.limit, this.budget());
  }

  async run(req: ScanJobRequest, cost: number, started: () => void, signal?: AbortSignal): Promise<ScanJobReply> {
    const pool = this.getPool();
    if (pool && !pool.stats.unavailable) {
      try {
        return await this.viaPool(pool, req, cost, started, signal);
      } catch (err) {
        if (!(err instanceof PoolUnavailableError)) throw err;
      }
    }
    return this.onMainThread(req, started, signal);
  }

  private async viaPool(pool: ScanPool, req: ScanJobRequest, cost: number, started: () => void, signal?: AbortSignal): Promise<ScanJobReply> {
    const send = (r: ScanJobRequest) =>
      pool.submit<ScanJobReply>({
        message: r as unknown as Record<string, unknown>,
        transfer: r.source.kind === 'raster' ? [r.source.image.data.buffer as ArrayBuffer] : [],
        cost,
        signal,
        onStart: started,
      });
    try {
      return await send(req);
    } catch (err) {
      // a worker that cannot decode (no createImageBitmap / OffscreenCanvas there): decode here and send the pixels
      if (err instanceof PoolJobError && err.code === 'no-decode' && req.source.kind === 'file') {
        const image = await decodeToRaster(req.source.blob, req.source.maxSide);
        return send({ ...req, source: { kind: 'raster', image } });
      }
      throw err;
    }
  }

  private onMainThread(req: ScanJobRequest, started: () => void, signal?: AbortSignal): Promise<ScanJobReply> {
    const run = this.mainQueue.then(async () => {
      if (signal?.aborted) throw new PoolAbortError();
      started();
      await yieldToEventLoop();
      return runScanJob(req);
    });
    this.mainQueue = run.catch(() => undefined);
    return run;
  }
}

/** The page of a photo whose job broke: the usual failed page, with the error as its message. */
function failedPage(name: string, index: number, message: string): PageScan {
  const page = scanPage(createRaster(8, 8), name, index);
  page.report.warnings = [message];
  return page;
}

interface Session {
  files: File[];
  names: string[];
  /** Small copies of the photos for the page cards (null where decoding failed). */
  previews: (RasterImage | null)[];
  scans: (PageScan | null)[];
  manual: Map<number, ScanManualInput>;
  options: ScanAnalyzeOptions;
}

export interface ScanImplOptions {
  /** Bytes the parallel scans may use together (the memory governor's RAM budget). Default 1.5 GB. */
  memoryBudget?: () => number;
}

export class ScanImpl implements ScanApi {
  private runner: ScanRunner;
  /** The session behind each result, so `append` can keep the scanned pages. */
  private sessions = new WeakMap<ScanResult, Session>();

  constructor(private library: MediaLibrary, opts: ScanImplOptions = {}) {
    const budget = opts.memoryBudget;
    this.runner = new ScanRunner(() => (budget ? budget() : FALLBACK_BUDGET_BYTES));
  }

  async analyze(files: File[], options: ScanAnalyzeOptions = {}, hooks: ScanProgressHooks = {}): Promise<ScanResult> {
    if (files.length === 0) throw new Error('Choose at least one photo or scan.');
    const session: Session = { files, names: files.map((f) => f.name), previews: [], scans: [], manual: new Map(), options };
    return this.scanInto(session, 0, hooks);
  }

  /** Add photos to a result: only the new ones go through the pool; earlier pages keep their scans and previews. */
  async append(result: ScanResult, files: File[], options: ScanAnalyzeOptions = {}, hooks: ScanProgressHooks = {}): Promise<ScanResult> {
    const old = this.sessions.get(result);
    if (!old) throw new Error('This scan result cannot be extended. Add the photos again from the list.');
    if (files.length === 0) return result;
    const session: Session = {
      files: [...old.files, ...files],
      names: [...old.names, ...files.map((f) => f.name)],
      previews: [...old.previews],
      scans: [...old.scans],
      manual: new Map(old.manual),
      options: { ...old.options, ...options },
    };
    return this.scanInto(session, old.files.length, hooks);
  }

  /** Scan the photos of `session` from list position `from` on (the earlier ones already have results) and build the result. */
  private async scanInto(session: Session, from: number, hooks: ScanProgressHooks): Promise<ScanResult> {
    const files = session.files.slice(from);
    const failures: string[] = [];
    // Memory planning needs each photo's size before anything is queued; it is read from the file header (no decoding).
    const costs = await Promise.all(files.map(async (f) => estimateJobBytes((await estimateDecodedPixels(f, MAX_PHOTO_SIDE)) ?? UNKNOWN_PIXELS)));
    const outcomes = await scanBatch<ScanJobReply>({
      names: session.names.slice(from),
      concurrency: this.runner.concurrency(costs),
      onProgress: hooks.onProgress,
      signal: hooks.signal,
      run: (i, started) => this.runner.run(this.request(session, from + i), costs[i], started, hooks.signal),
    });
    // Results go to their list position whatever order the photos finished in, so assembly and report order never depend on timing.
    outcomes.forEach((o, k) => {
      const i = from + k;
      if (o.ok) {
        session.scans[i] = o.value.result;
        session.previews[i] = o.value.preview;
        if (o.value.decodeError) failures.push(`${session.names[i]}: ${o.value.decodeError}`);
      } else {
        session.scans[i] = failedPage(session.names[i], i, `The scan of this photo failed: ${o.error.message}`);
        session.previews[i] = null;
      }
    });
    const result = await this.build(session);
    for (const msg of failures) result.report.warnings.push(msg);
    return result;
  }

  async reanalyzePage(result: ScanResult, pageIndex: number, manual: ScanManualInput): Promise<ScanResult> {
    return result.reanalyzePage(pageIndex, manual);
  }

  private request(session: Session, i: number): ScanJobRequest {
    return {
      source: { kind: 'file', blob: session.files[i], maxSide: MAX_PHOTO_SIDE },
      name: session.names[i],
      index: i,
      previewSide: PHOTO_PREVIEW_SIDE,
      options: {
        manual: session.manual.get(i),
        outputWidth: session.options.outputWidth,
        outputHeight: session.options.outputHeight,
        flatten: session.options.flatten,
      },
    };
  }

  /** One photo again (a manual fix): same worker path and decoding, just alone. */
  private async scanOne(session: Session, i: number): Promise<PageScan> {
    const cost = estimateJobBytes((await estimateDecodedPixels(session.files[i], MAX_PHOTO_SIDE)) ?? UNKNOWN_PIXELS);
    try {
      return (await this.runner.run(this.request(session, i), cost, () => undefined)).result;
    } catch (err) {
      return failedPage(session.names[i], i, `The scan of this photo failed: ${errorMessage(err)}`);
    }
  }

  private async build(session: Session): Promise<ScanResult> {
    const assembled = assembleScan(session.scans as PageScan[]);
    const urls: string[] = [];
    const url = (blob: Blob): string => {
      const u = URL.createObjectURL(blob);
      urls.push(u);
      return u;
    };
    for (let i = 0; i < assembled.pages.length; i++) {
      const page = assembled.pages[i];
      const report = assembled.report.pages[i];
      await yieldToEventLoop();
      try {
        const preview = session.previews[i];
        // the worker already cut the preview down to PHOTO_PREVIEW_SIDE; the scale is the same ratio as before
        const k = Math.min(1, PHOTO_PREVIEW_SIDE / Math.max(1, report.photoWidth, report.photoHeight));
        if (preview) {
          report.photoUrl = url(await rasterToJpeg(preview));
          report.photoScale = k;
        }
        if (page.rectified) {
          report.thumbnailUrl = url(pngBlob(page.rectified, true));
          report.thumbnailKind = 'rectified';
        } else {
          report.thumbnailUrl = report.photoUrl;
          report.thumbnailKind = 'photo';
        }
      } catch (err) {
        report.warnings.push(`No preview could be made: ${errorMessage(err)}`);
      }
    }
    const frames: (ScanFrame | null)[] = assembled.frames.map((f, index) =>
      f ? { index, width: f.width, height: f.height, data: f.data instanceof Uint8ClampedArray ? f.data : new Uint8ClampedArray(f.data) } : null,
    );
    const frameUrls = frames.map((f) => (f ? url(pngBlob({ width: f.width, height: f.height, data: f.data }, true)) : null));
    const layerFrames: (ScanFrame | null)[][] | undefined =
      assembled.layers.length > 1
        ? assembled.layers.map((l, li) => (li === 0 ? frames : l.map((f, index) => (f ? { index, width: f.width, height: f.height, data: f.data instanceof Uint8ClampedArray ? f.data : new Uint8ClampedArray(f.data) } : null))))
        : undefined;
    const self = this;
    let disposed = false;
    const built: ScanResult = {
      report: assembled.report,
      frames,
      layerFrames,
      frameUrls,
      async reanalyzePage(pageIndex: number, manual: ScanManualInput): Promise<ScanResult> {
        if (pageIndex < 0 || pageIndex >= session.files.length) throw new Error(`There is no page ${pageIndex}.`);
        const next: Session = { ...session, scans: [...session.scans], manual: new Map(session.manual) };
        next.manual.set(pageIndex, manual);
        next.scans[pageIndex] = await self.scanOne(next, pageIndex);
        // Pages without a manual page index take their order in the list when nothing else says so.
        return self.build(next);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const u of urls) URL.revokeObjectURL(u);
      },
    };
    this.sessions.set(built, session);
    return built;
  }

  async restore(session: ScanSession, hooks?: ScanProgressHooks): Promise<ScanResult> {
    const files = session.photos.map((p) => new File([p.blob], p.name, { type: p.blob.type }));
    let result = await this.analyze(files, session.options.analyze ?? {}, hooks);
    const indices = Object.keys(session.manual).map(Number).sort((a, b) => a - b);
    for (const i of indices) {
      if (i < 0 || i >= files.length) continue;
      const next = await result.reanalyzePage(i, session.manual[i]);
      result.dispose();
      result = next;
    }
    return result;
  }

  async attach(projectId: string, result: ScanResult, o: ScanCommitOptions): Promise<AssetInfo> {
    const { blobs, fps } = await this.buildSequence(result, o);
    const layout = result.report.pages.find((p) => p.used && p.layout)?.layout;
    // the clean-up graph reads these to add the right nodes (Remove Printed Guide, one source per paper layer)
    const meta: Record<string, unknown> = { layer: o.layer ?? 0, layerCount: result.report.layerCount ?? 1 };
    if (layout) meta.printGuide = { mode: layout.guide, opacity: layout.guideOpacity, blue: !!layout.blueGuide };
    return this.library.attachSequence(projectId, o.name.trim() || 'Scan frames', blobs, fps, meta);
  }

  async commit(result: ScanResult, o: ScanCommitOptions): Promise<AssetInfo> {
    const { blobs, fps } = await this.buildSequence(result, o);
    return this.library.addSequence(o.name.trim() || 'Scanned animation', blobs, fps);
  }

  private async buildSequence(result: ScanResult, o: ScanCommitOptions): Promise<{ blobs: Blob[]; fps: number }> {
    const missing = o.missing ?? 'repeat';
    const layout = result.report.pages.find((p) => p.used && p.layout)?.layout;
    const fps = o.fps ?? (result.report.fps > 0 ? result.report.fps : 12);
    const originals: RasterImage[] = [];
    if (o.removeGuide && o.originals?.length) for (const b of o.originals) originals.push(await decodeToRaster(b));

    const source = (o.layer ?? 0) > 0 && result.layerFrames?.[o.layer!] ? result.layerFrames[o.layer!] : result.frames;
    const rasters: (RasterImage | null)[] = source.map((f) => (f ? { width: f.width, height: f.height, data: new Uint8ClampedArray(f.data) } : null));
    const hold = resolveHolds(rasters.length, { shootOn: o.shootOn, holds: o.holds });
    const blobsOut: Blob[] = [];
    const known = rasters.find((r) => r !== null);
    if (!known) throw new Error('No frames were recovered, so there is nothing to add.');
    let last: RasterImage | null = null;
    const emit = (img: RasterImage, times: number) => {
      const blob = pngBlob(img, !o.drawingOnly);
      for (let k = 0; k < times; k++) blobsOut.push(blob);
    };
    for (let i = 0; i < rasters.length; i++) {
      let r = rasters[i];
      if (r) {
        if ((o.removeGuide || o.keepOnlyDrawing) && layout && layout.guide !== 'full' && layout.guide !== 'blank') keepOnlyDrawing(r, { mode: layout.guide, opacityPercent: layout.guideOpacity, blue: !!layout.blueGuide, original: originals[i] ?? null });
        else if (o.removeGuide && originals[i] && layout) keepOnlyDrawing(r, { mode: layout.guide, opacityPercent: layout.guideOpacity, blue: false, original: originals[i] });
        if (o.drawingOnly) r = extractDrawing(r, { threshold: o.threshold, softness: o.softness });
        last = r;
        emit(r, hold[i]);
        continue;
      }
      if (missing === 'skip') continue;
      if (missing === 'repeat') {
        const next = rasters.slice(i + 1).find((x) => x !== null) ?? null;
        const src = last ?? (next ? (o.drawingOnly ? extractDrawing(next, { threshold: o.threshold, softness: o.softness }) : next) : known);
        emit(src, hold[i]);
      } else {
        emit(createRaster(known.width, known.height, o.drawingOnly ? [0, 0, 0, 0] : [255, 255, 255, 255]), hold[i]);
      }
      await yieldToEventLoop();
    }
    return { blobs: blobsOut, fps };
  }

  /* ---------------------------- blank sheets, rounds, textures ---------------------------- */

  planBlank(options: PrintBlankOptions): BlankPlanInfo {
    const p = planBlankSheets(options);
    const g = p.sheet.geometry;
    return { frames: p.frames, columns: p.columns, rows: p.rows, perSheet: p.perSheet, pages: p.pages, cellWidthMm: g.cellWMm, cellHeightMm: g.cellHMm, gutterMm: g.gutterMm };
  }

  async printBlank(options: PrintBlankOptions, progress?: (fraction: number, label: string) => void): Promise<ExportedFile[]> {
    return exportBlankSheets(options, { progress, yieldNow: yieldToEventLoop });
  }

  async beatsFromAsset(assetId: string, fps: number): Promise<number[]> {
    const pcm = await this.library.assetAudio?.(assetId);
    if (!pcm) throw new Error('That audio could not be decoded.');
    await yieldToEventLoop();
    return beatFrames(detectBeats(pcm.channels, pcm.sampleRate), fps);
  }

  async printNextRound(result: ScanResult, options: NextRoundInput, progress?: (fraction: number, label: string) => void): Promise<ExportedFile[]> {
    const layer = options.layer ?? 0;
    const source = layer > 0 && result.layerFrames?.[layer] ? result.layerFrames[layer] : result.frames;
    const previous: (RasterImage | null)[] = source.map((f) => (f ? { width: f.width, height: f.height, data: f.data } : null));
    if (!previous.some((f) => f)) throw new Error('There are no scanned drawings yet to continue from.');
    const id = parseInt(result.report.projectId ?? '0', 16) >>> 0;
    const rounds = result.report.rounds ?? 0;
    return exportNextRound({ ...options, previous, projectId: id, round: rounds, frames: options.frames, name: options.name }, { progress, yieldNow: yieldToEventLoop });
  }

  async makeTexture(photo: File, options: TextureOptions = {}): Promise<TexturePreview> {
    const img = await decodeToRaster(photo, MAX_PHOTO_SIDE);
    const quad = options.quad ?? defaultQuad(img.width, img.height, 0);
    let tex = cropTexture(img, quad, { maxSide: options.maxSide ?? 2048 });
    if (options.seamless) tex = makeSeamless(tex, options.seamlessStrength ?? 1);
    const blob = pngBlob(tex, true);
    const url = URL.createObjectURL(blob);
    return { blob, width: tex.width, height: tex.height, url, dispose: () => URL.revokeObjectURL(url) };
  }
}
