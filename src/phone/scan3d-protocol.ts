/**
 * "3D scan with a linked phone": the wire format between the phone page (mode `scan3d`) and the computer. Pure (no DOM, no sockets).
 *
 * Everything travels on the EXISTING pairing WebSocket. Each kept photo goes over the same chunked, acknowledged, CRC-checked transfer
 * that the paper-scan mode uses (scan-transfer.ts, message family `scan3d-*`, binary frames of kind 3): the transfer id is the shot's
 * number (index + 1) inside one scan, and the shot's record (pose, camera numbers, sharpness, time, optional depth) rides in the
 * `shot` field of the begin message. The phone sends one photo at a time, so photos arrive in order; the computer also puts them
 * back in order if anything is ever reordered and ignores a photo it already has (resend after a short disconnect is safe).
 *
 *   phone -> computer   scan3d-support  what the phone's browser can do (AR yes/no and why)
 *                       scan3d-header   {sid, target, grid}  the dome, once the walk starts (and again after a reconnect)
 *                       scan3d-status   {sid, ...}           small live numbers for the computer's panel (about 4 per second)
 *                       scan3d-begin / -chunk / -end         one photo (see scan-transfer.ts)
 *                       scan3d-done     {sid, count, scan}   the walk is over and every photo was acknowledged; carries the header
 *   computer -> phone   scan3d-ready    limits, answer to the hello
 *                       scan3d-ack / -nak / -ok / -reject    photo transfer answers
 *                       scan3d-finished {sid, count, received, ok, note}  the scan is stored (or what is missing)
 *                       scan3d-stop     the person pressed Stop on the computer: end the walk and send what there is
 *
 * `sid` is a random number chosen by the phone for each scan, so a second scan on the same link never mixes with the first.
 */
import { DEFAULT_GRID, SCAN_MAX_SHOTS, isScanData, normalizeScan, type ScanData, type ScanShot, type ScanTarget } from '../engine/lib/scan-data';
import { FRAME_SCAN3D, PHOTO_TYPES, isId, type BeginMsg, type TransferLimits } from './scan-protocol';

export { FRAME_SCAN3D };
export const SCAN3D_VERSION = 1;

/** Most photos the phone holds in memory at once (being encoded plus waiting to be sent). Capture waits when it is reached. */
export const SCAN3D_MAX_HELD = 3;

export const SCAN3D_LIMITS: TransferLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxSessionBytes: 3 * 1024 * 1024 * 1024,
  maxCount: SCAN_MAX_SHOTS,
  maxOpen: 2,
  chunkBytes: 128 * 1024,
  window: 6,
  maxSide: 8192,
  idleMs: 90_000,
};

export const SCAN3D_TYPES = new Set([
  'scan3d-support', 'scan3d-header', 'scan3d-status', 'scan3d-begin', 'scan3d-chunk', 'scan3d-end', 'scan3d-ack', 'scan3d-nak', 'scan3d-ok', 'scan3d-reject',
  'scan3d-done', 'scan3d-ready', 'scan3d-finished', 'scan3d-stop',
]);

/** True when the bytes are a scan3d photo chunk (scan magic, kind 3). */
export function isScan3dFrame(data: ArrayBuffer | Uint8Array): boolean {
  if (data.byteLength < 13) return false;
  const u = data instanceof Uint8Array ? data : new Uint8Array(data, 0, 5);
  return u[0] === 0x52 && u[1] === 0x53 && u[2] === 0x43 && u[3] === 0x4e && u[4] === FRAME_SCAN3D;
}

/* ------------------------------------------------ messages ------------------------------------------------ */

/** The part of a scan that does not depend on the photos. */
export type ScanHeader = Pick<ScanData, 'v' | 'units' | 'target' | 'grid'> & { rejected?: number };

