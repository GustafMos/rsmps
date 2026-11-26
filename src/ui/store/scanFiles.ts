/**
 * "Save scan for a computer" and "Load scan file" of the 3D Scan node: the scan as one zip (see io/scan-package.ts) and back.
 * Loading puts the photos into Media and sets the node's `scan` param as one undo step.
 */
import { safeFolderName } from '../../engine/lib/scan-export';
import type { ScanData } from '../../engine/lib/scan-data';
import { buildScanZip, readScanPackage, unzipScan } from '../../io/scan-package';
import { download } from '../palette/formats';
import type { AppCtx } from './context';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

export interface SaveProgress {
  fraction: number;
  note: string;
}

/** Build the zip and hand it to the browser as a download. Returns false when cancelled or failed (a toast says why). */
export async function saveScanZip(app: Ctx, scan: ScanData, name: string, onProgress: (p: SaveProgress) => void, signal: AbortSignal): Promise<boolean> {
  const { io, ed } = app;
  try {
    const folder = safeFolderName(name || '3d-scan');
    const res = await buildScanZip(scan, { folder, signal, readAsset: (id) => io.library.assetBytes?.(id) ?? Promise.resolve(null), onProgress: (fraction, note) => onProgress({ fraction, note }) });
    download(`${res.folder}.zip`, res.blob, 'application/zip');
    const mb = res.blob.size / 1e6;
    const left = res.skipped ? ` ${res.skipped} photo${res.skipped === 1 ? ' was' : 's were'} left out because ${res.skipped === 1 ? 'it is' : 'they are'} no longer in Media.` : '';
    ed.toast(`Saved ${res.folder}.zip: ${res.photos} photos, ${mb.toFixed(1)} MB, ${res.points ? `${res.points} depth points` : 'no depth points'}. Open README.txt inside for what to do next.${left}`, res.skipped ? 'info' : 'ok');
    return true;
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) ed.toast('Saving the scan was cancelled. Nothing was downloaded.', 'info');
    else ed.toast(`The scan could not be saved: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}

async function entriesOf(files: File[]): Promise<Record<string, Uint8Array>> {
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) return unzipScan(new Uint8Array(await zip.arrayBuffer()));
  const out: Record<string, Uint8Array> = {};
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/^scan\.json$/i.test(f.name) || /\.(jpe?g|png)$/i.test(f.name)) out[path] = new Uint8Array(await f.arrayBuffer());
  }
  return out;
}

/** Read a saved scan (its zip, or scan.json with the numbered photos) into this node. One undo step. */
export async function loadScanFiles(app: Ctx, nodeId: string, files: File[]): Promise<boolean> {
  const { io, ed } = app;
  try {
    const pack = readScanPackage(await entriesOf(files));
    const mime = (n: string) => (/\.png$/i.test(n) ? 'image/png' : 'image/jpeg');
    const assets = await io.library.add(pack.photos.map((p, i) => new File([p.bytes as BlobPart], `scan-${String(i + 1).padStart(4, '0')}${/\.png$/i.test(p.name) ? '.png' : '.jpg'}`, { type: mime(p.name) })));
    if (assets.length !== pack.photos.length) throw new Error('some photos could not be added to Media');
    const scan: ScanData = { ...pack.scan, shots: pack.scan.shots.map((s) => ({ ...s, asset: assets[Number(s.asset.slice(4))].id })) };
    ed.beginHold();
    ed.setParam(nodeId, 'scan', scan);
    ed.endHold();
    ed.toast(`Scan loaded: ${scan.shots.length} photos added to Media.${pack.missing ? ` ${pack.missing} shot${pack.missing === 1 ? '' : 's'} had no photo and ${pack.missing === 1 ? 'was' : 'were'} left out.` : ''} Undo takes the scan out of the node again.`, pack.missing ? 'info' : 'ok');
    return true;
  } catch (err) {
    ed.toast(`The scan could not be loaded: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}
