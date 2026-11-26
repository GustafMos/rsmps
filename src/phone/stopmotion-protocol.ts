/**
 * Stop motion over the phone link (mode `stopmotion`): the messages, the shared settings and the reliable still transfer. Pure: no sockets,
 * no timers of its own (callers pass `now` and call `tick`), so both ends are tested together with a fake, lossy link.
 *
 * One still travels like this (every message carries `sid`, a random id of the phone page, and `n`, the shot number on that page):
 *
 *   phone                                            computer
 *   sm-begin {sid,n,size,chunks,crc,mime,w,h}  ->    checks, answers sm-ack {next} (0, or where to resume)
 *   sm-chunk {sid,n,seq,data(base64)} x window ->    FrameTransfer collects them (any order, duplicates are harmless), acks in order
 *                                              <-    sm-stored {sid,n}  once the CRC-32 and the size match AND the picture is in the project
 *                                              <-    sm-reject {sid,n,code}  (mismatch: send again, no-target / busy: wait, too-big / bad: give up)
 *
 *  - Exactly once: a shot is identified by (sid, n). A second begin or chunk for a stored shot is answered with sm-stored and changes nothing.
 *  - In order: the phone sends one shot at a time, oldest first; the computer also refuses a begin while an older shot of the same page is
 *    still arriving (`busy`), and hands pictures to the project strictly one after the other.
 *  - Resume: the computer keeps what it has across a dropped connection. After a reconnect the phone begins the same shot again and the answer
 *    tells it where to continue.
 *  - Back-pressure: the phone holds at most MAX_QUEUE pictures that the computer has not stored yet (`ShotSender.full`).
 *  - Undo: `sm-undo {sid,n}` removes shot n wherever it is (not sent yet, arriving, or already in the project) and is answered with
 *    sm-removed; the phone repeats it after a reconnect until that answer arrives.
 */
import { FrameTransfer } from '../io/stopmotion';
import { base64ToBytes, bytesToBase64, crc32, crcHex } from './scan-protocol';

export const SM_PREFIX = 'sm-';
export const CHUNK_BYTES = 48 * 1024;
/** Chunks on the way without an answer. */
export const WINDOW = 6;
/** The receiver answers every this many in-order chunks. */
export const ACK_EVERY = 3;
/** Pictures the phone keeps that the computer has not stored yet (the one on the way included). */
export const MAX_QUEUE = 3;
export const MAX_SHOT_BYTES = 48 * 1024 * 1024;
export const STILL_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const isSmType = (t: unknown): t is string => typeof t === 'string' && t.startsWith(SM_PREFIX);

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isSid = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{4,40}$/.test(v);

/* ------------------------------------------------ settings ------------------------------------------------ */

/**
 * The settings both sides show. The computer is the authority: a change made on the phone goes up as `sm-set {patch}`, the computer
 * writes it into the node, and the new full settings (with a higher `rev`) come back and replace the phone's copy.
 */
export interface SmSettings {
  rev: number;
  /** Longest side of a shot: 0 = the camera's full size. */
  maxSide: number;
  onion: boolean;
  onionStrength: number;
  onionFrames: number;
  interval: number;
  stopAfter: number;
  /** Only shown on the phone. */
  fps: number;
}

export const DEFAULT_SETTINGS: SmSettings = { rev: 0, maxSide: 0, onion: true, onionStrength: 0.4, onionFrames: 1, interval: 2, stopAfter: 0, fps: 12 };

export function cleanPatch(raw: unknown): Partial<Omit<SmSettings, 'rev'>> {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<Omit<SmSettings, 'rev'>> = {};
  if (m.maxSide === 0 || m.maxSide === 1080 || m.maxSide === 720) out.maxSide = m.maxSide;
  if (typeof m.onion === 'boolean') out.onion = m.onion;
  if (typeof m.onionStrength === 'number') out.onionStrength = clamp(num(m.onionStrength, 0.4), 0, 1);
  if (typeof m.onionFrames === 'number') out.onionFrames = clamp(Math.round(num(m.onionFrames, 1)), 1, 3);
  if (typeof m.interval === 'number') out.interval = clamp(num(m.interval, 2), 0.2, 600);
  if (typeof m.stopAfter === 'number') out.stopAfter = clamp(Math.floor(num(m.stopAfter, 0)), 0, 9999);
  if (typeof m.fps === 'number') out.fps = clamp(Math.round(num(m.fps, 12)), 1, 60);
  return out;
}

