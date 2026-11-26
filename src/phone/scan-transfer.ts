/**
 * The chunked, acknowledged transfer used for photos (phone -> computer) and for the preview sprite (computer -> phone).
 * Pure: no sockets and no timers of its own (the caller passes a transport and calls `tick`), so it is unit-tested with a fake socket.
 *
 *  sender                                   receiver
 *  <prefix>-begin {id,name,size,...}  ->    checks size / type / caps, answers <prefix>-ack {next} (0, or the resume point)
 *  binary chunk frames, `window` ahead ->   stores them, acks every `ackEvery` in-order chunks, naks a gap
 *  <prefix>-end {id,len,crc}          ->    joins, checks length, CRC-32 and the real picture type; <prefix>-ok or <prefix>-reject
 *
 * Back-pressure: the sender never has more than `window` chunks unacknowledged and never queues more than `maxBuffered` bytes on the
 * socket (`transport.buffered()`); it is called again from `pump()` when the socket drains.
 */
import {
  frameKindOf,
  base64ToBytes,
  crc32,
  crcHex,
  encodeChunkFrame,
  parseBegin,
  parseEnd,
  sniffImageType,
  type BeginMsg,
  type ChunkFrame,
  type RejectCode,
  type TransferLimits,
  type TransferPrefix,
  isId,
} from './scan-protocol';

export interface SenderTransport {
  sendJson(msg: Record<string, unknown>): void;
  /** One binary chunk frame. */
  sendChunk(frame: Uint8Array): void;
  /** Bytes queued on the socket and not yet sent (WebSocket.bufferedAmount). */
  buffered(): number;
}

export type SenderState = 'idle' | 'begin' | 'sending' | 'ending' | 'done' | 'failed';

export interface SenderOptions {
  prefix: TransferPrefix;
  id: number;
  name: string;
  mime: string;
  w?: number;
  h?: number;
  bytes: Uint8Array;
  /** More fields for the begin message (the preview's sprite description). */
  extra?: Record<string, unknown>;
  chunkBytes: number;
  window: number;
  transport: SenderTransport;
  /** Do not queue more than this on the socket (default 1 MiB). */
  maxBuffered?: number;
  /** No news from the receiver for this long: send the unacknowledged part again (default 4000 ms). */
  stallMs?: number;
  /** Give up after this many stalls in a row (default 5). */
  maxRetries?: number;
  /** Whole-file restarts after a checksum mismatch (default 2). */
  maxRestarts?: number;
  onProgress?: (sent: number, acked: number, total: number) => void;
  onDone?: () => void;
  onFail?: (reason: string, code?: RejectCode) => void;
}

export class ChunkSender {
  state: SenderState = 'idle';
  readonly total: number;
  private acked = 0;
  private nextSend = 0;
  private highest = 0;
  private lastNews = 0;
  private retries = 0;
  private restarts = 0;
  private crc: string;
  /** Chunks put on the socket, counting repeats (tests read it). */
  sentFrames = 0;

  constructor(private o: SenderOptions) {
    this.total = Math.max(1, Math.ceil(o.bytes.length / o.chunkBytes));
    this.crc = crcHex(crc32(o.bytes));
  }

  get id(): number {
    return this.o.id;
  }

  /** 0..1 of the photo the receiver has confirmed. */
  get fraction(): number {
    return this.state === 'done' ? 1 : Math.min(1, this.acked / this.total);
  }

  /** Send the begin message. Call again after a reconnect: the receiver answers with where to resume. */
  start(now: number): void {
    if (this.state === 'done' || this.state === 'failed') return;
    this.state = 'begin';
    this.lastNews = now;
    const { o } = this;
    o.transport.sendJson({ ...(o.extra ?? {}), type: `${o.prefix}-begin`, id: o.id, name: o.name, size: o.bytes.length, mime: o.mime, w: o.w ?? 0, h: o.h ?? 0, chunks: this.total, chunk: o.chunkBytes });
  }

  /** Put as many chunks on the socket as the window and the socket's queue allow. */
  pump(): void {
    if (this.state !== 'sending') return;
    const max = this.o.maxBuffered ?? 1024 * 1024;
    while (this.nextSend < this.total && this.nextSend - this.acked < this.o.window && this.o.transport.buffered() < max) {
      const seq = this.nextSend++;
      const from = seq * this.o.chunkBytes;
      const frame = encodeChunkFrame(frameKindOf(this.o.prefix), this.o.id, seq, this.o.bytes.subarray(from, Math.min(this.o.bytes.length, from + this.o.chunkBytes)));
      this.o.transport.sendChunk(frame);
      this.sentFrames++;
      this.highest = Math.max(this.highest, this.nextSend);
    }
    this.o.onProgress?.(this.nextSend, this.acked, this.total);
  }

