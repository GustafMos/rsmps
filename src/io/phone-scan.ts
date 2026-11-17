/**
 * "Scan with phone", computer side. Photos arrive from the phone over the chunked transfer (src/phone/scan-transfer.ts), are validated,
 * become ordinary `File`s and go into the same scan pool as "Add photos…". The controller reports a status per photo back to the phone
 * and, after the frames are assembled, sends it a small preview animation.
 *
 *  - `PhoneScanStore`   one per PhoneLink: a `PhoneScanSession` per pairing token (receiver, counters, photos waiting for the Scan tab).
 *  - `PhoneScanController`  made by the Scan tab: owns nothing but the queue; the open scan project (result, storage) stays with the tab.
 *
 * Received files are untrusted: size / count / type caps and a magic-byte check happen in the receiver, the bytes are only ever decoded by
 * the scan pipeline's own safe decode path (same as dropped files), never executed and never written anywhere but the normal scan session.
 */
import type { ScanAnalyzeOptions, ScanPageReport, ScanProgressEvent, ScanProgressHooks, ScanResult } from './api';
import type { RasterImage } from './print/raster';
import { PHOTO_LIMITS, PHOTO_TYPES, SCAN_TYPES, SCAN_VERSION, isScanFrame, parseChunkFrame, type PhotoState, type ScanStatusMsg, type ScanSummaryMsg } from '../phone/scan-protocol';
import { ChunkSender, TransferReceiver, type CompletedTransfer } from '../phone/scan-transfer';
import { PREVIEW_JPEG_QUALITY, packSprite, planPreview, previewMeta } from './phone-scan-preview';

/* ------------------------------------------- status mapping ------------------------------------------- */

/** Words for why a photo could not be used (the thing to tell the person holding the phone). */
export function failureNote(p: Pick<ScanPageReport, 'photoWidth' | 'corners' | 'foundCorners' | 'layout' | 'warnings'>): string {
  if (!p.photoWidth) return 'The photo could not be opened.';
  if (!p.corners) return `Corner marker not found (${Math.min(4, p.foundCorners.length)} of 4 seen). Keep all four corner squares in view.`;
  if (!p.layout) return 'The data strip at the top of the sheet could not be read. Retake in better light, without glare.';
  const w = p.warnings[0];
  return w ? w.slice(0, 160) : 'This photo could not be read.';
}

/** The status the phone shows for one scanned photo, from the page report of this photo. */
export function statusForPage(id: number, p: ScanPageReport | undefined, totalSheets: number): ScanStatusMsg {
  if (!p) return { type: 'scan-status', id, state: 'failed', note: 'The photo went missing on the computer.', retake: true };
  if (p.status === 'failed' || !p.layout) return { type: 'scan-status', id, state: 'failed', note: failureNote(p), retake: true };
  const msg: ScanStatusMsg = { type: 'scan-status', id, state: 'done' };
  if (p.pageIndex !== null) msg.sheet = p.pageIndex + 1;
  if (totalSheets > 0) msg.sheets = totalSheets;
  if (p.frameRange) msg.frames = [p.frameRange[0] + 1, p.frameRange[1] + 1];
  if (!p.used) msg.note = 'Not used: a better photo of this sheet (or a sheet of another set) was kept.';
  else if (p.status === 'warning' && p.warnings[0]) msg.note = p.warnings[0].slice(0, 160);
  return msg;
}

/** Where the whole animation stands, for the phone's reshoot list. */
export function summaryOf(result: ScanResult | null, busy: boolean): ScanSummaryMsg {
  if (!result) return { type: 'scan-summary', sheets: 0, missingSheets: [], missingFrames: [], recovered: 0, total: 0, fps: 12, busy };
  const r = result.report;
  return {
    type: 'scan-summary',
    sheets: r.pageCount,
    missingSheets: r.missingPages.map((n) => n + 1).slice(0, 500),
    missingFrames: r.missingFrames.map((n) => n + 1).slice(0, 500),
    recovered: r.recoveredFrames,
    total: r.totalFrames || result.frames.length,
    fps: r.fps || 12,
    busy,
  };
}

