/**
 * Parallel scanning on real synthetic pages: results are the same as scanning one after another, whatever order the photos
 * finish in; progress events, failure isolation and cancel through `scanBatch`; the job code the worker runs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanProgressEvent } from '../../api';
import { planSheet } from '../layout';
import { renderPage } from '../render';
import { createRaster, type RasterImage } from '../raster';
import { makeFrames, photograph } from '../testkit.test-util';
import { scanBatch } from './batch';
import { replyTransferables, runScanJob } from './job';
import { scanPage, type PageScan } from './page';
import { assembleScan } from './pipeline';

const N = 24;
let photos: RasterImage[] = [];

beforeAll(async () => {
  const frames = makeFrames(N, 96, 72, 11);
  const sheet = planSheet({ columns: 3, rows: 4, name: 'parallel test', dpi: 300 }, { width: 96, height: 72, count: N, fps: 12 });
  const pages = [0, 1].map((p) => renderPage(sheet, p, (i) => frames[i]));
  // page 1, page 0 (reverse), and a third photo that is not a sheet at all
  photos = [
    (await photograph(pages[1], { seed: 21, rotateDeg: -5, width: 1500, height: 2000 })).image,
    (await photograph(pages[0], { seed: 22, rotateDeg: 4, width: 1500, height: 2000 })).image,
    createRaster(300, 200, [120, 130, 140, 255]),
  ];
}, 120000);

const names = ['b.jpg', 'a.jpg', 'blank.jpg'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Everything the UI could see of an assembled scan, as JSON-comparable data (frames by hash-free exact bytes). */
function fingerprint(pages: PageScan[]) {
  const out = assembleScan(pages);
  return {
    report: JSON.parse(JSON.stringify(out.report)),
    frames: out.frames.map((f) => (f ? Array.from(f.data.subarray(0, 4000)).join(',') + ':' + f.data.length : null)),
  };
}

describe('parallel scan', () => {
  it('assembles the same result when jobs finish in reverse order', async () => {
    const sequential = photos.map((p, i) => scanPage(p, names[i], i));
    const finished: number[] = [];
    const outcomes = await scanBatch<PageScan>({
      names,
      concurrency: 3,
      run: async (i, started) => {
        started();
        await sleep((photos.length - i) * 30); // the last photo finishes first
        const page = scanPage(photos[i], names[i], i);
        finished.push(i);
        return page;
      },
    });
    expect(finished).toEqual([2, 1, 0]);
    const parallel = outcomes.map((o) => (o.ok ? o.value : null)) as PageScan[];
    expect(fingerprint(parallel)).toEqual(fingerprint(sequential));
    // pages stay in list order in the report, frames are placed by decoded page index (photo 0 is page 2 of the set)
    const out = assembleScan(parallel);
    expect(out.report.pages.map((p) => p.fileName)).toEqual(names);
    expect(out.report.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(out.report.pages.map((p) => p.pageIndex)).toEqual([1, 0, null]);
    expect(out.report.recoveredFrames).toBe(N);
    expect(out.frames.every((f) => f !== null)).toBe(true);
  }, 60000);

  it('reports queued, scanning and done for the right photo, with completed / total', async () => {
    const events: ScanProgressEvent[] = [];
    await scanBatch<number>({
      names: ['x', 'y', 'z'],
      concurrency: 2,
      onProgress: (e) => events.push(e),
      run: async (i, started) => {
        if (i < 2) {
          started();
          await sleep(i === 0 ? 40 : 10);
        } else {
          await sleep(60); // queued behind the first two, starts late
          started();
        }
        return i;
      },
    });
    expect(events.slice(0, 3).map((e) => [e.index, e.state, e.completed])).toEqual([[0, 'queued', 0], [1, 'queued', 0], [2, 'queued', 0]]);
    const rest = events.slice(3).map((e) => `${e.fileName}:${e.state}:${e.completed}/${e.total}`);
    expect(rest).toEqual(['x:scanning:0/3', 'y:scanning:0/3', 'y:done:1/3', 'x:done:2/3', 'z:scanning:2/3', 'z:done:3/3']);
    expect(events.every((e) => e.concurrency === 2)).toBe(true);
  });

  it('a failed photo reports its own error and the others still complete', async () => {
    const events: ScanProgressEvent[] = [];
    const out = await scanBatch<number>({
      names: ['ok1', 'bad', 'ok2'],
      concurrency: 3,
      onProgress: (e) => events.push(e),
      run: async (i) => {
        if (i === 1) throw new Error('worker exploded');
        return i * 10;
      },
    });
    expect(out.map((o) => (o.ok ? o.value : o.error.message))).toEqual([0, 'worker exploded', 20]);
    const bad = events.filter((e) => e.index === 1).pop()!;
    expect(bad).toMatchObject({ state: 'failed', error: 'worker exploded' });
    expect(events[events.length - 1].completed).toBe(3);
  });

  it('cancel: rejects with an AbortError, marks the running and queued photos cancelled', async () => {
    const ac = new AbortController();
    const events: ScanProgressEvent[] = [];
    const run = scanBatch<number>({
      names: ['a', 'b', 'c'],
      concurrency: 1,
      signal: ac.signal,
      onProgress: (e) => events.push(e),
      run: (i, started) =>
        new Promise<number>((resolve, reject) => {
          if (i === 0) started();
          ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
          if (i === 0) setTimeout(() => resolve(0), 1000);
        }),
    });
    await sleep(10);
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.filter((e) => e.state === 'cancelled').map((e) => e.index).sort()).toEqual([0, 1, 2]);
    expect(events.some((e) => e.state === 'done')).toBe(false);
  });
});

describe('scan job (what the worker runs)', () => {
  it('gives the same page as scanPage, a bounded preview, and transferable buffers without duplicates', async () => {
    const direct = scanPage(photos[1], 'a.jpg', 1);
    const reply = await runScanJob({ source: { kind: 'raster', image: photos[1] }, name: 'a.jpg', index: 1, options: {}, previewSide: 512 });
    expect(reply.photoWidth).toBe(1500);
    expect(reply.photoHeight).toBe(2000);
    expect(Math.max(reply.preview!.width, reply.preview!.height)).toBe(512);
    expect(reply.result.report).toEqual(direct.report);
    expect(reply.result.frames.map((f) => f.index)).toEqual(direct.frames.map((f) => f.index));
    expect(Buffer.from(reply.result.frames[0].image.data).equals(Buffer.from(direct.frames[0].image.data))).toBe(true);
    const t = replyTransferables(reply);
    expect(new Set(t).size).toBe(t.length);
    expect(t.length).toBe(reply.result.frames.length + 2); // frames + rectified page + preview
  });

  it('refuses to decode where the realm has no image decoder (the caller then decodes and sends pixels)', async () => {
    // Node has neither createImageBitmap nor OffscreenCanvas, exactly like a worker in an old browser
    await expect(runScanJob({ source: { kind: 'file', blob: new Blob([new Uint8Array(10)]), maxSide: 5000 }, name: 'x', index: 0, options: {}, previewSide: 512 })).rejects.toMatchObject({ code: 'no-decode' });
  });
});
