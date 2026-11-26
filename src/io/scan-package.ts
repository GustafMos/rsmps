/**
 * The 3D scan as ONE zip file (save for a computer) and back (load scan file). The files and their conventions are in
 * engine/lib/scan-export.ts. The zip is written with fflate's streaming writer, STORE only (JPEG does not compress), one photo at a time,
 * with the CRC computed on the fly. Plain zip (no zip64): the total must stay under 4 GB, which a scan of at most 200 photos does by a wide margin.
 */
import { Zip, ZipPassThrough, unzipSync } from 'fflate';
import { imageFileName, scanTextFiles } from '../engine/lib/scan-export';
import { isScanData, normalizeScan, type ScanData } from '../engine/lib/scan-data';

const MAX_ZIP_BYTES = 3.9e9;
const enc = new TextEncoder();

export interface PackOptions {
  /** Folder name inside the zip (made file-safe). */
  folder?: string;
  /** The bytes of a photo (its Media asset), or null when it is gone. */
  readAsset: (assetId: string) => Promise<ArrayBuffer | null>;
  signal?: AbortSignal;
  /** 0..1, after every photo. */
  onProgress?: (fraction: number, note: string) => void;
}
export interface PackResult {
  blob: Blob;
  folder: string;
  photos: number;
  /** Photos whose file was missing from Media (left out of everything). */
  skipped: number;
  /** Depth points written to points3D.txt. */
  points: number;
}

const aborted = () => new DOMException('Aborted', 'AbortError');
const isPng = (b: Uint8Array) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export async function buildScanZip(raw: ScanData, opts: PackOptions): Promise<PackResult> {
  const scan = normalizeScan(raw);
  const total = scan.shots.length;
  if (!total) throw new Error('This scan has no photos to save.');
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let bytes = 0;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else {
      chunks.push(chunk);
      bytes += chunk.length;
    }
  });
  const add = (path: string, data: Uint8Array) => {
    const f = new ZipPassThrough(path);
    zip.add(f);
    f.push(data, true);
    if (failure) throw failure;
    if (bytes > MAX_ZIP_BYTES) throw new Error('The scan is too big for one zip file (4 GB).');
  };
  // photos one at a time, straight into the zip; the names count only the photos that are present, in shot order
  const folder = scanTextFiles(scan, { folder: opts.folder, withDepth: false }).folder;
  const root = `${folder}/`;
  const used: ScanData['shots'] = [];
  const exts: string[] = [];
  let skipped = 0;
  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw aborted();
    const buf = await opts.readAsset(scan.shots[i].asset);
    if (buf && buf.byteLength) {
      const data = new Uint8Array(buf);
      const ext = isPng(data) ? 'png' : 'jpg';
      add(`${root}images/${imageFileName(used.length, ext)}`, data);
      used.push(scan.shots[i]);
      exts.push(ext);
    } else skipped++;
    opts.onProgress?.(((i + 1) / total) * 0.98, `Packing photo ${i + 1} of ${total}`);
  }
  if (!used.length) throw new Error('None of the photos of this scan are in Media any more.');
  const files = scanTextFiles({ ...scan, shots: used }, { folder: opts.folder, exts });
  for (const [path, text] of Object.entries(files.text)) add(root + path, enc.encode(text));
  zip.end();
  if (failure) throw failure;
  opts.onProgress?.(1, 'Done');
  return { blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }), folder: files.folder, photos: used.length, skipped, points: files.points };
}

/* ------------------------------------------------------------------ reading a package back */

export interface PackedPhoto {
  name: string;
  bytes: Uint8Array;
}
export interface ReadPackage {
  /** The scan with each shot's `asset` set to `pkg:<index into photos>`; the caller swaps those for real asset ids. */
  scan: ScanData;
  photos: PackedPhoto[];
  /** Shots dropped because their photo is not in the package. */
  missing: number;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Files by path (a zip's entries, or a folder's files) to a scan. Throws a readable error for anything that is not a saved scan. */
export function readScanPackage(entries: Record<string, Uint8Array>): ReadPackage {
  const paths = Object.keys(entries);
  const jsonPath = paths.filter((p) => baseName(p).toLowerCase() === 'scan.json').sort((a, b) => a.length - b.length)[0];
  if (!jsonPath) throw new Error('There is no scan.json in this file, so it is not a scan saved by RSMPS.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(entries[jsonPath]));
  } catch {
    throw new Error('scan.json could not be read.');
  }
  if (!isScanData(raw)) throw new Error('scan.json is not a 3D scan this version understands.');
  // photo i is images/000(i+1).<ext> next to scan.json (or, for a loose pile of files, any file with that name)
  const dir = jsonPath.includes('/') ? jsonPath.slice(0, jsonPath.lastIndexOf('/') + 1) : '';
  const byStem = new Map<string, string>();
  for (const p of paths) {
    const m = /^(\d{4,})\.(jpe?g|png)$/i.exec(baseName(p));
    if (!m) continue;
    const inImages = p.startsWith(`${dir}images/`);
    if (inImages || !byStem.has(m[1])) byStem.set(m[1], p);
  }
  const photos: PackedPhoto[] = [];
  const rawShots = Array.isArray((raw as { shots?: unknown }).shots) ? ((raw as unknown as { shots: Record<string, unknown>[] }).shots) : [];
  let missing = 0;
  const tagged = rawShots.map((s, i) => {
    const stem = imageFileName(i).slice(0, 4);
    const p = byStem.get(stem);
    if (!p || !s || typeof s !== 'object') {
      missing++;
      return null;
    }
    photos.push({ name: baseName(p), bytes: entries[p] });
    return { ...s, asset: `pkg:${photos.length - 1}` };
  });
  const scan = normalizeScan({ ...(raw as object), shots: tagged.filter((s) => s) });
  const keep = new Set(scan.shots.map((s) => s.asset));
  missing += tagged.filter((s) => s && !keep.has(s.asset as string)).length;
  if (!scan.shots.length) throw new Error('This scan has no photos that could be used.');
  return { scan, photos, missing };
}

/** A saved scan zip to its files (store or deflate; only the files this reader needs are unpacked). */
export function unzipScan(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') && /(^|\/)(scan\.json|images\/[^/]+)$/i.test(f.name) });
  } catch {
    throw new Error('This file is not a zip file that could be opened.');
  }
}