export function parseSettings(raw: unknown): SmSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'sm-settings' || !isInt(m.rev, 0, 1e9)) return null;
  return { ...DEFAULT_SETTINGS, ...cleanPatch(m), rev: m.rev };
}

export const settingsMsg = (s: SmSettings) => ({ type: 'sm-settings', ...s });

/* ------------------------------------------------ messages ------------------------------------------------ */

export type SmCommand = 'shoot' | 'auto-start' | 'auto-stop';
export const COMMANDS: readonly SmCommand[] = ['shoot', 'auto-start', 'auto-stop'];

/** What the phone tells the computer about itself now and then (the panel shows it). */
export interface SmStatus {
  /** Pictures the phone has taken that are not stored on the computer yet. */
  unsent: number;
  /** Fraction of the picture on the way (0..1), null when none. */
  progress: number | null;
  shots: number;
  auto: { running: boolean; count: number; limit: number; nextInMs: number };
  /** Plain words for what the phone is waiting for ('' when nothing). */
  note: string;
  locked: boolean;
}

export function parseStatus(raw: unknown): SmStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const a = (m.auto && typeof m.auto === 'object' ? m.auto : {}) as Record<string, unknown>;
  if (m.type !== 'sm-status') return null;
  return {
    unsent: isInt(m.unsent, 0, 1000) ? m.unsent : 0,
    progress: typeof m.progress === 'number' && Number.isFinite(m.progress) ? clamp(m.progress, 0, 1) : null,
    shots: isInt(m.shots, 0, 1e6) ? m.shots : 0,
    auto: { running: a.running === true, count: isInt(a.count, 0, 1e6) ? a.count : 0, limit: isInt(a.limit, 0, 1e6) ? a.limit : 0, nextInMs: clamp(num(a.nextInMs, 0), 0, 3_600_000) },
    note: typeof m.note === 'string' ? m.note.slice(0, 120) : '',
    locked: m.locked === true,
  };
}

/* ------------------------------------------------ sender (phone) ------------------------------------------------ */

export interface SenderTransport {
  send(msg: Record<string, unknown>): void;
  /** Bytes queued on the socket (WebSocket.bufferedAmount). */
  buffered(): number;
  isOpen(): boolean;
}

export interface OutShot {
  n: number;
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
}

interface Out extends OutShot {
  crc: string;
  total: number;
  state: 'queued' | 'begin' | 'sending';
  acked: number;
  nextSend: number;
  restarts: number;
}

export interface SenderHooks {
  onChange(): void;
  onStored(n: number): void;
  onFailed(n: number, reason: string): void;
}

export class ShotSender {
  private queue: Out[] = [];
  /** Shots the phone removed; repeated after a reconnect until the computer says sm-removed. */
  private undone = new Set<number>();
  private lastNews = 0;
  private retries = 0;
  private holdUntil = 0;
  /** Chunk messages put on the socket, repeats included (tests read it). */
  sentChunks = 0;
  /** The computer is not answering (after a few silent tries). */
  stalled = false;
  /** The computer said it cannot take pictures right now (no Stop Motion open). */
  waiting = false;

  constructor(
    readonly sid: string,
    private t: SenderTransport,
    private hooks: SenderHooks,
    private o: { chunkBytes?: number; window?: number; maxQueue?: number; maxBuffered?: number; stallMs?: number } = {},
  ) {}

  private get chunkBytes(): number {
    return this.o.chunkBytes ?? CHUNK_BYTES;
  }

  /** Pictures not stored by the computer yet. */
  get unsent(): number {
    return this.queue.length;
  }
  get full(): boolean {
    return this.queue.length >= (this.o.maxQueue ?? MAX_QUEUE);
  }
  /** Fraction of the picture on the way, null when none is. */
  get progress(): number | null {
    const c = this.queue[0];
    if (!c || c.state === 'queued') return null;
    return Math.min(1, c.acked / c.total);
  }
  /** Numbers still waiting, oldest first. */
  pending(): number[] {
    return this.queue.map((q) => q.n);
  }

  /** Add a picture. False when the queue is full (the caller must not take the picture then). */
  enqueue(shot: OutShot, now: number): boolean {
    if (this.full) return false;
    this.queue.push({ ...shot, crc: crcHex(crc32(shot.bytes)), total: Math.max(1, Math.ceil(shot.bytes.length / this.chunkBytes)), state: 'queued', acked: 0, nextSend: 0, restarts: 0 });
    this.hooks.onChange();
    this.pump(now);
    return true;
  }

