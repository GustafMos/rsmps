/**
 * "Scan with phone": the wire format between the phone page (scan mode) and the computer. Everything travels on the EXISTING pairing
 * WebSocket that the dev server and the desktop app relay untouched (shared `PhoneSessions`: text and binary frames, each up to
 * 4 MiB, no other limit), so no server code knows these types.
 *
 * Photos go phone -> computer (`scan-*`), the preview animation goes computer -> phone (`preview-*`) over the same chunked,
 * acknowledged transfer (see scan-transfer.ts). Chunks are BINARY frames (13 byte header + payload); a JSON `*-chunk` with base64
 * `data` is accepted too. Binary frames starting with the magic below are never confused with the JPEG fallback frames of the camera
 * mode (those start with FF D8). The computer never trusts the phone: every field is validated here.
 */

export const SCAN_VERSION = 1;

/** First four bytes of every scan binary frame ("RSCN"). */
export const FRAME_MAGIC = [0x52, 0x53, 0x43, 0x4e] as const;
export const FRAME_HEADER = 13;
export const FRAME_PHOTO = 1;
export const FRAME_PREVIEW = 2;

/** Limits the computer enforces (and announces to the phone in `scan-ready`). */
export interface TransferLimits {
  /** Largest photo / preview in bytes. */
  maxBytes: number;
  /** Total bytes accepted in one pairing session. */
  maxSessionBytes: number;
  /** Photos accepted in one pairing session. */
  maxCount: number;
  /** Uploads that may be open at the same time. */
  maxOpen: number;
  /** Chunk payload size the sender uses (bytes). */
  chunkBytes: number;
  /** Chunks in flight before an acknowledgement is needed. */
  window: number;
  /** Photo side limits (pixels): the declared size must be plausible. */
  maxSide: number;
  /** An upload with no news for this long is dropped (ms). */
  idleMs: number;
}

export const PHOTO_LIMITS: TransferLimits = {
  maxBytes: 40 * 1024 * 1024,
  maxSessionBytes: 600 * 1024 * 1024,
  maxCount: 200,
  maxOpen: 3,
  chunkBytes: 256 * 1024,
  window: 6,
  maxSide: 20000,
  idleMs: 60_000,
};

export const PREVIEW_LIMITS: TransferLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxSessionBytes: 256 * 1024 * 1024,
  maxCount: 1000,
  maxOpen: 4,
  chunkBytes: 256 * 1024,
  window: 6,
  maxSide: 16384,
  idleMs: 60_000,
};

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
export const MIN_CHUNK = 4 * 1024;
export const MAX_CHUNK = 1024 * 1024;

/* ----------------------------------------------- messages ----------------------------------------------- */

/** Which transfer a message belongs to: photos (phone -> computer) or the preview sprite (computer -> phone). */
export type TransferPrefix = 'scan' | 'preview';

export interface BeginMsg {
  type: 'scan-begin' | 'preview-begin';
  id: number;
  name: string;
  size: number;
  /** MIME type (the message's own `type` is the discriminator, so the picture type is `mime`). */
  mime: string;
  w: number;
  h: number;
  /** Number of chunks and the chunk size (the last chunk is shorter). */
  chunks: number;
  chunk: number;
  [extra: string]: unknown;
}
export interface EndMsg {
  type: 'scan-end' | 'preview-end';
  id: number;
  /** Total byte length and CRC-32 (hex, 8 digits) of the whole file. */
  len: number;
  crc: string;
}
export interface Base64ChunkMsg {
  type: 'scan-chunk' | 'preview-chunk';
  id: number;
  seq: number;
  data: string;
}
/** Receiver -> sender: every chunk below `next` arrived; this is also the resume point. */
export interface AckMsg {
  type: 'scan-ack' | 'preview-ack';
  id: number;
  next: number;
}
/** Receiver -> sender: chunk `seq` is missing, send again from there. */
export interface NakMsg {
  type: 'scan-nak' | 'preview-nak';
  id: number;
  seq: number;
}
export interface OkMsg {
  type: 'scan-ok' | 'preview-ok';
  id: number;
}
export type RejectCode =
  | 'bad-begin'
  | 'too-big'
  | 'bad-type'
  | 'too-many'
  | 'session-full'
  | 'id-in-use'
  | 'busy'
  | 'unknown-id'
  | 'bad-chunk'
  | 'mismatch'
  | 'bad-image'
  | 'stalled';
