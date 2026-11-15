/**
 * Multi-page assembly: take the per-photo results of `scanPage`, order them by decoded page index,
 * drop duplicates and foreign projects, and return the frames in print order with a report. Pure.
 */
import type { ScanReport } from '../../api';
import { formatProjectId } from '../format';
import { resizeRaster, type RasterImage } from '../raster';
import { scanPage, type PageScan, type PageScanOptions } from './page';

export interface AssembledScan {
  report: ScanReport;
  /** Frames by absolute index; null = missing. */
  frames: (RasterImage | null)[];
  pages: PageScan[];
}

/** Combine page scans. Mutates `used` and `warnings` in the page reports. */
export function assembleScan(input: PageScan[]): AssembledScan {
  const warnings: string[] = [];
  const pages: PageScan[] = input.map((p) => ({ ...p, header: p.header && { ...p.header }, frames: p.frames.map((f) => ({ ...f })) }));
  // Work on copies so assembling the same page scans again (after a manual fix) never double-counts warnings.
  const reports = new Map(pages.map((p) => [p, { ...p.report, warnings: [...p.report.warnings] }]));
  const R = (p: PageScan) => reports.get(p)!;
  const usable = pages.filter((p) => p.header && p.frames.length > 0);
  for (const p of pages) R(p).used = false;
  inheritFromStrips(pages, R);

  // Dominant project (pages typed in by hand have id 0 and join any project).
  const votes = new Map<number, number>();
  for (const p of usable) if (p.header!.projectId !== 0) votes.set(p.header!.projectId, (votes.get(p.header!.projectId) ?? 0) + 1);
  let project = 0;
  let best = 0;
  for (const [id, n] of votes) {
    if (n > best) {
      best = n;
      project = id;
    }
  }
  const sameProject = usable.filter((p) => {
    const id = p.header!.projectId;
    if (id === 0 || project === 0 || id === project) return true;
    R(p).warnings.push(`This photo belongs to a different printed set (${formatProjectId(id)}) than the others (${formatProjectId(project)}); it was ignored.`);
    return false;
  });

  // One photo per page index: the one with the lower registration error wins.
  const byIndex = new Map<number, PageScan>();
  for (const p of sameProject) {
    const idx = p.header!.pageIndex;
    const prev = byIndex.get(idx);
    if (!prev) byIndex.set(idx, p);
    else if (p.quality < prev.quality) {
      R(prev).warnings.push(`Page ${idx + 1} was photographed twice; this photo was ignored in favour of "${R(p).fileName}".`);
      byIndex.set(idx, p);
    } else {
      R(p).warnings.push(`Page ${idx + 1} was photographed twice; this photo was ignored in favour of "${R(prev).fileName}".`);
    }
  }
  const chosen = [...byIndex.values()].sort((a, b) => a.header!.pageIndex - b.header!.pageIndex);
  for (const p of chosen) R(p).used = true;
  for (const p of pages) if (R(p).status !== 'failed' && R(p).warnings.length > 0 && R(p).status === 'ok') R(p).status = 'warning';

  const manualOnly = chosen.length > 0 && chosen.every((p) => p.manualLayout);
  let pageCount = 0;
  let totalFrames = 0;
  let fps = 0;
  let frameW = 0;
  let frameH = 0;
  for (const p of chosen) {
    const h = p.header!;
    pageCount = Math.max(pageCount, h.pageCount, h.pageIndex + 1);
    totalFrames = Math.max(totalFrames, h.totalFrames, ...p.frames.map((f) => f.index + 1));
    if (!fps && h.fpsX100) fps = h.fpsX100 / 100;
    if (!frameW) {
      frameW = p.frames[0].image.width;
      frameH = p.frames[0].image.height;
    }
  }
  if (manualOnly) warnings.push('All pages use a manual layout; totals are estimated from the pages supplied.');

  const frames: (RasterImage | null)[] = Array.from({ length: totalFrames }, () => null);
  for (const p of chosen) for (const f of p.frames) frames[f.index] = f.image;
  const have = new Set(chosen.map((p) => p.header!.pageIndex));
  const missingPages: number[] = [];
  for (let i = 0; i < pageCount; i++) if (!have.has(i)) missingPages.push(i);
  const missingFrames: number[] = [];
  frames.forEach((f, i) => f === null && missingFrames.push(i));
  const failed = pages.filter((p) => R(p).status === 'failed');

  if (chosen.length === 0) warnings.push('No page could be read. Check that all four corner markers are visible and the photo is sharp.');
  if (missingPages.length) warnings.push(`Missing page${missingPages.length > 1 ? 's' : ''}: ${missingPages.map((i) => i + 1).join(', ')} of ${pageCount}. ${missingFrames.length} frame${missingFrames.length === 1 ? '' : 's'} could not be recovered.`);
  for (const p of failed) warnings.push(`${R(p).fileName}: ${R(p).warnings[R(p).warnings.length - 1] ?? 'failed'}`);

  const report: ScanReport = {
    pages: pages.map((p) => R(p)),
    projectId: project !== 0 ? formatProjectId(project) : chosen.length ? formatProjectId(0) : null,
    totalFrames,
    pageCount,
    fps,
    frameWidthPx: frameW,
    frameHeightPx: frameH,
    recoveredFrames: totalFrames - missingFrames.length,
    missingPages,
    missingFrames,
    complete: chosen.length > 0 && missingFrames.length === 0 && failed.length === 0,
    warnings,
  };
  return { report, frames, pages };
}