  /** Remove shot n wherever it is. Always tells the computer (it may have stored it already). */
  undo(n: number, now: number): void {
    const i = this.queue.findIndex((q) => q.n === n);
    if (i >= 0) this.queue.splice(i, 1);
    this.undone.add(n);
    if (this.t.isOpen()) this.t.send({ type: 'sm-undo', sid: this.sid, n });
    this.hooks.onChange();
    this.pump(now);
  }

  /** The socket is open again (or for the first time): repeat the undo requests and start the oldest picture again. */
  onOpen(now: number): void {
    for (const n of this.undone) this.t.send({ type: 'sm-undo', sid: this.sid, n });
    const c = this.queue[0];
    if (c) c.state = 'queued';
    this.lastNews = now;
    this.pump(now);
  }

  /** The socket dropped: keep everything, resume after the reconnect. */
  onClose(): void {
    const c = this.queue[0];
    if (c) c.state = 'queued';
  }

  /** Feed a message from the computer. Returns true when it was one of ours. */
  onMessage(msg: Record<string, unknown>, now: number): boolean {
    if (!isSmType(msg.type) || msg.sid !== this.sid || !isInt(msg.n, 1, 1e9)) return false;
    const n = msg.n;
    this.lastNews = now;
    this.retries = 0;
    this.stalled = false;
    if (msg.type === 'sm-removed') {
      this.undone.delete(n);
      const i = this.queue.findIndex((q) => q.n === n);
      if (i >= 0) this.queue.splice(i, 1);
      this.hooks.onChange();
      this.pump(now);
      return true;
    }
    const i = this.queue.findIndex((q) => q.n === n);
    if (msg.type === 'sm-stored') {
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.waiting = false;
      }
      this.hooks.onStored(n);
      this.pump(now);
      return true;
    }
    const c = this.queue[0];
    if (!c || c.n !== n) return msg.type === 'sm-ack' || msg.type === 'sm-reject';
    if (msg.type === 'sm-ack' && isInt(msg.next, 0, c.total)) {
      this.waiting = false;
      if (c.state === 'begin' || c.state === 'queued') {
        c.state = 'sending';
        c.acked = msg.next;
        c.nextSend = msg.next;
      } else if (msg.next > c.acked) {
        c.acked = msg.next;
        if (c.nextSend < c.acked) c.nextSend = c.acked;
      }
      this.hooks.onChange();
      this.pump(now);
    } else if (msg.type === 'sm-reject') {
      const code = typeof msg.code === 'string' ? msg.code : '';
      if (code === 'mismatch' && c.restarts < 2) {
        c.restarts++;
        c.state = 'queued';
        c.acked = c.nextSend = 0;
        this.pump(now);
      } else if (code === 'no-target' || code === 'busy' || code === 'full') {
        c.state = 'queued';
        this.waiting = code !== 'busy';
        this.holdUntil = now + 3000;
        this.hooks.onChange();
      } else {
        this.queue.shift();
        this.hooks.onFailed(n, typeof msg.reason === 'string' ? msg.reason : 'The computer did not accept this picture.');
        this.pump(now);
      }
    }
    return true;
  }

  private pump(now: number): void {
    const c = this.queue[0];
    if (!c || !this.t.isOpen() || now < this.holdUntil) return;
    if (c.state === 'queued') {
      c.state = 'begin';
      this.lastNews = now;
      this.t.send({ type: 'sm-begin', sid: this.sid, n: c.n, size: c.bytes.length, chunks: c.total, crc: c.crc, mime: c.mime, w: c.w, h: c.h });
      return;
    }
    if (c.state !== 'sending') return;
    const win = this.o.window ?? WINDOW;
    const max = this.o.maxBuffered ?? 1024 * 1024;
    while (c.nextSend < c.total && c.nextSend - c.acked < win && this.t.buffered() < max) {
      const seq = c.nextSend++;
      const from = seq * this.chunkBytes;
      this.t.send({ type: 'sm-chunk', sid: this.sid, n: c.n, seq, data: bytesToBase64(c.bytes.subarray(from, Math.min(c.bytes.length, from + this.chunkBytes))) });
      this.sentChunks++;
    }
  }

  /** Call about every 250 ms: sends what the window allows and repeats the last step when the computer has been silent. */
  tick(now: number): void {
    if (!this.queue.length || !this.t.isOpen()) return;
    if (now < this.holdUntil) return;
    if (this.holdUntil && now >= this.holdUntil) {
      this.holdUntil = 0;
      this.lastNews = now;
    }
    this.pump(now);
    const c = this.queue[0];
    if (!c || now - this.lastNews < (this.o.stallMs ?? 4000)) return;
    this.lastNews = now;
    if (++this.retries >= 3) this.stalled = true; // never gives up: losing a shot is worse than waiting
    if (c.state === 'begin') c.state = 'queued';
    else if (c.state === 'sending') c.nextSend = c.acked;
    this.pump(now);
    this.hooks.onChange();
  }
}