export interface Scan3dSupportMsg {
  type: 'scan3d-support';
  /** `ok` = the phone can start an AR scan; anything else says why not (plain words in `message`). */
  state: string;
  message: string;
}
export interface Scan3dHeaderMsg {
  type: 'scan3d-header';
  sid: number;
  target: ScanTarget;
  grid: { az: number; el: number };
}
export interface Scan3dStatusMsg {
  type: 'scan3d-status';
  sid: number;
  /** aim: placing the dome; setup: dome placed; capture: walking. */
  phase: 'aim' | 'setup' | 'capture' | 'done';
  /** Photos kept on the phone, photos the computer confirmed, photos left out for blur. */
  kept: number;
  sent: number;
  rejected: number;
  /** 0..1 coverage as the phone computes it. */
  coverage: number;
  grid: { az: number; el: number };
  /** Per cell, row-major (row 0 = lowest): 0 not reachable, 1 missing, 2 thin, 3 covered. */
  cells: number[];
  guidance: string;
  depth: boolean;
  depthShots: number;
  picture: { width: number; height: number } | null;
  /** True while capture waits for photos to be sent. */
  sending: boolean;
}
export interface Scan3dDoneMsg {
  type: 'scan3d-done';
  sid: number;
  count: number;
  scan: ScanHeader;
  depthShots: number;
}
export interface Scan3dFinishedMsg {
  type: 'scan3d-finished';
  sid: number;
  count: number;
  received: number;
  ok: boolean;
  note?: string;
}

/* ------------------------------------------------ parsing ------------------------------------------------ */

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isSid = (v: unknown): v is number => isInt(v, 1, 0xffffffff);

export function parseSupport(raw: unknown): Scan3dSupportMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan3d-support' || typeof m.state !== 'string') return null;
  return { type: 'scan3d-support', state: m.state.slice(0, 40), message: typeof m.message === 'string' ? m.message.slice(0, 600) : '' };
}

/** A header (target and grid) cleaned and clamped by the same rules a saved scan gets; null when it is not a scan target. */
export function parseHeader(raw: unknown): ScanHeader | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const probe = normalizeScan({ v: 1, units: 'm', target: m.target, grid: m.grid, shots: [], ...(isNum(m.rejected) ? { rejected: m.rejected } : {}) });
  if (!isScanData({ v: 1, target: m.target })) return null; // no usable dome centre
  return { v: 1, units: 'm', target: probe.target, grid: probe.grid, ...(probe.rejected ? { rejected: probe.rejected } : {}) };
}

export function parseSceneHeader(raw: unknown): Scan3dHeaderMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan3d-header' || !isSid(m.sid)) return null;
  const h = parseHeader(m);
  return h ? { type: 'scan3d-header', sid: m.sid, target: h.target, grid: h.grid } : null;
}

export function parseStatus(raw: unknown): Scan3dStatusMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan3d-status' || !isSid(m.sid)) return null;
  const phase = m.phase === 'aim' || m.phase === 'setup' || m.phase === 'capture' || m.phase === 'done' ? m.phase : 'aim';
  const g = (m.grid ?? {}) as Record<string, unknown>;
  const az = isInt(g.az, 4, 72) ? g.az : DEFAULT_GRID.az;
  const el = isInt(g.el, 1, 24) ? g.el : DEFAULT_GRID.el;
  const cells = Array.isArray(m.cells) && m.cells.length === az * el ? m.cells.map((c) => (c === 0 || c === 1 || c === 2 || c === 3 ? c : 1)) : new Array<number>(az * el).fill(1);
  const pic = m.picture as { width?: unknown; height?: unknown } | null | undefined;
  return {
    type: 'scan3d-status',
    sid: m.sid,
    phase,
    kept: isInt(m.kept, 0, 100000) ? m.kept : 0,
    sent: isInt(m.sent, 0, 100000) ? m.sent : 0,
    rejected: isInt(m.rejected, 0, 100000) ? m.rejected : 0,
    coverage: isNum(m.coverage) ? Math.min(1, Math.max(0, m.coverage)) : 0,
    grid: { az, el },
    cells,
    guidance: typeof m.guidance === 'string' ? m.guidance.slice(0, 300) : '',
    depth: m.depth === true,
    depthShots: isInt(m.depthShots, 0, 100000) ? m.depthShots : 0,
    picture: pic && isInt(pic.width, 1, 100000) && isInt(pic.height, 1, 100000) ? { width: pic.width, height: pic.height } : null,
    sending: m.sending === true,
  };
}