/** Convenience for tests and headless use: scan every photo and assemble. */
export function scanSheets(photos: { image: RasterImage; name?: string; options?: PageScanOptions }[], shared: PageScanOptions = {}): AssembledScan {
  const pages = photos.map((p, i) => scanPage(p.image, p.name ?? `photo-${i + 1}`, i, { ...shared, ...p.options }));
  return assembleScan(pages);
}

/**
 * Pages whose strip was unreadable (layout from the + lattice) take project id, page count, frame total, fps and
 * frame size from decoded pages of the same grid; the page number is assigned when exactly one is missing.
 */
function inheritFromStrips(pages: PageScan[], R: (p: PageScan) => PageScan['report']): void {
  const decoded = pages.filter((p) => p.header && p.frames.length > 0 && !p.latticeLayout && !p.manualLayout);
  const lattice = pages.filter((p) => p.header && p.latticeLayout && p.frames.length > 0);
  if (decoded.length === 0 || lattice.length === 0) return;
  const have = new Set(decoded.map((p) => p.header!.pageIndex));
  for (const p of lattice) {
    const h = p.header!;
    const q = decoded.find((d) => d.header!.paper === h.paper && d.header!.landscape === h.landscape && d.header!.columns === h.columns && d.header!.rows === h.rows);
    if (!q) continue;
    const t = q.header!;
    const missing: number[] = [];
    for (let i = 0; i < t.pageCount; i++) if (!have.has(i)) missing.push(i);
    const r = R(p);
    const notes: string[] = [`fps ${t.fpsX100 / 100}, ${t.totalFrames} frames in ${t.pageCount} pages and the project id were taken from the pages that could be read`];
    let pageIndex = h.pageIndex;
    if (missing.length === lattice.length) {
      pageIndex = missing[lattice.indexOf(p)];
      notes.push(lattice.length === 1 ? `this is the only page missing, so it is page ${pageIndex + 1}` : `pages were assigned to the missing numbers in the order given: this one is page ${pageIndex + 1} (check)`);
    } else notes.push(`page number could not be determined, assuming ${pageIndex + 1}`);
    const shift = pageIndex * t.columns * t.rows - h.firstFrame;
    h.pageIndex = pageIndex;
    h.pageCount = t.pageCount;
    h.totalFrames = t.totalFrames;
    h.fpsX100 = t.fpsX100;
    h.frameW = t.frameW;
    h.frameH = t.frameH;
    h.guide = t.guide;
    h.guideOpacity = t.guideOpacity;
    h.projectId = t.projectId;
    h.firstFrame += shift;
    p.frames = p.frames.map((f) => ({ ...f, index: f.index + shift })).filter((f) => f.index < t.totalFrames);
    if (t.frameW && t.frameH) p.frames = p.frames.map((f) => (f.image.width === t.frameW && f.image.height === t.frameH ? f : { ...f, image: resizeRaster(f.image, t.frameW, t.frameH, 'auto') }));
    if (r.layout) {
      Object.assign(r.layout, { pageIndex, pageCount: t.pageCount, firstFrame: h.firstFrame, totalFrames: t.totalFrames, framesOnPage: p.frames.length, fps: t.fpsX100 / 100, frameWidthPx: t.frameW, frameHeightPx: t.frameH, guide: t.guide, guideOpacity: t.guideOpacity, projectId: formatProjectId(t.projectId) });
    }
    r.pageIndex = pageIndex;
    r.frameRange = p.frames.length ? [p.frames[0].index, p.frames[p.frames.length - 1].index] : null;
    r.cells = r.cells.map((c) => ({ ...c, frame: c.frame + shift })).filter((c) => c.frame < t.totalFrames);
    r.warnings.push(`Layout inferred from the + marks (strip unreadable): ${notes.join('; ')}.`);
  }
}