  /** True when `pump` stopped only because the socket's queue was full (call it again soon). */
  get blocked(): boolean {
    return this.state === 'sending' && this.nextSend < this.total && this.nextSend - this.acked < this.o.window;
  }

  /** Feed a message from the receiver. Messages about other ids are ignored. */
  onMessage(msg: { type?: unknown; id?: unknown; next?: unknown; seq?: unknown; code?: unknown; reason?: unknown }, now: number): void {
    if (msg.id !== this.o.id || this.state === 'done' || this.state === 'failed' || this.state === 'idle') return;
    const p = this.o.prefix;
    this.lastNews = now;
    this.retries = 0;
    if (msg.type === `${p}-ack` && typeof msg.next === 'number' && Number.isInteger(msg.next)) {
      const next = Math.max(0, Math.min(this.total, msg.next));
      if (this.state === 'begin') {
        this.state = 'sending';
        this.acked = next;
        this.nextSend = next; // resume where the receiver is
      } else if (next > this.acked) {
        this.acked = next;
        if (this.nextSend < this.acked) this.nextSend = this.acked;
      }
      if (this.state === 'sending' && this.acked >= this.total) this.sendEnd();
      else this.pump();
    } else if (msg.type === `${p}-nak` && typeof msg.seq === 'number' && Number.isInteger(msg.seq) && msg.seq >= 0 && msg.seq < this.total) {
      if (this.state === 'ending') this.state = 'sending';
      this.acked = Math.min(this.acked, msg.seq);
      this.nextSend = msg.seq; // go back to the missing chunk
      this.pump();
    } else if (msg.type === `${p}-ok`) {
      this.state = 'done';
      this.acked = this.total;
      this.o.onProgress?.(this.total, this.total, this.total);
      this.o.onDone?.();
    } else if (msg.type === `${p}-reject`) {
      const code = typeof msg.code === 'string' ? (msg.code as RejectCode) : undefined;
      if (code === 'mismatch' && this.restarts < (this.o.maxRestarts ?? 2)) {
        this.restarts++;
        this.acked = 0;
        this.nextSend = 0;
        this.start(now); // the receiver threw the damaged copy away: send it all again
        return;
      }
      this.fail(typeof msg.reason === 'string' ? msg.reason : 'The computer refused this photo.', code);
    }
  }

  private sendEnd(): void {
    this.state = 'ending';
    this.o.transport.sendJson({ type: `${this.o.prefix}-end`, id: this.o.id, len: this.o.bytes.length, crc: this.crc });
  }

  /** Call regularly (about every 250 ms) and when the socket drains. Handles silence: repeat the last step, give up after a few tries. */
  tick(now: number): void {
    if (this.state === 'idle' || this.state === 'done' || this.state === 'failed') return;
    if (this.state === 'sending') this.pump();
    if (now - this.lastNews < (this.o.stallMs ?? 4000)) return;
    this.lastNews = now;
    if (++this.retries > (this.o.maxRetries ?? 5)) {
      this.fail('The computer did not answer. Check that the app is still open and the Wi-Fi is fine.', 'stalled');
      return;
    }
    if (this.state === 'begin') this.start(now);
    else if (this.state === 'sending') {
      this.nextSend = this.acked; // the oldest unacknowledged chunk again, then on
      this.pump();
    } else if (this.state === 'ending') this.sendEnd();
  }

  /** The socket dropped: wait; `start()` again after the reconnect resumes. */
  pause(): void {
    if (this.state === 'sending' || this.state === 'ending') this.state = 'idle';
  }

  cancel(): void {
    if (this.state !== 'done') this.state = 'failed';
  }

  private fail(reason: string, code?: RejectCode): void {
    this.state = 'failed';
    this.o.onFail?.(reason, code);
  }
}

/* ----------------------------------------------- receiver ----------------------------------------------- */

export interface CompletedTransfer {
  id: number;
  name: string;
  mime: string;
  w: number;
  h: number;
  bytes: Uint8Array;
  /** The begin message (the preview's sprite description is in its extra fields). */
  begin: BeginMsg;
}