export interface RejectMsg {
  type: 'scan-reject' | 'preview-reject';
  id: number;
  code: RejectCode;
  reason: string;
}

/** Computer -> phone, after the phone says it is in scan mode: what is allowed. */
export interface ScanReadyMsg {
  type: 'scan-ready';
  v: number;
  limits: Pick<TransferLimits, 'maxBytes' | 'maxSessionBytes' | 'maxCount' | 'chunkBytes' | 'window'>;
  /** The project's frame rate (for the phone's preview), when known. */
  fps?: number;
}

/** Where one photo is on the computer. */
export type PhotoState = 'received' | 'scanning' | 'done' | 'failed';
export interface ScanStatusMsg {
  type: 'scan-status';
  id: number;
  state: PhotoState;
  /** 1-based sheet number and 1-based inclusive frame range of the photo's sheet (state 'done'). */
  sheet?: number;
  sheets?: number;
  frames?: [number, number];
  /** Plain-words note: why it failed, or "a better photo of this sheet was kept". */
  note?: string;
  /** True when retaking the photo is the fix. */
  retake?: boolean;
}

/** Computer -> phone: where the whole animation stands (missing sheets / frames). */
export interface ScanSummaryMsg {
  type: 'scan-summary';
  /** Sheets in the printed set (0 when unknown) and the 1-based numbers of the sheets not scanned yet. */
  sheets: number;
  missingSheets: number[];
  /** 1-based frame numbers still missing (capped). */
  missingFrames: number[];
  recovered: number;
  total: number;
  fps: number;
  /** True while photos are still being scanned. */
  busy: boolean;
}

/** Phone -> computer: "Done": send me the preview. */
export interface ScanDoneMsg {
  type: 'scan-done';
}

export type ScanMessage = ScanReadyMsg | ScanStatusMsg | ScanSummaryMsg | ScanDoneMsg;

/** Preview sprite description (the extra fields of `preview-begin`). */
export interface PreviewMeta {
  /** Frames in the sprite (<= 96), grid and size of one cell in pixels. */
  count: number;
  cols: number;
  rows: number;
  fw: number;
  fh: number;
  /** Playback rate that keeps the animation's real duration (project fps scaled by the decimation). */
  fps: number;
  /** Frames in the whole animation and the step between sprite frames (1 = every frame). */
  total: number;
  step: number;
  /** 1-based numbers of frames that are missing (they show the previous drawing). */
  missingFrames: number[];
  /** 1-based sheets not scanned yet. */
  missingSheets: number[];
}

/** Type names the computer routes to the scan code (everything else is not ours). */
export const SCAN_TYPES = new Set([
  'scan-begin', 'scan-chunk', 'scan-end', 'scan-ack', 'scan-nak', 'scan-ok', 'scan-reject',
  'preview-begin', 'preview-chunk', 'preview-end', 'preview-ack', 'preview-nak', 'preview-ok', 'preview-reject',
  'scan-ready', 'scan-status', 'scan-summary', 'scan-done',
]);

/* ----------------------------------------------- helpers ----------------------------------------------- */

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const isId = (v: unknown): v is number => isInt(v, 1, 0xffffffff);

/** CRC-32 (IEEE). Incremental: pass the previous value to continue. */
let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array, prev = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = ~prev >>> 0;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
export const crcHex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A binary chunk frame: magic, kind, id, seq (big-endian), payload. */
export function encodeChunkFrame(kind: number, id: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  out.set(FRAME_MAGIC, 0);
  out[4] = kind;
  const dv = new DataView(out.buffer);
  dv.setUint32(5, id >>> 0);
  dv.setUint32(9, seq >>> 0);
  out.set(payload, FRAME_HEADER);
  return out;
}

