/**
 * Scan with phone, computer side, end to end with no network: a simulated phone (the real ChunkSender and the real status / preview
 * parsing) talks to the real PhoneScanStore through a loopback, and the Scan tab is replaced by a fake ScanApi that answers like the
 * real one (statuses per photo, assembled pages, missing sheets).
 */
import { describe, expect, it } from 'vitest';
import type { ScanAnalyzeOptions, ScanPageReport, ScanProgressHooks, ScanResult } from './api';
import { PhoneScanStore, failureNote, statusForPage, summaryOf, type ControllerOptions, type ScanSink } from './phone-scan';
import { PREVIEW_LIMITS, PHOTO_LIMITS, crc32, parsePreviewMeta, parseScanStatus, parseScanSummary, parseChunkFrame, isScanFrame, type ScanStatusMsg, type ScanSummaryMsg } from '../phone/scan-protocol';
import { ChunkSender, TransferReceiver, type CompletedTransfer } from '../phone/scan-transfer';
import { createRaster } from './print/raster';

const TOKEN = 'a'.repeat(32);

function jpegBytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  b.set([0xff, 0xd8, 0xff], 0);
  return b;
}

/* ----------------------------------------------- fake scan API ----------------------------------------------- */

/** What a photo "contains": its file name says which sheet it is (sheet-<n>.jpg), `bad` has no corners, `dup` repeats a sheet. */
function pageFor(name: string, index: number, perSheet = 6, sheets = 4): ScanPageReport {
  const m = /sheet-(\d+)/.exec(name);
  const bad = /bad/.test(name);
  const sheet = m ? Number(m[1]) : 0;
  return {
    index, fileName: name, photoWidth: bad ? 800 : 4000, photoHeight: bad ? 600 : 3000,
    status: bad ? 'failed' : 'ok',
    corners: bad ? null : { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } },
    foundCorners: bad ? [{ x: 1, y: 1 }, { x: 5, y: 5 }] : [], cornersSource: bad ? null : 'auto', rotation: 0, skewDeg: 0,
    layout: bad ? null : ({ pageIndex: sheet - 1, pageCount: sheets, firstFrame: (sheet - 1) * perSheet, framesOnPage: perSheet, totalFrames: sheets * perSheet, fps: 12 } as ScanPageReport['layout']),
    layoutSource: bad ? null : 'strip', pageIndex: bad ? null : sheet - 1, frameRange: bad ? null : [(sheet - 1) * perSheet, sheet * perSheet - 1],
    reprojectionErrorPx: 0, marksFound: 10, marksExpected: 10, marks: [], cells: [], used: true, thumbnailUrl: null, thumbnailKind: 'photo', photoUrl: null, photoScale: 1,
    warnings: bad ? ['Not all four corner markers were found'] : [],
  };
}

function resultOf(names: string[], perSheet = 6, sheets = 4): ScanResult {
  const pages = names.map((n, i) => pageFor(n, i, perSheet, sheets));
  const seen = new Set<number>();
  for (const p of pages) {
    if (p.pageIndex === null) continue;
    if (seen.has(p.pageIndex)) p.used = false;
    seen.add(p.pageIndex);
  }
  const total = sheets * perSheet;
  const frames = Array.from({ length: total }, (_, i) => (seen.has(Math.floor(i / perSheet)) ? { index: i, width: 64, height: 48, data: new Uint8ClampedArray(createRaster(64, 48, [i * 5, 100, 100, 255]).data) } : null));
  return {
    report: {
      pages, projectId: 'abc', totalFrames: total, pageCount: sheets, fps: 12, frameWidthPx: 64, frameHeightPx: 48,
      recoveredFrames: frames.filter(Boolean).length,
      missingPages: Array.from({ length: sheets }, (_, i) => i).filter((i) => !seen.has(i)),
      missingFrames: frames.map((f, i) => (f ? -1 : i)).filter((i) => i >= 0),
      complete: seen.size === sheets, warnings: [],
    },
    frames, frameUrls: frames.map(() => null), reanalyzePage: async () => { throw new Error('unused'); }, dispose: () => undefined,
  };
}

