/**
 * The phone's side of "3D scan with a linked phone": a small queue that sends each kept photo to the computer, one at a time, over the
 * chunked, acknowledged transfer (scan-transfer.ts). Pure: no sockets and no timers (the caller passes `now` and calls `tick`).
 *
 *  - Back-pressure: `held()` is the number of photos waiting or being sent; the scan session stops taking photos while it is at the limit
 *    (SCAN3D_MAX_HELD, counting photos still being encoded too), so the phone never keeps more than a few photos in memory. A photo's
 *    bytes are dropped the moment the computer confirms it.
 *  - Resume: after a reconnect `onOpen()` starts the photo at the head of the queue again; the computer answers with how far it got (or
 *    that it has the whole photo) and the transfer continues from there. A photo is identified by its number in the scan, so a repeat is
 *    never stored twice.
 *  - Integrity: every photo ends with its length and CRC-32; the computer refuses a damaged copy and the sender starts that photo over.
 *  - The end: `finish()` waits until every photo is confirmed, then sends `scan3d-done` (repeated until the computer says `scan3d-finished`).
 */
import type { ScanShot } from '../engine/lib/scan-data';
import { SCAN3D_LIMITS, SCAN3D_VERSION, parseFinished, type Scan3dFinishedMsg, type ScanHeader } from './scan3d-protocol';
import { ChunkSender } from './scan-transfer';

export interface UploaderEnv {
  sendJson(msg: Record<string, unknown>): void;
  sendBinary(bytes: Uint8Array): void;
  buffered(): number;
  isOpen(): boolean;
}

interface Item {
  index: number;
  shot: Omit<ScanShot, 'asset'>;
  bytes: Uint8Array;
}

export interface UploaderState {
  /** Photos confirmed by the computer. */
  sent: number;
  /** Photos waiting or on the way. */
  held: number;
  /** Fraction (0..1) of the photo on the way. */
  fraction: number;
  /** Photos the computer refused for good. */
  refused: number;
  /** The last refusal in words, or null. */
  note: string | null;
  finished: Scan3dFinishedMsg | null;
}

export class Scan3dUploader {
  private queue: Item[] = [];
  private sender: ChunkSender | null = null;
  private sent = 0;
  private refused = 0;
  private note: string | null = null;
  private chunkBytes: number = SCAN3D_LIMITS.chunkBytes;
  private window: number = SCAN3D_LIMITS.window;
  private done: { header: ScanHeader; count: number; depthShots: number; last: number } | null = null;
  private finished: Scan3dFinishedMsg | null = null;
  /** Largest queue length ever seen (tests read it to prove the memory bound). */
  peakHeld = 0;
  private clock = 0;

  constructor(
    private env: UploaderEnv,
    readonly sid: number,
    private onChange: () => void = () => undefined,
  ) {}

  held(): number {
    return this.queue.length;
  }

  state(): UploaderState {
    return { sent: this.sent, held: this.queue.length, fraction: this.sender?.fraction ?? 0, refused: this.refused, note: this.note, finished: this.finished };
  }

  /** The computer's limits (from `scan3d-ready`). */
  setLimits(chunkBytes: number, window: number): void {
    this.chunkBytes = chunkBytes;
    this.window = window;
  }

  /** A photo was kept. Its bytes stay here until the computer confirms it. */
  enqueue(index: number, shot: Omit<ScanShot, 'asset'>, bytes: Uint8Array, now: number): void {
    this.clock = now;
    this.queue.push({ index, shot, bytes });
    this.peakHeld = Math.max(this.peakHeld, this.queue.length);
    this.next(now);
    this.onChange();
  }

  /** Every photo is in; tell the computer when they are all confirmed. */
  finish(header: ScanHeader, count: number, depthShots: number, now: number): void {
    this.done = { header, count, depthShots, last: -1e9 };
    this.maybeDone(now);
  }

  private head(): Item | undefined {
    return this.queue[0];
  }

  private next(now: number): void {
    if (this.sender || !this.env.isOpen()) return;
    const item = this.head();
    if (!item) return;
    const sender = new ChunkSender({
      prefix: 'scan3d',
      id: item.index + 1,
      name: `shot-${String(item.index + 1).padStart(4, '0')}.jpg`,
      mime: 'image/jpeg',
      w: item.shot.w,
      h: item.shot.h,
      bytes: item.bytes,
      extra: { sid: this.sid, shot: item.shot, v: SCAN3D_VERSION },
      chunkBytes: this.chunkBytes,
      window: this.window,
      maxBuffered: 512 * 1024,
      transport: { sendJson: (m) => this.env.sendJson(m), sendChunk: (f) => this.env.sendBinary(f), buffered: () => this.env.buffered() },
      onDone: () => {
        if (this.sender !== sender) return;
        this.sender = null;
        this.queue.shift(); // the bytes are let go as soon as the computer has them
        this.sent++;
        this.next(this.clock);
        this.maybeDone(this.clock);
        this.onChange();
      },
      onFail: (reason, code) => {
        if (this.sender !== sender) return;
        this.sender = null;
        if (code === 'stalled') {
          this.note = reason; // the computer went quiet: the next tick or reconnect starts this photo again
          this.onChange();
          return;
        }
        this.queue.shift();
        this.refused++;
        this.note = `Photo ${item.index + 1} was refused: ${reason}`;
        this.next(this.clock);
        this.maybeDone(this.clock);
        this.onChange();
      },
    });
    this.sender = sender;
    sender.start(now);
  }

  private maybeDone(now: number): void {
    const d = this.done;
    if (!d || this.queue.length || this.finished || !this.env.isOpen()) return;
    d.last = now;
    this.env.sendJson({ type: 'scan3d-done', sid: this.sid, count: d.count, scan: d.header, depthShots: d.depthShots });
  }

  /** A message from the computer. Returns true when it was one of ours. */
  onMessage(msg: { type?: unknown; id?: unknown }, now: number): boolean {
    this.clock = now;
    const t = typeof msg.type === 'string' ? msg.type : '';
    if (!t.startsWith('scan3d-')) return false;
    if (t === 'scan3d-finished') {
      const f = parseFinished(msg);
      if (f && f.sid === this.sid) {
        this.finished = f;
        this.onChange();
      }
      return true;
    }
    this.sender?.onMessage(msg as never, now);
    return true;
  }

  /** About every 250 ms. */
  tick(now: number): void {
    this.clock = now;
    if (!this.env.isOpen()) return;
    if (!this.sender) this.next(now);
    this.sender?.tick(now);
    if (this.done && !this.queue.length && !this.finished && now - this.done.last > 3000) this.maybeDone(now);
  }

  /** The socket dropped: the transfer waits. */
  onClose(): void {
    this.sender?.pause();
  }

  /** The socket is back: start the head photo again (the computer says where to continue). */
  onOpen(now: number): void {
    this.clock = now;
    if (this.sender) this.sender.start(now);
    else this.next(now);
    if (this.done && !this.queue.length && !this.finished) this.maybeDone(now);
  }

  /** Give up (the scan was closed). */
  cancel(): void {
    this.sender?.cancel();
    this.sender = null;
    this.queue = [];
  }
}
