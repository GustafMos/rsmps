/**
 * "3D scan with a linked phone", computer side. A phone in `scan3d` mode walks round an object and sends, over the phone link, each kept
 * photo with its camera position (chunked, acknowledged, checksummed: see scan3d-protocol.ts and scan-transfer.ts) and small live
 * numbers (coverage, the map, the advice line). This store keeps what arrives, per pairing token, and nothing else: writing it into the
 * project (Media and the 3D Scan node) is done by ui/store/scan3dLink.ts so that it is ONE undo step.
 *
 * Received photos are untrusted: size, count, type and checksum are checked by the receiver, every number of a shot record is validated,
 * and the bytes are only ever stored (as ordinary Media files later), never run.
 */
import { coverageOf } from '../engine/lib/scan-coverage';
import type { ScanData, ScanShot } from '../engine/lib/scan-data';
import { isScan3dFrame, SCAN3D_LIMITS, SCAN3D_TYPES, SCAN3D_VERSION, checkShotBegin, parseDone, parseSceneHeader, parseStatus, parseSupport, shotBeginOf, isSid, type Scan3dDoneMsg, type Scan3dStatusMsg, type Scan3dSupportMsg, type ScanHeader } from '../phone/scan3d-protocol';
import { PHOTO_TYPES, parseChunkFrame } from '../phone/scan-protocol';
import { TransferReceiver, type CompletedTransfer } from '../phone/scan-transfer';

export interface Scan3dShot {
  /** 0-based number of the photo in the scan. */
  index: number;
  shot: Omit<ScanShot, 'asset'>;
  bytes: Uint8Array;
}

export type Scan3dPhase =
  /** Nothing from the phone yet. */
  | 'idle'
  /** The phone is placing the dome or walking. */
  | 'scanning'
  /** The phone pressed Done and the last photos are arriving. */
  | 'finishing'
  /** Everything arrived (the phone's done message and all its photos). */
  | 'complete';

export interface Scan3dInfo {
  phase: Scan3dPhase;
  sid: number | null;
  /** The phone's browser can/cannot do AR (and why). */
  support: Scan3dSupportMsg | null;
  /** Photos received here. */
  received: number;
  /** Photos the phone says it has kept so far (the "of" in "12 of 15 photos received"). */
  kept: number;
  /** The phone's last live numbers. */
  status: Scan3dStatusMsg | null;
  header: ScanHeader | null;
  /** The phone's final message, when it arrived. */
  done: Scan3dDoneMsg | null;
  /** The link to the phone is down right now. */
  linkLost: boolean;
  /** Bytes received so far. */
  bytes: number;
}

export interface Scan3dDeps {
  sendJson(token: string, msg: Record<string, unknown>): void;
  sendBinary?(token: string, bytes: Uint8Array): void;
  now?(): number;
}

/** What the project gets: the scan header with the photos, in order. */
export interface Scan3dResult {
  header: ScanHeader;
  shots: Scan3dShot[];
  /** True when the phone's final message arrived and every photo it announced is here. */
  complete: boolean;
  /** Photos the phone announced that never arrived (0 when complete). */
  missing: number;
  depthShots: number;
}

/** One phone's scan. Pure apart from `deps.sendJson`. */
export class PhoneScan3dSession {
  private sid: number | null = null;
  private receiver!: TransferReceiver;
  private shots = new Map<number, Scan3dShot>();
  private begins = new Map<number, NonNullable<ReturnType<typeof shotBeginOf>>>();
  private _support: Scan3dSupportMsg | null = null;
  private _status: Scan3dStatusMsg | null = null;
  private _header: ScanHeader | null = null;
  private _done: Scan3dDoneMsg | null = null;
  private _lost = false;
  private bytes = 0;