/** Records what the Scan tab would do: analyze (fresh) and append (only the new photos). */
function fakeScan(gate?: { wait: Promise<void> | null }) {
  const calls: { kind: 'analyze' | 'append'; names: string[] }[] = [];
  const all: string[] = [];
  const sink: ScanSink = {
    async analyze(files, _o?: ScanAnalyzeOptions, hooks?: ScanProgressHooks) {
      calls.push({ kind: 'analyze', names: files.map((f) => f.name) });
      all.length = 0;
      all.push(...files.map((f) => f.name));
      files.forEach((f, i) => hooks?.onProgress?.({ index: i, fileName: f.name, state: 'scanning', completed: 0, total: files.length, concurrency: 2 }));
      if (gate?.wait) await gate.wait;
      return resultOf(all);
    },
    async append(_r, files, _o, hooks) {
      calls.push({ kind: 'append', names: files.map((f) => f.name) });
      all.push(...files.map((f) => f.name));
      files.forEach((f, i) => hooks?.onProgress?.({ index: i, fileName: f.name, state: 'scanning', completed: 0, total: files.length, concurrency: 2 }));
      if (gate?.wait) await gate.wait;
      return resultOf(all);
    },
  };
  return { sink, calls };
}

/* ----------------------------------------------- simulated phone ----------------------------------------------- */

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(opts: { sink?: ScanSink; attach?: boolean; previewDelayMs?: number; sprite?: (n: number) => Uint8Array } = {}) {
  const toPhone: (Record<string, unknown> | Uint8Array)[] = [];
  const store = new PhoneScanStore({ sendJson: (_t, m) => toPhone.push(m), sendBinary: (_t, b) => toPhone.push(b), buffered: () => 0, autoTick: false });
  const scan = opts.sink ? undefined : fakeScan();
  let current: ScanResult | null = null;
  const adopted: { mode: string; files: string[] }[] = [];
  const busy: boolean[] = [];
  const timers: (() => void)[] = [];
  const encoded: { w: number; h: number }[] = [];
  const co: Omit<ControllerOptions, 'send' | 'sendBinary' | 'buffered'> = {
    scan: opts.sink ?? scan!.sink,
    current: () => current,
    adopt: (r, files, mode) => {
      current = r;
      adopted.push({ mode, files: files.map((f) => f.name) });
    },
    previousFiles: () => [],
    busy: (on) => busy.push(on),
    encodeSprite: async (img) => {
      encoded.push({ w: img.width, h: img.height });
      return (opts.sprite ?? ((n) => jpegBytes(n, 9)))(20_000);
    },
    previewDelayMs: opts.previewDelayMs ?? 1500,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => undefined,
  };
  const attach = opts.attach === false ? null : store.attach(TOKEN, co);

  // the phone
  const statuses: ScanStatusMsg[] = [];
  const summaries: ScanSummaryMsg[] = [];
  const previews: CompletedTransfer[] = [];
  const rejects: Record<string, unknown>[] = [];
  const senders = new Map<number, ChunkSender>();
  const failed = new Map<number, string>();
  const previewIn = new TransferReceiver({
    prefix: 'preview', limits: PREVIEW_LIMITS, allowed: ['image/jpeg'],
    send: (m) => store.ingestJson(TOKEN, m), onComplete: (d) => previews.push(d),
    checkBegin: (b) => (parsePreviewMeta(b) ? null : 'bad meta'),
  });
  let clock = 0;
  /** Deliver what the computer sent to the phone, and what the phone answers back, until quiet. */
  function drain(): void {
    for (let guard = 0; guard < 500 && toPhone.length; guard++) {
      const m = toPhone.shift()!;
      if (m instanceof Uint8Array) {
        const f = parseChunkFrame(m);
        if (f) previewIn.handleChunk(f, clock);
        continue;
      }
      const t = String(m.type);
      if (t === 'scan-status') statuses.push(parseScanStatus(m)!);
      else if (t === 'scan-summary') summaries.push(parseScanSummary(m)!);
      else if (t.startsWith('preview-')) previewIn.handleJson(m, clock);
      else if (t.startsWith('scan-')) {
        if (t === 'scan-reject') rejects.push(m);
        senders.get(m.id as number)?.onMessage(m as never, clock);
      }
    }
  }
  function upload(name: string, id: number, bytes = jpegBytes(30_000, id), mime = 'image/jpeg'): ChunkSender {
    const s = new ChunkSender({
      prefix: 'scan', id, name, mime, w: 4000, h: 3000, bytes, chunkBytes: PHOTO_LIMITS.chunkBytes, window: PHOTO_LIMITS.window,
      transport: { sendJson: (m) => store.ingestJson(TOKEN, m as never), sendChunk: (f) => store.ingestBinary(TOKEN, f), buffered: () => 0 },
      onFail: (r) => failed.set(id, r),
    });
    senders.set(id, s);
    s.start(clock);
    drain();
    return s;
  }
  return { store, toPhone, statuses, summaries, previews, rejects, upload, drain, flush, adopted, busy, timers, encoded, failed, scan, attach, setCurrent: (r: ScanResult | null) => (current = r), get current() { return current; } };
}