/* --------------------------------------------- controller --------------------------------------------- */

/** The part of `Io.scan` the controller needs. `append` scans only the new photos and keeps the old results. */
export interface ScanSink {
  analyze(files: File[], options?: ScanAnalyzeOptions, hooks?: ScanProgressHooks): Promise<ScanResult>;
  append?(result: ScanResult, files: File[], options?: ScanAnalyzeOptions, hooks?: ScanProgressHooks): Promise<ScanResult>;
}

export interface Incoming {
  id: number;
  file: File;
}

export interface ControllerOptions {
  scan: ScanSink;
  /** The open scan project's current result (null = nothing scanned yet). */
  current(): ScanResult | null;
  /**
   * Take the new result. `files`: with mode 'append' only the new photos (add them to the project's list); with 'fresh' the complete list.
   */
  adopt(result: ScanResult, files: File[], mode: 'append' | 'fresh'): void | Promise<void>;
  /** Used only when the scan API has no `append`: the photos already in the project. */
  previousFiles?(): File[];
  /** Hooks of the Scan tab (its progress list and Cancel). Called once per run. */
  hooks?(): ScanProgressHooks;
  /** The Scan tab shows its busy bar while photos are scanned. */
  busy?(on: boolean): void;
  analyzeOptions?(): ScanAnalyzeOptions | undefined;
  send(msg: Record<string, unknown>): void;
  sendBinary(bytes: Uint8Array): void;
  buffered(): number;
  /** JPEG bytes of the sprite sheet. Browser glue (OffscreenCanvas); tests pass a fake. */
  encodeSprite(image: RasterImage, quality: number): Promise<Uint8Array>;
  /** Wait this long after the last assembly before sending the preview by itself (default 1500 ms). */
  previewDelayMs?: number;
  /** Timers (injected in tests). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** Called when the counters change. */
  onChange?(): void;
}

export interface PhoneScanCounters {
  /** Photos received from the phone. */
  received: number;
  scanning: number;
  done: number;
  failed: number;
  /** Photos waiting for / in a scan run. */
  pending: number;
  previewSent: number;
}

interface Known {
  id: number;
  name: string;
  state: PhotoState;
  last: string;
}

export class PhoneScanController {
  private queue: Incoming[] = [];
  private known = new Map<number, Known>();
  private running = false;
  private disposed = false;
  private previewTimer: unknown = null;
  private previewSender: ChunkSender | null = null;
  private previewId = 0;
  private previewSent = 0;
  private wantPreview = false;
  private lastSummary = '';

  constructor(private o: ControllerOptions) {}

  get counters(): PhoneScanCounters {
    const c: PhoneScanCounters = { received: this.known.size, scanning: 0, done: 0, failed: 0, pending: this.queue.length, previewSent: this.previewSent };
    for (const k of this.known.values()) {
      if (k.state === 'scanning') c.scanning++;
      else if (k.state === 'done') c.done++;
      else if (k.state === 'failed') c.failed++;
    }
    if (this.running) c.pending = Math.max(c.pending, c.scanning);
    return c;
  }

  private status(msg: ScanStatusMsg): void {
    const k = this.known.get(msg.id);
    if (k) {
      const sig = JSON.stringify(msg);
      if (k.last === sig) return; // nothing new for the phone
      k.last = sig;
      k.state = msg.state;
    }
    this.o.send({ ...msg });
    this.o.onChange?.();
  }

  /** A photo finished arriving: queue it for the scan pool. */
  receive(item: Incoming): void {
    if (this.disposed || this.known.has(item.id)) return;
    this.known.set(item.id, { id: item.id, name: item.file.name, state: 'received', last: '' });
    this.status({ type: 'scan-status', id: item.id, state: 'received' });
    this.queue.push(item);
    void Promise.resolve().then(() => this.run()); // photos handed over together (or arriving in the same tick) go into one run
  }