  constructor(
    readonly token: string,
    private deps: Scan3dDeps,
    private changed: () => void,
  ) {
    this.fresh();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private fresh(): void {
    this.shots.clear();
    this.begins.clear();
    this._status = null;
    this._header = null;
    this._done = null;
    this.bytes = 0;
    this.receiver = new TransferReceiver({
      prefix: 'scan3d',
      limits: SCAN3D_LIMITS,
      allowed: PHOTO_TYPES,
      send: (m) => this.deps.sendJson(this.token, m),
      checkBegin: (b) => {
        const err = checkShotBegin(b);
        if (!err) this.begins.set(b.id, shotBeginOf(b)!);
        return err;
      },
      onComplete: (d) => this.complete(d),
    });
  }

  /** A message with a scan number we do not know starts a new scan; whatever the old one held is dropped. */
  private adopt(sid: number): void {
    if (this.sid === sid) return;
    this.sid = sid;
    this.fresh();
  }

  private complete(d: CompletedTransfer): void {
    const b = this.begins.get(d.id);
    if (!b || this.shots.has(b.index)) return; // a repeat of a photo we have: nothing to store twice
    this.shots.set(b.index, { index: b.index, shot: b.shot, bytes: d.bytes });
    this.bytes += d.bytes.length;
    this.changed();
  }

  /** The phone said hello in scan3d mode: tell it what is allowed. */
  ready(): void {
    this._lost = false;
    this.deps.sendJson(this.token, { type: 'scan3d-ready', v: SCAN3D_VERSION, limits: { chunkBytes: SCAN3D_LIMITS.chunkBytes, window: SCAN3D_LIMITS.window, maxCount: SCAN3D_LIMITS.maxCount } });
    this.changed();
  }

  /** The link to the phone dropped or came back. */
  setLinkLost(lost: boolean): void {
    if (this._lost === lost) return;
    this._lost = lost;
    this.changed();
  }

  /** Ask the phone to end its walk (the Stop button on the computer). */
  requestStop(): void {
    this.deps.sendJson(this.token, { type: 'scan3d-stop' });
  }

  /** Forget everything (the person started over). */
  reset(): void {
    this.sid = null;
    this.fresh();
    this._support = null;
    this._lost = false;
    this.changed();
  }

  handleJson(msg: { type?: string; [key: string]: unknown }): void {
    const t = msg.type;
    if (t === 'scan3d-support') {
      this._support = parseSupport(msg);
      this.changed();
      return;
    }
    if (t === 'scan3d-begin' || t === 'scan3d-end' || t === 'scan3d-chunk') {
      const sidHere = t === 'scan3d-begin' && isSid(msg.sid) ? msg.sid : this.sid;
      if (t === 'scan3d-begin' && sidHere !== null) this.adopt(sidHere);
      const id = (msg as { id?: unknown }).id;
      // a photo we already hold (the answer got lost, or the phone resent after a reconnect): say "ok" again, store nothing
      if (typeof id === 'number' && this.shots.has(id - 1)) {
        this.deps.sendJson(this.token, { type: 'scan3d-ok', id });
        return;
      }
      this.receiver.handleJson(msg, this.now());
      return;
    }
    if (t === 'scan3d-header') {
      const h = parseSceneHeader(msg);
      if (!h) return;
      this.adopt(h.sid);
      this._header = { v: 1, units: 'm', target: h.target, grid: h.grid };
      this.changed();
    } else if (t === 'scan3d-status') {
      const s = parseStatus(msg);
      if (!s) return;
      this.adopt(s.sid);
      this._status = s;
      this.changed();
    } else if (t === 'scan3d-done') {
      const d = parseDone(msg);
      if (!d) return;
      this.adopt(d.sid);
      this._done = d;
      this._header = d.scan;
      const missing = this.missingCount();
      this.deps.sendJson(this.token, { type: 'scan3d-finished', sid: d.sid, count: d.count, received: this.shots.size, ok: missing === 0, ...(missing ? { note: `${missing} photo${missing === 1 ? '' : 's'} did not arrive.` } : {}) });
      this.changed();
    }
  }

  /** A binary photo chunk. */
  handleBinary(data: ArrayBuffer | Uint8Array): void {
    const f = parseChunkFrame(data);
    if (!f) return;
    if (this.shots.has(f.id - 1)) {
      this.deps.sendJson(this.token, { type: 'scan3d-ok', id: f.id });
      return;
    }
    this.receiver.handleChunk(f, this.now());
  }

  private missingCount(): number {
    const d = this._done;
    if (!d) return 0;
    let n = 0;
    for (let i = 0; i < d.count; i++) if (!this.shots.has(i)) n++;
    return n;
  }

  get info(): Scan3dInfo {
    const s = this._status;
    const phase: Scan3dPhase = this._done ? (this.missingCount() === 0 ? 'complete' : 'finishing') : s || this.shots.size || this._header ? 'scanning' : 'idle';
    return {
      phase,
      sid: this.sid,
      support: this._support,
      received: this.shots.size,
      kept: Math.max(s?.kept ?? 0, this._done?.count ?? 0, this.shots.size),
      status: s,
      header: this._header,
      done: this._done,
      linkLost: this._lost,
      bytes: this.bytes,
    };
  }

  /** The photos in order, with the scan header. Null when no dome was ever reported (then the photos cannot be placed). */
  result(): Scan3dResult | null {
    const header = this._header;
    if (!header || !this.shots.size) return null;
    const shots = [...this.shots.values()].sort((a, b) => a.index - b.index);
    const missing = this._done ? this.missingCount() : 0;
    return { header: this._done?.scan ?? header, shots, complete: !!this._done && missing === 0, missing, depthShots: shots.filter((s) => s.shot.depth).length };
  }

  /** The coverage worked out here from the received shots (0..1): the cross-check of the phone's own number. */
  recomputedCoverage(): number | null {
    const r = this.result();
    if (!r) return null;
    const scan: ScanData = { ...r.header, shots: r.shots.map((s) => ({ ...s.shot, asset: `s${s.index}` })) };
    return coverageOf(scan).fraction;
  }

  /** Photos received, then dropped from memory (after the project holds them). */
  release(): void {
    this.shots.clear();
    this.begins.clear();
    this.bytes = 0;
  }
}

/** One per PhoneLink: a session per pairing token. */
export class PhoneScan3dStore {
  private sessions = new Map<string, PhoneScan3dSession>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(private deps: Scan3dDeps) {}