const last = (list: ScanStatusMsg[], id: number) => list.filter((s) => s.id === id).at(-1);

describe('status mapping', () => {
  it('a read page becomes "sheet N, frames a-b" (1-based)', () => {
    const s = statusForPage(5, pageFor('sheet-3.jpg', 0), 6);
    expect(s).toEqual({ type: 'scan-status', id: 5, state: 'done', sheet: 3, sheets: 6, frames: [13, 18] });
  });
  it('no corner markers -> a failure with the reason and a retake', () => {
    const s = statusForPage(5, pageFor('bad.jpg', 0), 0);
    expect(s).toMatchObject({ state: 'failed', retake: true });
    expect(s.note).toMatch(/Corner marker not found \(2 of 4 seen\)/);
  });
  it('corners but no readable strip, or a photo that did not open', () => {
    const p = pageFor('sheet-1.jpg', 0);
    expect(failureNote({ ...p, layout: null })).toMatch(/data strip/);
    expect(failureNote({ ...p, photoWidth: 0 })).toMatch(/could not be opened/);
    expect(statusForPage(1, undefined, 3)).toMatchObject({ state: 'failed', retake: true });
  });
  it('a duplicate sheet that was not used is done with a note', () => {
    const s = statusForPage(5, { ...pageFor('sheet-1.jpg', 1), used: false }, 4);
    expect(s.state).toBe('done');
    expect(s.note).toMatch(/Not used/);
  });
  it('the summary lists missing sheets and frames 1-based', () => {
    const r = resultOf(['sheet-1.jpg', 'sheet-3.jpg'], 6, 4);
    const sum = summaryOf(r, false);
    expect(sum).toMatchObject({ sheets: 4, missingSheets: [2, 4], recovered: 12, total: 24, busy: false });
    expect(sum.missingFrames.slice(0, 3)).toEqual([7, 8, 9]);
    expect(summaryOf(null, true)).toMatchObject({ sheets: 0, busy: true });
  });
});