/* ------------------------------------------------ receiver (computer) ------------------------------------------------ */

export interface ReceivedShot extends OutShot {
  sid: string;
}
export type SinkResult = { ok: true; asset: string } | { ok: false; code: 'no-target' | 'full' | 'too-big' | 'failed'; reason: string };

export interface ReceiverTarget {
  /** Put the picture into the project (Media and the node's shots). Called one after the other, in order. */
  add(shot: ReceivedShot): Promise<SinkResult>;
  /** Take a stored picture out of the node's shots again (the phone's Undo). */
  remove(asset: string): void;
}

interface Entry {
  state: 'active' | 'finishing' | 'stored' | 'removed';
  ft?: FrameTransfer;
  size: number;
  crc: string;
  mime: string;
  w: number;
  h: number;
  asset?: string;
  lastAck: number;
  undone?: boolean;
}

export interface ReceiverHooks {
  onProgress?(sid: string, n: number, fraction: number): void;
  onStored?(sid: string, n: number, asset: string): void;
  onRemoved?(sid: string, n: number): void;
}

export class ShotReceiver {
  private entries = new Map<string, Entry>();
  private lastN = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private send: (msg: Record<string, unknown>) => void,
    private target: () => ReceiverTarget | null,
    private hooks: ReceiverHooks = {},
    private o: { maxBytes?: number; ackEvery?: number } = {},
  ) {}

  private key = (sid: string, n: number) => `${sid}:${n}`;
  private reply(type: string, sid: string, n: number, extra: Record<string, unknown> = {}): void {
    this.send({ type, sid, n, ...extra });
  }

  /** The asset of a stored shot, for the computer's own undo. */
  assetOf(sid: string, n: number): string | null {
    return this.entries.get(this.key(sid, n))?.asset ?? null;
  }
  /** (sid, n) of the shot stored as `asset`, or null. */
  shotOfAsset(asset: string): { sid: string; n: number } | null {
    for (const [k, e] of this.entries) {
      if (e.state === 'stored' && e.asset === asset) {
        const i = k.lastIndexOf(':');
        return { sid: k.slice(0, i), n: Number(k.slice(i + 1)) };
      }
    }
    return null;
  }

  onBegin(m: Record<string, unknown>): void {
    const sid = m.sid;
    const n = m.n;
    if (!isSid(sid) || !isInt(n, 1, 1e9)) return;
    const k = this.key(sid, n);
    const have = this.entries.get(k);
    if (have) {
      if (have.state === 'stored') return this.reply('sm-stored', sid, n);
      if (have.state === 'removed') return this.reply('sm-removed', sid, n);
      if (have.state === 'active' && have.ft && have.size === m.size && have.crc === m.crc) return this.reply('sm-ack', sid, n, { next: this.next(have.ft) });
      if (have.state === 'finishing') return;
    }
    if (n <= (this.lastN.get(sid) ?? 0) && !have) return this.reply('sm-removed', sid, n); // a number the phone dropped before it arrived
    for (const [k2, e] of this.entries) {
      if (k2 !== k && k2.startsWith(`${sid}:`) && (e.state === 'active' || e.state === 'finishing') && Number(k2.slice(sid.length + 1)) < n) return this.reply('sm-reject', sid, n, { code: 'busy', reason: 'An older picture is still arriving.' });
    }
    const size = m.size;
    const chunks = m.chunks;
    const mime = typeof m.mime === 'string' && (STILL_TYPES as readonly string[]).includes(m.mime) ? m.mime : '';
    if (!isInt(size, 1, 1e9) || !isInt(chunks, 1, 100_000) || typeof m.crc !== 'string' || !/^[0-9a-f]{8}$/.test(m.crc) || !mime) return this.reply('sm-reject', sid, n, { code: 'bad', reason: 'The picture description was not valid.' });
    const ft = new FrameTransfer(k, chunks, size, this.o.maxBytes ?? MAX_SHOT_BYTES);
    if (ft.status === 'failed') return this.reply('sm-reject', sid, n, { code: 'too-big', reason: ft.error ?? 'The picture is too big.' });
    this.entries.set(k, { state: 'active', ft, size, crc: m.crc, mime, w: isInt(m.w, 0, 100_000) ? m.w : 0, h: isInt(m.h, 0, 100_000) ? m.h : 0, lastAck: 0 });
    this.prune();
    this.reply('sm-ack', sid, n, { next: 0 });
  }

  private next(ft: FrameTransfer): number {
    return ft.missing()[0] ?? ft.total;
  }

  onChunk(m: Record<string, unknown>): void {
    const sid = m.sid;
    const n = m.n;
    if (!isSid(sid) || !isInt(n, 1, 1e9) || !isInt(m.seq, 0, 100_000) || typeof m.data !== 'string') return;
    const e = this.entries.get(this.key(sid, n));
    if (!e) return;
    if (e.state === 'stored') return this.reply('sm-stored', sid, n);
    if (e.state === 'removed') return this.reply('sm-removed', sid, n);
    if (e.state !== 'active' || !e.ft) return;
    const data = base64ToBytes(m.data);
    if (!data) return;
    const had = e.ft.missing().length;
    const got = e.ft.accept(m.seq, data);
    if (e.ft.status === 'failed') {
      this.entries.delete(this.key(sid, n));
      return this.reply('sm-reject', sid, n, { code: 'mismatch', reason: e.ft.error ?? 'The picture was damaged on the way.' });
    }
    if (got === null) return;
    const next = this.next(e.ft);
    this.hooks.onProgress?.(sid, n, e.ft.progress);
    if (e.ft.status === 'complete') return this.finish(sid, n, e);
    const dup = e.ft.missing().length === had; // a repeat of a chunk we already had: the sender is catching up, tell it where we are
    if (dup || next - e.lastAck >= (this.o.ackEvery ?? ACK_EVERY)) {
      e.lastAck = next;
      this.reply('sm-ack', sid, n, { next });
    }
  }

  private finish(sid: string, n: number, e: Entry): void {
    const bytes = e.ft!.result();
    if (!bytes || crcHex(crc32(bytes)) !== e.crc) {
      this.entries.delete(this.key(sid, n));
      return this.reply('sm-reject', sid, n, { code: 'mismatch', reason: 'The picture arrived damaged. Sending it again.' });
    }
    e.state = 'finishing';
    e.ft = undefined;
    this.chain = this.chain.then(async () => {
      const tg = this.target();
      let res: SinkResult;
      try {
        res = tg ? await tg.add({ sid, n, bytes, mime: e.mime, w: e.w, h: e.h }) : { ok: false, code: 'no-target', reason: 'No Stop Motion is waiting for pictures on the computer.' };
      } catch (err) {
        res = { ok: false, code: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
      if (!res.ok) {
        this.entries.delete(this.key(sid, n));
        return this.reply('sm-reject', sid, n, { code: res.code, reason: res.reason });
      }
      if (e.undone) {
        tg?.remove(res.asset);
        e.state = 'removed';
        this.lastN.set(sid, Math.max(this.lastN.get(sid) ?? 0, n));
        this.hooks.onRemoved?.(sid, n);
        return this.reply('sm-removed', sid, n);
      }
      e.state = 'stored';
      e.asset = res.asset;
      this.lastN.set(sid, Math.max(this.lastN.get(sid) ?? 0, n));
      this.hooks.onStored?.(sid, n, res.asset);
      this.reply('sm-stored', sid, n);
    });
  }

  /** The phone's Undo. */
  onUndo(m: Record<string, unknown>): void {
    if (!isSid(m.sid) || !isInt(m.n, 1, 1e9)) return;
    this.remove(m.sid, m.n, true);
  }

  /** Shot n is gone: dropped by the phone, or removed on the computer (`fromPhone` false: no asset removal needed, the node already did it). */
  remove(sid: string, n: number, fromPhone: boolean): void {
    const k = this.key(sid, n);
    const e = this.entries.get(k);
    if (e?.state === 'finishing') {
      e.undone = true; // answered once the picture is in the project and can be taken out again
      return;
    }
    if (e?.state === 'stored' && e.asset && fromPhone) this.target()?.remove(e.asset);
    this.entries.set(k, { state: 'removed', size: 0, crc: '', mime: '', w: 0, h: 0, lastAck: 0 });
    this.lastN.set(sid, Math.max(this.lastN.get(sid) ?? 0, n));
    this.hooks.onRemoved?.(sid, n);
    this.reply('sm-removed', sid, n);
  }

  private prune(): void {
    if (this.entries.size <= 400) return;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= 300) break;
      if (e.state === 'stored' || e.state === 'removed') this.entries.delete(k);
    }
  }
}