  static handles(type: unknown): boolean {
    return typeof type === 'string' && SCAN3D_TYPES.has(type);
  }
  static handlesBinary(data: ArrayBuffer | Uint8Array): boolean {
    return isScan3dFrame(data);
  }

  session(token: string): PhoneScan3dSession {
    let s = this.sessions.get(token);
    if (!s) {
      s = new PhoneScan3dSession(token, this.deps, () => this.emit(token));
      this.sessions.set(token, s);
    }
    return s;
  }
  has(token: string): boolean {
    return this.sessions.has(token);
  }
  info(token: string): Scan3dInfo | null {
    return this.sessions.get(token)?.info ?? null;
  }
  subscribe(token: string, fn: () => void): () => void {
    let set = this.listeners.get(token);
    if (!set) this.listeners.set(token, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  private emit(token: string): void {
    for (const fn of [...(this.listeners.get(token) ?? [])]) fn();
  }

  ingestJson(token: string, msg: { type?: string; [key: string]: unknown }): void {
    this.session(token).handleJson(msg);
  }
  ingestBinary(token: string, data: ArrayBuffer | Uint8Array): void {
    this.session(token).handleBinary(data);
  }
  /** The phone's hello said scan3d. */
  phoneIsScanning(token: string): void {
    this.session(token).ready();
  }
  linkLost(token: string, lost: boolean): void {
    this.sessions.get(token)?.setLinkLost(lost);
  }
  drop(token: string): void {
    this.sessions.delete(token);
    this.listeners.delete(token);
  }
}