export function parseDone(raw: unknown): Scan3dDoneMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan3d-done' || !isSid(m.sid) || !isInt(m.count, 0, SCAN_MAX_SHOTS * 2)) return null;
  const scan = parseHeader(m.scan);
  if (!scan) return null;
  return { type: 'scan3d-done', sid: m.sid, count: m.count, scan, depthShots: isInt(m.depthShots, 0, 100000) ? m.depthShots : 0 };
}

export function parseFinished(raw: unknown): Scan3dFinishedMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan3d-finished' || !isSid(m.sid)) return null;
  return { type: 'scan3d-finished', sid: m.sid, count: isInt(m.count, 0, 100000) ? m.count : 0, received: isInt(m.received, 0, 100000) ? m.received : 0, ok: m.ok === true, ...(typeof m.note === 'string' ? { note: m.note.slice(0, 300) } : {}) };
}

/** The shot record of a begin message: every number checked (the computer never trusts the phone). Null = not a usable shot. */
export function parseShotRecord(raw: unknown): Omit<ScanShot, 'asset'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.depth !== undefined && (typeof s.depth !== 'string' || s.depth.length > 64 * 1024)) return null;
  // the saved-scan cleaner decides what a valid shot is: it drops one with a bad pose, size or lens
  const probe = normalizeScan({ v: 1, units: 'm', target: { center: [0, 0, 0] }, shots: [{ ...s, asset: 'x' }] });
  if (probe.shots.length !== 1) return null;
  const out: Omit<ScanShot, 'asset'> = {
    t: Math.max(0, s.t as number),
    pos: [...(s.pos as [number, number, number])],
    quat: [...(s.quat as [number, number, number, number])],
    w: s.w as number,
    h: s.h as number,
    fx: s.fx as number,
    fy: s.fy as number,
    cx: s.cx as number,
    cy: s.cy as number,
    sharp: s.sharp as number,
    ...(typeof s.depth === 'string' && s.depth ? { depth: s.depth } : {}),
  };
  // every field must be a real number; the cleaner above fills defaults, this keeps only what the phone really said
  const nums = [out.t, out.w, out.h, out.fx, out.fy, out.cx, out.cy, out.sharp, ...out.pos, ...out.quat];
  return nums.every(isNum) ? out : null;
}

/** The begin message's own extras: the scan id and the shot record. */
export interface ShotBegin {
  begin: BeginMsg;
  sid: number;
  /** 0-based shot number (transfer id - 1). */
  index: number;
  shot: Omit<ScanShot, 'asset'>;
}

/** The refusal reason for a begin message that is not a valid scan3d shot, else null. Used as `checkBegin` of the receiver. */
export function checkShotBegin(b: BeginMsg): string | null {
  if (!isSid((b as { sid?: unknown }).sid)) return 'The scan number is missing.';
  if (b.mime !== PHOTO_TYPES[0]) return 'Scan photos must be JPEG.';
  if (!parseShotRecord((b as { shot?: unknown }).shot)) return 'The photo comes without a usable camera position.';
  if (!isId(b.id) || b.id > SCAN_MAX_SHOTS * 2) return 'Too many photos in one scan.';
  return null;
}

export function shotBeginOf(b: BeginMsg): ShotBegin | null {
  const shot = parseShotRecord((b as { shot?: unknown }).shot);
  const sid = (b as { sid?: unknown }).sid;
  if (!shot || !isSid(sid)) return null;
  return { begin: b, sid, index: b.id - 1, shot };
}

/** A new random scan number. */
export function newSid(rand: () => number = Math.random): number {
  return 1 + Math.floor(rand() * 0xfffffffe);
}