describe('photos from the phone go through the scan pool', () => {
  it('a photo arrives, is scanned as a new project, and the phone hears received -> scanning -> done', async () => {
    const t = rig();
    t.upload('sheet-1.jpg', 11);
    await t.flush();
    t.drain();
    const seq = t.statuses.filter((s) => s.id === 11).map((s) => s.state);
    expect(seq).toEqual(['received', 'scanning', 'done']);
    expect(last(t.statuses, 11)).toMatchObject({ state: 'done', sheet: 1, sheets: 4, frames: [1, 6] });
    expect(t.adopted).toEqual([{ mode: 'fresh', files: ['sheet-1.jpg'] }]);
    expect(t.scan!.calls).toEqual([{ kind: 'analyze', names: ['sheet-1.jpg'] }]);
    expect(t.busy).toEqual([true, false]);
    expect(t.store.info(TOKEN)).toMatchObject({ received: 1, done: 1, failed: 0, attached: true });
  });

  it('the next photos are appended: only the new ones are scanned, and every photo keeps the right status', async () => {
    const t = rig();
    t.upload('sheet-1.jpg', 11);
    await t.flush();
    t.upload('sheet-2.jpg', 12);
    await t.flush();
    t.drain();
    expect(t.scan!.calls).toEqual([
      { kind: 'analyze', names: ['sheet-1.jpg'] },
      { kind: 'append', names: ['sheet-2.jpg'] },
    ]);
    expect(t.adopted.map((a) => a.mode)).toEqual(['fresh', 'append']);
    expect(last(t.statuses, 12)).toMatchObject({ state: 'done', sheet: 2, frames: [7, 12] });
    const sum = t.summaries.at(-1)!;
    expect(sum).toMatchObject({ sheets: 4, missingSheets: [3, 4], busy: false });
  });

  it('a photo without corner markers fails with the reason, the others carry on', async () => {
    const t = rig();
    t.upload('sheet-1.jpg', 11);
    t.upload('bad-1.jpg', 12);
    await t.flush();
    t.drain();
    expect(last(t.statuses, 11)?.state).toBe('done');
    const f = last(t.statuses, 12)!;
    expect(f.state).toBe('failed');
    expect(f.retake).toBe(true);
    expect(f.note).toMatch(/Corner marker not found/);
    expect(t.store.info(TOKEN)).toMatchObject({ done: 1, failed: 1 });
  });

  it('photos that arrive during a scan wait and are scanned together in the next run', async () => {
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) as Promise<void> | null };
    const fake = fakeScan(gate);
    const t = rig({ sink: fake.sink });
    t.upload('sheet-1.jpg', 11);
    await t.flush(); // the first scan is running (held)
    t.upload('sheet-2.jpg', 12);
    t.upload('sheet-3.jpg', 13);
    await t.flush();
    expect(fake.calls).toHaveLength(1);
    gate.wait = null;
    release();
    await t.flush();
    await t.flush();
    expect(fake.calls.map((c) => c.names)).toEqual([['sheet-1.jpg'], ['sheet-2.jpg', 'sheet-3.jpg']]); // one run for the two late photos
    t.drain();
    expect(last(t.statuses, 13)).toMatchObject({ state: 'done', sheet: 3 });
  });

  it('photos received before the Scan tab is ready are kept and handed over when it attaches', async () => {
    const t = rig({ attach: false });
    t.upload('sheet-1.jpg', 11);
    t.upload('sheet-2.jpg', 12);
    await t.flush();
    t.drain();
    expect(t.statuses.map((s) => s.state)).toEqual(['received', 'received']); // acknowledged, not scanned yet
    expect(t.store.info(TOKEN)).toMatchObject({ received: 2, attached: false, waiting: 2 });
    const fake = fakeScan();
    t.store.attach(TOKEN, { scan: fake.sink, current: () => null, adopt: () => undefined, encodeSprite: async () => jpegBytes(100, 1), setTimer: () => 0, clearTimer: () => undefined });
    await t.flush();
    expect(fake.calls[0].names).toEqual(['sheet-1.jpg', 'sheet-2.jpg']);
    expect(t.store.info(TOKEN)).toMatchObject({ waiting: 0, attached: true });
  });

  it('a scan that throws fails the photos of that run with a message, not the whole link', async () => {
    const t = rig({ sink: { analyze: async () => { throw new Error('out of memory'); } } });
    t.upload('sheet-1.jpg', 11);
    await t.flush();
    t.drain();
    expect(last(t.statuses, 11)).toMatchObject({ state: 'failed', retake: true });
    expect(last(t.statuses, 11)!.note).toMatch(/out of memory/);
    expect(t.busy.at(-1)).toBe(false);
  });

  it('a cancelled scan is reported as cancelled, not as a bad photo', async () => {
    const t = rig({ sink: { analyze: async () => { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; } } });
    t.upload('sheet-1.jpg', 11);
    await t.flush();
    t.drain();
    expect(last(t.statuses, 11)).toMatchObject({ state: 'failed' });
    expect(last(t.statuses, 11)!.retake).toBeUndefined();
    expect(last(t.statuses, 11)!.note).toMatch(/canceled/);
  });
});

describe('what the computer refuses from the phone', () => {
  it('a photo over 40 MB is refused before any chunk is sent, with the reason', async () => {
    const t = rig();
    const s = new ChunkSender({
      prefix: 'scan', id: 21, name: 'huge.jpg', mime: 'image/jpeg', bytes: new Uint8Array(41 * 1024 * 1024).fill(1), chunkBytes: PHOTO_LIMITS.chunkBytes, window: 6,
      transport: { sendJson: (m) => t.store.ingestJson(TOKEN, m as never), sendChunk: () => { throw new Error('must not send chunks'); }, buffered: () => 0 },
      onFail: (r) => t.failed.set(21, r),
    });
    s.start(0);
    const reject = t.toPhone.find((m) => !(m instanceof Uint8Array) && m.type === 'scan-reject') as Record<string, unknown>;
    expect(reject).toMatchObject({ id: 21, code: 'too-big' });
    s.onMessage(reject as never, 0);
    expect(t.failed.get(21)).toMatch(/limit is 40 MB/);
    expect(t.store.info(TOKEN)!.received).toBe(0);
  });

  it('a file that is not a picture never becomes a photo', async () => {
    const t = rig();
    const html = new TextEncoder().encode('<script>alert(1)</script>'.padEnd(2000, ' '));
    t.upload('evil.jpg', 31, html);
    await t.flush();
    t.drain();
    expect(t.rejects.at(-1)).toMatchObject({ code: 'bad-type' });
    expect(t.store.info(TOKEN)!.received).toBe(0);
    expect(t.scan!.calls).toHaveLength(0);
  });

  it('a type outside jpeg / png / webp is refused at begin', async () => {
    const t = rig();
    t.upload('x.heic', 32, jpegBytes(1000, 3), 'image/heic');
    expect(t.rejects.at(-1)).toMatchObject({ code: 'bad-type' });
    expect(t.failed.get(32)).toMatch(/jpeg, png, webp/);
  });

  it('chunks and end messages for ids that were never announced are refused', () => {
    const t = rig();
    t.store.ingestJson(TOKEN, { type: 'scan-end', id: 99, len: 10, crc: '00000000' });
    t.store.ingestBinary(TOKEN, new Uint8Array([...[0x52, 0x53, 0x43, 0x4e, 1], 0, 0, 0, 99, 0, 0, 0, 0, 1, 2, 3]));
    t.drain();
    expect(t.rejects.map((r) => r.code)).toEqual(['unknown-id', 'unknown-id']);
  });

  it('garbage messages are ignored', () => {
    const t = rig();
    t.store.ingestJson(TOKEN, { type: 'scan-begin' });
    t.store.ingestJson(TOKEN, { type: 'scan-chunk', id: 'x' });
    t.store.ingestJson(TOKEN, {});
    t.store.ingestBinary(TOKEN, new Uint8Array(3));
    expect(isScanFrame(new Uint8Array(3))).toBe(false);
    expect(t.store.info(TOKEN)!.received).toBe(0);
  });
});