interface Slot {
  begin: BeginMsg;
  parts: (Uint8Array | undefined)[];
  have: number;
  /** Chunks below this are all present. */
  next: number;
  sinceAck: number;
  lastNak: number;
  lastNews: number;
  done: boolean;
  /** Bytes reserved against the session total. */
  reserved: number;
}

export interface ReceiverOptions {
  prefix: TransferPrefix;
  limits: TransferLimits;
  /** Declared types that are accepted. */
  allowed: readonly string[];
  send(msg: Record<string, unknown>): void;
  onComplete(done: CompletedTransfer): void;
  /** Extra check of the begin message (the preview's sprite description). A string = the refusal reason. */
  checkBegin?(begin: BeginMsg): string | null;
  /** Ack after this many in-order chunks (default 2). */
  ackEvery?: number;
}

export class TransferReceiver {
  private slots = new Map<number, Slot>();
  private acceptedBytes = 0;
  private acceptedCount = 0;

  constructor(private o: ReceiverOptions) {}

  get stats(): { count: number; bytes: number; open: number } {
    return { count: this.acceptedCount, bytes: this.acceptedBytes, open: [...this.slots.values()].filter((s) => !s.done).length };
  }

  private reject(id: number, code: RejectCode, reason: string): void {
    this.o.send({ type: `${this.o.prefix}-reject`, id, code, reason });
  }

  private ack(slot: Slot): void {
    slot.sinceAck = 0;
    this.o.send({ type: `${this.o.prefix}-ack`, id: slot.begin.id, next: slot.next });
  }

  private drop(slot: Slot): void {
    this.slots.delete(slot.begin.id);
    this.acceptedBytes -= slot.reserved;
    this.acceptedCount--;
  }

  /** A JSON message of this transfer's family (begin / end / base64 chunk). Anything else is ignored. */
  handleJson(msg: unknown, now: number): void {
    if (!msg || typeof msg !== 'object') return;
    const t = (msg as { type?: unknown }).type;
    const p = this.o.prefix;
    if (t === `${p}-begin`) this.begin(msg, now);
    else if (t === `${p}-end`) this.end(msg, now);
    else if (t === `${p}-chunk`) {
      const m = msg as { id?: unknown; seq?: unknown; data?: unknown };
      const bytes = typeof m.data === 'string' ? base64ToBytes(m.data) : null;
      if (!isId(m.id)) return;
      if (!bytes || typeof m.seq !== 'number') return this.reject(m.id, 'bad-chunk', 'The chunk is not valid.');
      this.chunk({ kind: frameKindOf(p), id: m.id, seq: m.seq, payload: bytes }, now);
    }
  }

  private begin(raw: unknown, now: number): void {
    const parsed = parseBegin(raw, this.o.prefix, this.o.limits, this.o.allowed);
    const id = (raw as { id?: unknown }).id;
    if (!parsed.ok) {
      if (isId(id)) this.reject(id, parsed.code, parsed.reason);
      return;
    }
    const b = parsed.msg;
    const extra = this.o.checkBegin?.(b);
    if (extra) return this.reject(b.id, 'bad-begin', extra);
    const old = this.slots.get(b.id);
    if (old) {
      const same = old.begin.size === b.size && old.begin.chunk === b.chunk && old.begin.mime === b.mime;
      if (!same) return this.reject(b.id, 'id-in-use', 'That photo number is already used by another picture.');
      if (old.done) return void this.o.send({ type: `${this.o.prefix}-ok`, id: b.id }); // the answer got lost: say it again
      old.lastNews = now;
      return this.ack(old); // reconnect: resume
    }
    if (this.acceptedCount >= this.o.limits.maxCount) return this.reject(b.id, 'too-many', `The computer accepts at most ${this.o.limits.maxCount} photos in one session.`);
    if (this.acceptedBytes + b.size > this.o.limits.maxSessionBytes) return this.reject(b.id, 'session-full', 'The computer has taken as many photos as one session allows. Start a new link.');
    if (this.stats.open >= this.o.limits.maxOpen) return this.reject(b.id, 'busy', 'The computer is still receiving other photos. Try again in a moment.');
    this.acceptedBytes += b.size;
    this.acceptedCount++;
    const slot: Slot = { begin: b, parts: new Array(b.chunks), have: 0, next: 0, sinceAck: 0, lastNak: -1, lastNews: now, done: false, reserved: b.size };
    this.slots.set(b.id, slot);
    this.ack(slot);
  }

  /** One chunk (binary frame or decoded base64). */
  handleChunk(frame: ChunkFrame, now: number): void {
    this.chunk(frame, now);
  }