  /** Scan everything that is queued, in as few runs as possible (photos that arrive during a run join the next one). */
  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.o.busy?.(true);
    this.o.onChange?.();
    try {
      while (this.queue.length && !this.disposed) {
        const batch = this.queue.splice(0);
        await this.scanBatch(batch);
      }
    } finally {
      this.running = false;
      this.o.busy?.(false);
      this.o.onChange?.();
    }
    if (!this.disposed) {
      this.sendSummary();
      this.schedulePreview();
    }
  }

  private async scanBatch(batch: Incoming[]): Promise<void> {
    const files = batch.map((b) => b.file);
    const byName = new Map(batch.map((b) => [b.file.name, b.id]));
    const ui = this.o.hooks?.();
    const hooks: ScanProgressHooks = {
      signal: ui?.signal,
      onProgress: (e: ScanProgressEvent) => {
        ui?.onProgress?.(e);
        const id = byName.get(e.fileName);
        if (id !== undefined && e.state === 'scanning') this.status({ type: 'scan-status', id, state: 'scanning' });
      },
    };
    const options = this.o.analyzeOptions?.();
    const cur = this.o.current();
    let result: ScanResult;
    let mode: 'append' | 'fresh' = 'append';
    let adoptFiles = files;
    try {
      if (cur && this.o.scan.append) result = await this.o.scan.append(cur, files, options, hooks);
      else if (cur) {
        adoptFiles = [...(this.o.previousFiles?.() ?? []), ...files];
        mode = 'fresh';
        result = await this.o.scan.analyze(adoptFiles, options, hooks);
      } else {
        mode = 'fresh';
        result = await this.o.scan.analyze(files, options, hooks);
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      for (const b of batch) this.status({ type: 'scan-status', id: b.id, state: 'failed', note: aborted ? 'The scan was canceled on the computer.' : `The scan failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), retake: !aborted });
      return;
    }
    await this.o.adopt(result, adoptFiles, mode);
    this.statusesFrom(result, batch.map((b) => b.id));
  }

  /** Statuses of every known photo from the (new) result: a later photo can change an earlier one (a better duplicate). */
  private statusesFrom(result: ScanResult, batchIds: number[]): void {
    const total = result.report.pageCount;
    for (const k of this.known.values()) {
      const page = result.report.pages.find((p) => p.fileName === k.name);
      if (!page && !batchIds.includes(k.id)) continue; // still queued for a later run
      this.status(statusForPage(k.id, page, total));
    }
  }

  sendSummary(): void {
    const s = summaryOf(this.o.current(), this.running || this.queue.length > 0);
    const sig = JSON.stringify(s);
    if (sig === this.lastSummary) return;
    this.lastSummary = sig;
    this.o.send({ ...s });
  }

  /** The phone pressed Done (or the person pressed "Send preview to phone"): send the preview as soon as nothing is being scanned. */
  requestPreview(): void {
    this.wantPreview = true;
    this.sendSummary();
    if (!this.running && !this.queue.length) void this.sendPreview();
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.previewTimer as never);
    this.previewTimer = (this.o.setTimer ?? setTimeout)(() => {
      this.previewTimer = null;
      if (!this.disposed && !this.running && !this.queue.length) void this.sendPreview();
    }, this.o.previewDelayMs ?? 1500);
  }

  /** Build and send the preview of the current result. Resolves false when there is nothing to show. */
  async sendPreview(): Promise<boolean> {
    this.wantPreview = false;
    const result = this.o.current();
    if (!result || this.disposed) return false;
    const have = result.frames.filter((f) => f).length;
    if (!have) return false;
    const sample = result.frames.find((f) => f)!;
    const total = Math.max(result.report.totalFrames, result.frames.length);
    const fps = result.report.fps || 12;
    const plan = planPreview(total, sample.width, sample.height, fps);
    const packed = packSprite(
      result.frames.map((f) => (f ? { width: f.width, height: f.height, data: f.data } : null)),
      plan,
    );
    const bytes = await this.o.encodeSprite(packed.image, PREVIEW_JPEG_QUALITY);
    if (this.disposed) return false;
    const meta = previewMeta(plan, result.report.missingFrames.map((n) => n + 1), result.report.missingPages.map((n) => n + 1));
    this.previewSender?.cancel();
    this.previewId = (this.previewId % 0xfffffff) + 1;
    const now = Date.now();
    const sender = new ChunkSender({
      prefix: 'preview',
      id: this.previewId,
      name: 'preview.jpg',
      mime: 'image/jpeg',
      w: packed.image.width,
      h: packed.image.height,
      bytes,
      extra: { ...meta },
      chunkBytes: PHOTO_LIMITS.chunkBytes,
      window: PHOTO_LIMITS.window,
      transport: { sendJson: (m) => this.o.send(m), sendChunk: (f) => this.o.sendBinary(f), buffered: () => this.o.buffered() },
      onDone: () => {
        this.previewSent++;
        this.o.onChange?.();
      },
    });
    this.previewSender = sender;
    sender.start(now);
    return true;
  }

  /** A `preview-*` message from the phone (acks, naks, refusals). */
  handlePreviewMessage(msg: Record<string, unknown>, now: number): void {
    this.previewSender?.onMessage(msg, now);
    this.previewSender?.pump();
  }

  /** The phone (re)joined the link: it may have lost the preview. */
  onPhoneReady(): void {
    this.sendSummary();
  }

  /** Drive timeouts of the preview transfer. */
  tick(now: number): void {
    this.previewSender?.tick(now);
  }

  dispose(): void {
    this.disposed = true;
    if (this.previewTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.previewTimer as never);
    this.previewSender?.cancel();
    this.queue = [];
  }
}

/* ----------------------------------------------- session ----------------------------------------------- */

export interface StoreDeps {
  sendJson(token: string, msg: Record<string, unknown>): void;
  sendBinary(token: string, bytes: Uint8Array): void;
  buffered(token: string): number;
  now?(): number;
  /** Start the periodic tick (default: setInterval). Tests pass false and call `tick`. */
  autoTick?: boolean;
}

export interface PhoneScanInfo {
  /** The phone said it is in scan mode (or sent a photo). */
  active: boolean;
  /** Photos received in total, and how they stand. */
  received: number;
  scanning: number;
  done: number;
  failed: number;
  /** A Scan tab is attached and takes the photos. */
  attached: boolean;
  /** Photos waiting because no Scan tab is open. */
  waiting: number;
  bytes: number;
  previewSent: number;
  /** A preview can be sent now. */
  canPreview: boolean;
}

export class PhoneScanSession {
  private receiver: TransferReceiver;
  controller: PhoneScanController | null = null;
  private waiting: Incoming[] = [];
  active = false;
  fps = 12;
  private receivedNames = 0;

  constructor(readonly token: string, private deps: StoreDeps, private notify: () => void) {
    this.receiver = new TransferReceiver({
      prefix: 'scan',
      limits: PHOTO_LIMITS,
      allowed: PHOTO_TYPES,
      send: (m) => deps.sendJson(token, m),
      onComplete: (d) => this.onComplete(d),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private onComplete(d: CompletedTransfer): void {
    this.active = true;
    this.receivedNames++;
    // The bytes were checked against the declared type and length; the file is only ever decoded by the scan pipeline's safe path.
    const file = new File([d.bytes as BlobPart], d.name, { type: d.mime });
    const item: Incoming = { id: d.id, file };
    if (this.controller) this.controller.receive(item);
    else {
      this.waiting.push(item);
      this.deps.sendJson(this.token, { type: 'scan-status', id: d.id, state: 'received' });
    }
    this.notify();
  }

  /** The phone says it is in scan mode: tell it the limits. */
  phoneIsScanning(): void {
    this.active = true;
    this.deps.sendJson(this.token, { type: 'scan-ready', v: SCAN_VERSION, limits: { maxBytes: PHOTO_LIMITS.maxBytes, maxSessionBytes: PHOTO_LIMITS.maxSessionBytes, maxCount: PHOTO_LIMITS.maxCount, chunkBytes: PHOTO_LIMITS.chunkBytes, window: PHOTO_LIMITS.window }, fps: this.fps });
    this.controller?.onPhoneReady();
    this.notify();
  }

  json(msg: { type?: unknown; [k: string]: unknown }): void {
    const t = typeof msg.type === 'string' ? msg.type : '';
    if (t.startsWith('scan-') && t !== 'scan-done') {
      this.receiver.handleJson(msg, this.now());
    } else if (t === 'scan-done') {
      this.controller?.requestPreview();
    } else if (t.startsWith('preview-')) {
      this.controller?.handlePreviewMessage(msg as Record<string, unknown>, this.now());
    }
  }

  binary(data: ArrayBuffer | Uint8Array): void {
    const f = parseChunkFrame(data);
    if (f) this.receiver.handleChunk(f, this.now());
  }

  tick(now: number): void {
    this.receiver.sweep(now);
    this.controller?.tick(now);
  }

  attach(c: PhoneScanController): void {
    this.controller?.dispose();
    this.controller = c;
    const items = this.waiting.splice(0);
    for (const i of items) c.receive(i);
    this.notify();
  }

  detach(c: PhoneScanController): void {
    if (this.controller === c) this.controller = null;
    c.dispose();
    this.notify();
  }

  info(): PhoneScanInfo {
    const c = this.controller?.counters;
    const st = this.receiver.stats;
    return {
      active: this.active,
      received: this.receivedNames,
      scanning: c?.scanning ?? 0,
      done: c?.done ?? 0,
      failed: c?.failed ?? 0,
      attached: !!this.controller,
      waiting: this.waiting.length,
      bytes: st.bytes,
      previewSent: c?.previewSent ?? 0,
      canPreview: !!this.controller,
    };
  }
}

export class PhoneScanStore {
  private sessions = new Map<string, PhoneScanSession>();
  private listeners = new Set<(token: string) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: StoreDeps) {}

  /** Is this a message the scan code handles (so the link code does not treat it as camera / sensor data)? */
  static handles(type: unknown): boolean {
    return typeof type === 'string' && SCAN_TYPES.has(type);
  }
  static handlesBinary(data: ArrayBuffer | Uint8Array): boolean {
    return isScanFrame(data);
  }

  session(token: string): PhoneScanSession {
    let s = this.sessions.get(token);
    if (!s) {
      s = new PhoneScanSession(token, this.deps, () => this.emit(token));
      this.sessions.set(token, s);
      if (!this.timer && this.deps.autoTick !== false) this.timer = setInterval(() => this.tick((this.deps.now ?? Date.now)()), 200);
    }
    return s;
  }

  has(token: string): boolean {
    return this.sessions.has(token);
  }

  ingestJson(token: string, msg: { type?: unknown; [k: string]: unknown }): void {
    this.session(token).json(msg);
  }

  ingestBinary(token: string, data: ArrayBuffer | Uint8Array): void {
    this.session(token).binary(data);
  }

  /** The phone's hello said scan mode. */
  phoneIsScanning(token: string): void {
    this.session(token).phoneIsScanning();
  }

  /**
   * The Scan tab starts taking this phone's photos. Returns the controller and a function that detaches it.
   * Photos that arrived before the tab was ready are handed over now.
   */
  attach(token: string, o: Omit<ControllerOptions, 'send' | 'sendBinary' | 'buffered'>): { controller: PhoneScanController; detach: () => void } {
    const session = this.session(token);
    const controller = new PhoneScanController({ ...o, send: (m) => this.deps.sendJson(token, m), sendBinary: (b) => this.deps.sendBinary(token, b), buffered: () => this.deps.buffered(token), onChange: () => { o.onChange?.(); this.emit(token); } });
    session.attach(controller);
    return { controller, detach: () => session.detach(controller) };
  }

  info(token: string): PhoneScanInfo | null {
    return this.sessions.get(token)?.info() ?? null;
  }

  subscribe(token: string, listener: (token: string) => void): () => void {
    const l = (t: string) => t === token && listener(t);
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(token: string): void {
    for (const l of [...this.listeners]) l(token);
  }

  tick(now: number): void {
    for (const s of this.sessions.values()) s.tick(now);
  }

  drop(token: string): void {
    const s = this.sessions.get(token);
    s?.controller?.dispose();
    this.sessions.delete(token);
    if (!this.sessions.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit(token);
  }
}

/** Browser glue for the preview sprite: JPEG bytes through an OffscreenCanvas. */
export async function encodeSpriteJpeg(image: RasterImage, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}