export interface ChunkFrame {
  kind: number;
  id: number;
  seq: number;
  payload: Uint8Array;
}

/** True when the bytes start with the scan magic (cheap check used before anything else touches a binary frame). */
export function isScanFrame(data: ArrayBuffer | Uint8Array): boolean {
  const len = data.byteLength;
  if (len < FRAME_HEADER) return false;
  const u = data instanceof Uint8Array ? data : new Uint8Array(data, 0, 4);
  return FRAME_MAGIC.every((b, i) => u[i] === b);
}

export function parseChunkFrame(data: ArrayBuffer | Uint8Array): ChunkFrame | null {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!isScanFrame(u)) return null;
  const kind = u[4];
  if (kind !== FRAME_PHOTO && kind !== FRAME_PREVIEW) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  return { kind, id: dv.getUint32(5), seq: dv.getUint32(9), payload: u.subarray(FRAME_HEADER) };
}

/** What kind of picture the bytes really are (the declared type is only a claim). */
export function sniffImageType(b: Uint8Array): PhotoType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** A file name that is safe to show and to store: no path, no control characters, at most 80 characters. */
export function safeName(name: unknown, fallback: string): string {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : '';
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return clean || fallback;
}

/** Validate a begin message. Returns a cleaned copy or the reason it is refused. */
export function parseBegin(raw: unknown, prefix: TransferPrefix, limits: TransferLimits, allowed: readonly string[]): { ok: true; msg: BeginMsg } | { ok: false; code: RejectCode; reason: string } {
  const bad = (code: RejectCode, reason: string) => ({ ok: false as const, code, reason });
  if (!raw || typeof raw !== 'object') return bad('bad-begin', 'The transfer description is not valid.');
  const m = raw as Record<string, unknown>;
  if (m.type !== `${prefix}-begin`) return bad('bad-begin', 'Wrong message.');
  if (!isId(m.id)) return bad('bad-begin', 'The transfer id is not valid.');
  if (!isInt(m.size, 1, Number.MAX_SAFE_INTEGER)) return bad('bad-begin', 'The file size is not valid.');
  if (m.size > limits.maxBytes) return bad('too-big', `This file is ${(m.size / 1048576).toFixed(1)} MB; the limit is ${Math.round(limits.maxBytes / 1048576)} MB.`);
  if (typeof m.mime !== 'string' || !allowed.includes(m.mime)) return bad('bad-type', `Only ${allowed.map((t) => t.replace('image/', '')).join(', ')} pictures are accepted.`);
  if (!isInt(m.chunk, MIN_CHUNK, MAX_CHUNK)) return bad('bad-begin', 'The chunk size is not valid.');
  if (!isInt(m.chunks, 1, 1_000_000) || m.chunks !== Math.ceil(m.size / m.chunk)) return bad('bad-begin', 'The chunk count does not match the file size.');
  const w = m.w === undefined ? 0 : m.w;
  const h = m.h === undefined ? 0 : m.h;
  if (!isInt(w, 0, limits.maxSide) || !isInt(h, 0, limits.maxSide)) return bad('bad-begin', 'The picture size is not plausible.');
  return { ok: true, msg: { ...(m as object), type: `${prefix}-begin` as BeginMsg['type'], id: m.id, name: safeName(m.name, `${prefix}-${m.id}`), size: m.size, mime: m.mime, w, h, chunks: m.chunks, chunk: m.chunk } };
}

export function parseEnd(raw: unknown, prefix: TransferPrefix): EndMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== `${prefix}-end` || !isId(m.id) || !isInt(m.len, 0, Number.MAX_SAFE_INTEGER) || typeof m.crc !== 'string' || !/^[0-9a-f]{8}$/.test(m.crc)) return null;
  return { type: `${prefix}-end` as EndMsg['type'], id: m.id, len: m.len, crc: m.crc };
}

