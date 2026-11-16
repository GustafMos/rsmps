/**
 * One scan job as the worker (or, without workers, the main thread) runs it: decode the photo if it arrives encoded, scan the
 * page, make the small preview. Free of Worker APIs, so the worker file is only message plumbing and this runs in unit tests.
 */
import { createRaster, resizeRaster, type RasterImage } from '../raster';
import { canDecodeHere, decodeToRaster } from './decode';
import { scanPage, type PageScan, type PageScanOptions } from './page';

export type ScanJobSource =
  /** The encoded file (a Blob is shared with the worker, not copied); decoded where the job runs. */
  | { kind: 'file'; blob: Blob; maxSide: number }
  /** An already decoded photo (main-thread decode when the worker cannot decode). Its buffer is transferred. */
  | { kind: 'raster'; image: RasterImage };

export interface ScanJobRequest {
  source: ScanJobSource;
  name: string;
  index: number;
  options: PageScanOptions;
  /** Longest side of the preview raster returned for the page cards. */
  previewSide: number;
}

export interface ScanJobReply {
  result: PageScan;
  /** Size of the decoded photo (0 when decoding failed). */
  photoWidth: number;
  photoHeight: number;
  /** Downscaled photo for the thumbnail, null when the photo could not be decoded. */
  preview: RasterImage | null;
  /** Why decoding failed, when it did. `result` is then the usual "too small" failed page. */
  decodeError?: string;
}

/** The realm cannot decode images; the caller decodes on the main thread and resubmits a `raster` source. */
export class DecodeUnavailableError extends Error {
  readonly code = 'no-decode';
  constructor() {
    super('This worker cannot decode images.');
    this.name = 'DecodeUnavailableError';
  }
}

export function previewOf(photo: RasterImage, side: number): RasterImage {
  const k = Math.min(1, side / Math.max(photo.width, photo.height));
  return k < 1 ? resizeRaster(photo, Math.max(1, Math.round(photo.width * k)), Math.max(1, Math.round(photo.height * k)), 'area') : photo;
}

export async function runScanJob(req: ScanJobRequest): Promise<ScanJobReply> {
  let photo: RasterImage;
  if (req.source.kind === 'raster') photo = req.source.image;
  else {
    if (!canDecodeHere()) throw new DecodeUnavailableError();
    try {
      photo = await decodeToRaster(req.source.blob, req.source.maxSide);
    } catch (err) {
      const stub = createRaster(8, 8);
      return { result: scanPage(stub, req.name, req.index, req.options), photoWidth: 0, photoHeight: 0, preview: null, decodeError: err instanceof Error ? err.message : String(err) };
    }
  }
  const result = scanPage(photo, req.name, req.index, req.options);
  return { result, photoWidth: photo.width, photoHeight: photo.height, preview: previewOf(photo, req.previewSide) };
}

/** Buffers of a reply that can be moved to the main thread instead of copied (each once; views into a shared buffer are left to the clone). */
export function replyTransferables(reply: ScanJobReply): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (img: RasterImage | null | undefined) => {
    const d = img?.data;
    if (d && d.byteOffset === 0 && d.byteLength === d.buffer.byteLength && d.buffer instanceof ArrayBuffer) out.add(d.buffer);
  };
  for (const f of reply.result.frames) add(f.image);
  add(reply.result.rectified);
  add(reply.preview);
  return [...out];
}