describe('the preview goes back to the phone', () => {
  async function withFrames() {
    const t = rig();
    t.upload('sheet-1.jpg', 11);
    t.upload('sheet-2.jpg', 12);
    await t.flush();
    t.drain();
    return t;
  }

  it('is sent by itself after the frames were assembled and nothing is left to scan', async () => {
    const t = await withFrames();
    expect(t.previews).toHaveLength(0);
    expect(t.timers.length).toBeGreaterThan(0);
    t.timers.at(-1)!(); // the debounce elapsed
    await t.flush();
    t.drain();
    expect(t.previews).toHaveLength(1);
    const meta = parsePreviewMeta(t.previews[0].begin)!;
    expect(meta).toMatchObject({ count: 24, total: 24, step: 1, fps: 12, missingSheets: [3, 4] });
    expect(meta.missingFrames).toEqual(Array.from({ length: 12 }, (_, i) => i + 13));
    expect(t.previews[0].bytes.length).toBe(20_000);
    expect(crc32(t.previews[0].bytes)).toBe(crc32(jpegBytes(20_000, 9)));
    expect(t.store.info(TOKEN)!.previewSent).toBe(1);
    expect(t.encoded[0].w).toBeLessThanOrEqual(4096);
  });

  it('is sent when the phone presses Done, and when "Send preview to phone" is pressed', async () => {
    const t = await withFrames();
    t.store.ingestJson(TOKEN, { type: 'scan-done' });
    await t.flush();
    t.drain();
    expect(t.previews).toHaveLength(1);
    t.store.session(TOKEN).controller!.requestPreview();
    await t.flush();
    t.drain();
    expect(t.previews).toHaveLength(2);
  });

  it('nothing is sent when no frame was recovered', async () => {
    const t = rig();
    t.upload('bad-1.jpg', 11);
    await t.flush();
    t.drain();
    t.store.ingestJson(TOKEN, { type: 'scan-done' });
    await t.flush();
    t.drain();
    expect(t.previews).toHaveLength(0);
    expect(t.summaries.at(-1)).toMatchObject({ recovered: 0 });
  });

  it('a lost chunk of the preview is asked for again by the phone', async () => {
    const t = await withFrames();
    let dropped = false;
    const orig = t.toPhone.push.bind(t.toPhone);
    t.toPhone.push = (...m) => orig(...m.filter((x) => !(x instanceof Uint8Array && !dropped && parseChunkFrame(x)?.seq === 0 && (dropped = true))));
    t.store.session(TOKEN).controller!.requestPreview();
    await t.flush();
    t.drain();
    t.store.tick(Date.now() + 10_000); // the sender notices the silence
    t.drain();
    expect(dropped).toBe(true);
    expect(t.previews).toHaveLength(1);
  });
});

describe('the store', () => {
  it('detaching the Scan tab stops its work and drops a session', () => {
    const t = rig();
    t.attach!.detach();
    expect(t.store.info(TOKEN)!.attached).toBe(false);
    t.store.drop(TOKEN);
    expect(t.store.info(TOKEN)).toBeNull();
  });
  it('knows which messages are its own (so the link code does not mistake them for camera or sensor data)', () => {
    expect(PhoneScanStore.handles('scan-begin')).toBe(true);
    expect(PhoneScanStore.handles('preview-ack')).toBe(true);
    expect(PhoneScanStore.handles('motion')).toBe(false);
    expect(PhoneScanStore.handles('offer')).toBe(false);
    expect(PhoneScanStore.handlesBinary(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });
});