/** Parse a message the PHONE sends about the scan (status / summary are for the other direction and validated there). */
export function parseScanStatus(raw: unknown): ScanStatusMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan-status' || !isId(m.id)) return null;
  if (m.state !== 'received' && m.state !== 'scanning' && m.state !== 'done' && m.state !== 'failed') return null;
  const out: ScanStatusMsg = { type: 'scan-status', id: m.id, state: m.state };
  if (isInt(m.sheet, 1, 100000)) out.sheet = m.sheet;
  if (isInt(m.sheets, 0, 100000)) out.sheets = m.sheets;
  if (Array.isArray(m.frames) && m.frames.length === 2 && isInt(m.frames[0], 1, 1e6) && isInt(m.frames[1], 1, 1e6)) out.frames = [m.frames[0], m.frames[1]];
  if (typeof m.note === 'string') out.note = m.note.slice(0, 300);
  if (m.retake === true) out.retake = true;
  return out;
}

const intList = (v: unknown, cap: number): number[] => (Array.isArray(v) ? v.filter((x): x is number => isInt(x, 1, 1e6)).slice(0, cap) : []);

export function parseScanSummary(raw: unknown): ScanSummaryMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan-summary') return null;
  return {
    type: 'scan-summary',
    sheets: isInt(m.sheets, 0, 100000) ? m.sheets : 0,
    missingSheets: intList(m.missingSheets, 500),
    missingFrames: intList(m.missingFrames, 500),
    recovered: isInt(m.recovered, 0, 1e6) ? m.recovered : 0,
    total: isInt(m.total, 0, 1e6) ? m.total : 0,
    fps: typeof m.fps === 'number' && m.fps > 0 && m.fps <= 240 ? m.fps : 12,
    busy: m.busy === true,
  };
}

export function parseScanReady(raw: unknown): ScanReadyMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'scan-ready') return null;
  const l = (m.limits ?? {}) as Record<string, unknown>;
  const d = PHOTO_LIMITS;
  return {
    type: 'scan-ready',
    v: isInt(m.v, 0, 1000) ? m.v : SCAN_VERSION,
    limits: {
      maxBytes: isInt(l.maxBytes, 1, 1 << 30) ? l.maxBytes : d.maxBytes,
      maxSessionBytes: isInt(l.maxSessionBytes, 1, Number.MAX_SAFE_INTEGER) ? l.maxSessionBytes : d.maxSessionBytes,
      maxCount: isInt(l.maxCount, 1, 100000) ? l.maxCount : d.maxCount,
      chunkBytes: isInt(l.chunkBytes, MIN_CHUNK, MAX_CHUNK) ? l.chunkBytes : d.chunkBytes,
      window: isInt(l.window, 1, 64) ? l.window : d.window,
    },
    ...(typeof m.fps === 'number' && m.fps > 0 && m.fps <= 240 ? { fps: m.fps } : {}),
  };
}

/** Validate the preview sprite description the computer sends (the phone does not trust it either). */
export function parsePreviewMeta(raw: unknown): PreviewMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!isInt(m.count, 1, 96) || !isInt(m.cols, 1, 96) || !isInt(m.rows, 1, 96) || !isInt(m.fw, 1, 1024) || !isInt(m.fh, 1, 1024)) return null;
  if (m.cols * m.rows < m.count) return null;
  if (typeof m.fps !== 'number' || !(m.fps > 0) || m.fps > 240) return null;
  return {
    count: m.count,
    cols: m.cols,
    rows: m.rows,
    fw: m.fw,
    fh: m.fh,
    fps: m.fps,
    total: isInt(m.total, m.count, 1e6) ? m.total : m.count,
    step: isInt(m.step, 1, 1e6) ? m.step : 1,
    missingFrames: intList(m.missingFrames, 500),
    missingSheets: intList(m.missingSheets, 500),
  };
}