  private chunk(f: ChunkFrame, now: number): void {
    const slot = this.slots.get(f.id);
    if (!slot || slot.done) {
      if (slot?.done) return this.o.send({ type: `${this.o.prefix}-ok`, id: f.id });
      return this.reject(f.id, 'unknown-id', 'This photo was not announced, or the computer dropped it.');
    }
    const b = slot.begin;
    if (!Number.isInteger(f.seq) || f.seq < 0 || f.seq >= b.chunks) return this.reject(f.id, 'bad-chunk', 'Chunk number out of range.');
    const want = f.seq === b.chunks - 1 ? b.size - (b.chunks - 1) * b.chunk : b.chunk;
    if (f.payload.length !== want) return this.reject(f.id, 'bad-chunk', 'A chunk has the wrong length.');
    slot.lastNews = now;
    if (slot.parts[f.seq]) return this.ack(slot); // a duplicate: ignore it, repeat where we are
    slot.parts[f.seq] = f.payload;
    slot.have++;
    const before = slot.next;
    while (slot.next < b.chunks && slot.parts[slot.next]) slot.next++;
    if (slot.next > before) {
      slot.sinceAck += slot.next - before;
      if (slot.sinceAck >= (this.o.ackEvery ?? 2) || slot.next >= b.chunks) this.ack(slot);
    } else if (f.seq > slot.next && slot.lastNak !== slot.next) {
      slot.lastNak = slot.next;
      this.o.send({ type: `${this.o.prefix}-nak`, id: b.id, seq: slot.next }); // a gap: ask for the missing one
    }
  }

  private end(raw: unknown, now: number): void {
    const m = parseEnd(raw, this.o.prefix);
    const id = (raw as { id?: unknown }).id;
    if (!m) {
      if (isId(id)) this.reject(id, 'bad-begin', 'The end message is not valid.');
      return;
    }
    const slot = this.slots.get(m.id);
    if (!slot) return this.reject(m.id, 'unknown-id', 'This photo was not announced, or the computer dropped it.');
    if (slot.done) return void this.o.send({ type: `${this.o.prefix}-ok`, id: m.id });
    slot.lastNews = now;
    if (slot.next < slot.begin.chunks) {
      this.o.send({ type: `${this.o.prefix}-nak`, id: m.id, seq: slot.next }); // not everything is here yet
      return;
    }
    const bytes = new Uint8Array(slot.begin.size);
    let at = 0;
    for (const part of slot.parts) {
      bytes.set(part!, at);
      at += part!.length;
    }
    if (m.len !== slot.begin.size || crcHex(crc32(bytes)) !== m.crc) {
      // damaged: throw the copy away, the sender may send it again from the start
      slot.parts = new Array(slot.begin.chunks);
      slot.have = 0;
      slot.next = 0;
      slot.sinceAck = 0;
      slot.lastNak = -1;
      return this.reject(m.id, 'mismatch', 'The photo arrived damaged (length or checksum differs).');
    }
    const real = sniffImageType(bytes);
    if (!real || (this.o.allowed.length && !this.o.allowed.includes(real)) || real !== slot.begin.mime) {
      this.drop(slot);
      return this.reject(m.id, 'bad-type', 'The file is not the kind of picture it claims to be.');
    }
    slot.done = true;
    slot.parts = [];
    this.o.send({ type: `${this.o.prefix}-ok`, id: m.id });
    this.o.onComplete({ id: m.id, name: slot.begin.name, mime: slot.begin.mime, w: slot.begin.w, h: slot.begin.h, bytes, begin: slot.begin });
  }

  /** Drop uploads that went quiet (frees their reserved bytes). Call from a timer. */
  sweep(now: number): number[] {
    const dropped: number[] = [];
    for (const slot of [...this.slots.values()]) {
      if (!slot.done && now - slot.lastNews > this.o.limits.idleMs) {
        this.drop(slot);
        dropped.push(slot.begin.id);
      }
    }
    return dropped;
  }

  /** Forget a finished transfer's bookkeeping and give its bytes back to the session total (the bytes themselves are the caller's). The id may be reused. */
  forget(id: number): void {
    const slot = this.slots.get(id);
    if (slot?.done) {
      this.slots.delete(id);
      this.drop2(slot);
    }
  }

  private drop2(slot: Slot): void {
    this.acceptedBytes -= slot.reserved;
    this.acceptedCount--;
  }
}
