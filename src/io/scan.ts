/**
 * Browser glue for scan-back: decodes photos, runs the pure pipeline in src/io/print, builds object URLs for
 * the UI and creates the image-sequence asset. All geometry and detection lives in src/io/print/scan.
 */
import type {
  MediaLibrary,
  ScanAnalyzeOptions,
  ScanApi,
  ScanCommitOptions,
  ScanFrame,
  ScanManualInput,
  ScanResult,
  ScanSession,
} from './api';
import type { AssetInfo } from '../engine/types';
import { encodePng } from './print/png';
import { createRaster, resizeRaster, type RasterImage } from './print/raster';
import { extractDrawing, removeGuide } from './print/scan/clean';
import { scanPage, type PageScan } from './print/scan/page';
import { assembleScan } from './print/scan/pipeline';
import { errorMessage, yieldToEventLoop } from './util';

const MAX_PHOTO_SIDE = 5000;
const PHOTO_PREVIEW_SIDE = 1024;

async function decodeToRaster(blob: Blob, maxSide = 0): Promise<RasterImage> {
  // EXIF orientation is applied ('from-image' is the default; stated so the pipeline never sees a sideways photo).
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (maxSide > 0 && long > maxSide) {
      const k = maxSide / long;
      const resized = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = resized;
    }
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: d.width, height: d.height, data: d.data };
  } finally {
    bmp.close();
  }
}

async function rasterToJpeg(img: RasterImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

function pngBlob(img: RasterImage, opaque: boolean): Blob {
  return new Blob([encodePng(img, { opaque, level: 3 }) as BlobPart], { type: 'image/png' });
}

interface Session {
  images: RasterImage[];
  names: string[];
  scans: (PageScan | null)[];
  manual: Map<number, ScanManualInput>;
  options: ScanAnalyzeOptions;
}

export class ScanImpl implements ScanApi {
  constructor(private library: MediaLibrary) {}

  async analyze(files: File[], options: ScanAnalyzeOptions = {}): Promise<ScanResult> {
    if (files.length === 0) throw new Error('Choose at least one photo or scan.');
    const session: Session = { images: [], names: [], scans: [], manual: new Map(), options };
    const failures: string[] = [];
    for (const file of files) {
      try {
        session.images.push(await decodeToRaster(file, MAX_PHOTO_SIDE));
        session.names.push(file.name);
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`);
        session.images.push(createRaster(8, 8));
        session.names.push(file.name);
      }
    }
    for (let i = 0; i < session.images.length; i++) {
      session.scans.push(null);
      await yieldToEventLoop();
      session.scans[i] = this.scanOne(session, i);
    }
    const result = await this.build(session);
    for (const msg of failures) result.report.warnings.push(msg);
    return result;
  }

  async reanalyzePage(result: ScanResult, pageIndex: number, manual: ScanManualInput): Promise<ScanResult> {
    return result.reanalyzePage(pageIndex, manual);
  }

  private scanOne(session: Session, i: number): PageScan {
    return scanPage(session.images[i], session.names[i], i, {
      manual: session.manual.get(i),
      outputWidth: session.options.outputWidth,
      outputHeight: session.options.outputHeight,
      flatten: session.options.flatten,
    });
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
        const photo = session.images[i];
        const k = Math.min(1, PHOTO_PREVIEW_SIDE / Math.max(photo.width, photo.height));
        const preview = k < 1 ? resizeRaster(photo, Math.max(1, Math.round(photo.width * k)), Math.max(1, Math.round(photo.height * k)), 'area') : photo;
        report.photoUrl = url(await rasterToJpeg(preview));
        report.photoScale = k;
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
    const self = this;
    let disposed = false;
    return {
      report: assembled.report,
      frames,
      frameUrls,
      async reanalyzePage(pageIndex: number, manual: ScanManualInput): Promise<ScanResult> {
        if (pageIndex < 0 || pageIndex >= session.images.length) throw new Error(`There is no page ${pageIndex}.`);
        const next: Session = { ...session, scans: [...session.scans], manual: new Map(session.manual) };
        next.manual.set(pageIndex, manual);
        next.scans[pageIndex] = self.scanOne(next, pageIndex);
        // Pages without a manual page index take their order in the list when nothing else says so.
        return self.build(next);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const u of urls) URL.revokeObjectURL(u);
      },
    };
  }

  async restore(session: ScanSession): Promise<ScanResult> {
    const files = session.photos.map((p) => new File([p.blob], p.name, { type: p.blob.type }));
    let result = await this.analyze(files, session.options.analyze ?? {});
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
    return this.library.attachSequence(projectId, o.name.trim() || 'Scan frames', blobs, fps);
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

    const rasters: (RasterImage | null)[] = result.frames.map((f) => (f ? { width: f.width, height: f.height, data: new Uint8ClampedArray(f.data) } : null));
    const known = rasters.find((r) => r !== null);
    if (!known) throw new Error('No frames were recovered, so there is nothing to add.');
    const out: RasterImage[] = [];
    let last: RasterImage | null = null;
    for (let i = 0; i < rasters.length; i++) {
      let r = rasters[i];
      if (r) {
        if (o.removeGuide && originals[i] && layout) removeGuide(r, originals[i], layout.guide, layout.guideOpacity);
        if (o.drawingOnly) r = extractDrawing(r, { threshold: o.threshold, softness: o.softness });
        last = r;
        out.push(r);
        continue;
      }
      if (missing === 'skip') continue;
      if (missing === 'repeat') {
        const next = rasters.slice(i + 1).find((x) => x !== null) ?? null;
        const src = last ?? (next ? (o.drawingOnly ? extractDrawing(next, { threshold: o.threshold, softness: o.softness }) : next) : known);
        out.push(src);
      } else {
        out.push(createRaster(known.width, known.height, o.drawingOnly ? [0, 0, 0, 0] : [255, 255, 255, 255]));
      }
      await yieldToEventLoop();
    }
    return { blobs: out.map((r) => pngBlob(r, !o.drawingOnly)), fps };
  }
}
