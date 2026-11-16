import { describe, expect, it } from 'vitest';
import {
  FRAME_HEADER,
  FRAME_PHOTO,
  FRAME_PREVIEW,
  PHOTO_LIMITS,
  PHOTO_TYPES,
  base64ToBytes,
  bytesToBase64,
  crc32,
  crcHex,
  encodeChunkFrame,
  isScanFrame,
  parseBegin,
  parseChunkFrame,
  parseEnd,
  parsePreviewMeta,
  parseScanReady,
  parseScanStatus,
  parseScanSummary,
  safeName,
  sniffImageType,
} from './scan-protocol';

const begin = (o: Record<string, unknown> = {}) => ({ type: 'scan-begin', id: 7, name: 'a.jpg', size: 1000, mime: 'image/jpeg', w: 4000, h: 3000, chunks: 1, chunk: 262144, ...o });

describe('scan wire format', () => {
  it('CRC-32 matches the standard check value and is incremental', () => {
    const b = new TextEncoder().encode('123456789');
    expect(crcHex(crc32(b))).toBe('cbf43926');
    expect(crc32(b.subarray(4), crc32(b.subarray(0, 4)))).toBe(crc32(b));
  });

  it('chunk frames round trip and never look like the JPEG fallback frames', () => {
    const f = encodeChunkFrame(FRAME_PHOTO, 0xdeadbeef, 42, new Uint8Array([1, 2, 3]));
    expect(f.length).toBe(FRAME_HEADER + 3);
    expect(isScanFrame(f)).toBe(true);
    expect(isScanFrame(f.buffer as ArrayBuffer)).toBe(true); // an ArrayBuffer straight from a WebSocket
    expect(isScanFrame(f.slice(0, 12))).toBe(false); // too short for a header
    expect(parseChunkFrame(f)).toMatchObject({ kind: FRAME_PHOTO, id: 0xdeadbeef, seq: 42 });
    expect(Array.from(parseChunkFrame(f.buffer as ArrayBuffer)!.payload)).toEqual([1, 2, 3]);
    const jpeg = new Uint8Array(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(isScanFrame(jpeg)).toBe(false);
    expect(parseChunkFrame(jpeg)).toBeNull();
    const badKind = f.slice();
    badKind[4] = 9;
    expect(parseChunkFrame(badKind)).toBeNull();
    expect(parseChunkFrame(encodeChunkFrame(FRAME_PREVIEW, 1, 0, new Uint8Array(0)))!.kind).toBe(FRAME_PREVIEW);
  });

  it('base64 round trips and rejects garbage', () => {
    const b = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(b))!)).toEqual(Array.from(b));
    expect(base64ToBytes('***not base64***')).toBeNull();
  });

  it('knows a real picture from a claim', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('makes file names safe', () => {
    expect(safeName('../../etc/passwd', 'x')).toBe('passwd');
    expect(safeName('C:\\Users\\me\\IMG 0001.JPG', 'x')).toBe('IMG 0001.JPG');
    expect(safeName('a<b>|c.jpg', 'x')).toBe('a_b_c.jpg');
    expect(safeName('', 'fallback')).toBe('fallback');
    expect(safeName(42, 'fallback')).toBe('fallback');
    expect(safeName('x'.repeat(500), 'f').length).toBe(80);
  });
});

describe('begin validation (the computer never trusts the phone)', () => {
  const ok = (m: unknown) => parseBegin(m, 'scan', PHOTO_LIMITS, PHOTO_TYPES);
  it('accepts a good description and cleans the name', () => {
    const r = ok(begin({ name: '../x/y.jpg' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.name).toBe('y.jpg');
  });
  it('refuses a photo over the size cap', () => {
    const r = ok(begin({ size: 41 * 1024 * 1024, chunks: Math.ceil((41 * 1024 * 1024) / 262144) }));
    expect(r).toMatchObject({ ok: false, code: 'too-big' });
  });
  it('refuses types that are not jpeg / png / webp', () => {
    for (const mime of ['image/gif', 'image/heic', 'text/html', 'application/x-msdownload', '']) expect(ok(begin({ mime }))).toMatchObject({ ok: false, code: 'bad-type' });
  });
  it('refuses bad ids, sizes and chunk arithmetic', () => {
    expect(ok(begin({ id: 0 }))).toMatchObject({ ok: false, code: 'bad-begin' });
    expect(ok(begin({ id: -3 }))).toMatchObject({ ok: false });
    expect(ok(begin({ id: 1.5 }))).toMatchObject({ ok: false });
    expect(ok(begin({ id: 2 ** 32 }))).toMatchObject({ ok: false });
    expect(ok(begin({ size: 0 }))).toMatchObject({ ok: false });
    expect(ok(begin({ size: NaN }))).toMatchObject({ ok: false });
    expect(ok(begin({ chunks: 5 }))).toMatchObject({ ok: false }); // does not match size / chunk
    expect(ok(begin({ chunk: 10 }))).toMatchObject({ ok: false });
    expect(ok(begin({ w: 1e9 }))).toMatchObject({ ok: false });
    expect(ok(null)).toMatchObject({ ok: false });
    expect(ok({ ...begin(), type: 'preview-begin' })).toMatchObject({ ok: false });
  });
  it('validates end messages', () => {
    expect(parseEnd({ type: 'scan-end', id: 7, len: 10, crc: 'cbf43926' }, 'scan')).toMatchObject({ id: 7 });
    expect(parseEnd({ type: 'scan-end', id: 7, len: 10, crc: 'CBF43926' }, 'scan')).toBeNull();
    expect(parseEnd({ type: 'scan-end', id: 7, len: -1, crc: 'cbf43926' }, 'scan')).toBeNull();
    expect(parseEnd({ type: 'preview-end', id: 7, len: 1, crc: 'cbf43926' }, 'scan')).toBeNull();
  });
});

describe('messages to the phone', () => {
  it('status: state, sheet, frames, note', () => {
    expect(parseScanStatus({ type: 'scan-status', id: 3, state: 'done', sheet: 2, sheets: 6, frames: [7, 12], note: 'x' })).toEqual({ type: 'scan-status', id: 3, state: 'done', sheet: 2, sheets: 6, frames: [7, 12], note: 'x' });
    expect(parseScanStatus({ type: 'scan-status', id: 3, state: 'exploded' })).toBeNull();
    expect(parseScanStatus({ type: 'scan-status', id: 0, state: 'done' })).toBeNull();
    expect(parseScanStatus({ type: 'scan-status', id: 3, state: 'failed', retake: true, frames: [1, 'a'] })).toEqual({ type: 'scan-status', id: 3, state: 'failed', retake: true });
  });
  it('summary and ready fall back to safe values', () => {
    expect(parseScanSummary({ type: 'scan-summary', sheets: 6, missingSheets: [4, 'x', 5], missingFrames: [], recovered: 18, total: 36, fps: 12, busy: true })).toMatchObject({ missingSheets: [4, 5], busy: true });
    expect(parseScanReady({ type: 'scan-ready', limits: { chunkBytes: 5 } })!.limits.chunkBytes).toBe(PHOTO_LIMITS.chunkBytes);
  });
  it('preview meta is bounded', () => {
    const m = { count: 96, cols: 10, rows: 10, fw: 409, fh: 230, fps: 6, total: 192, step: 2, missingFrames: [3], missingSheets: [] };
    expect(parsePreviewMeta(m)).toMatchObject({ count: 96, step: 2 });
    expect(parsePreviewMeta({ ...m, count: 97 })).toBeNull();
    expect(parsePreviewMeta({ ...m, cols: 5, rows: 5 })).toBeNull(); // grid too small for the frames
    expect(parsePreviewMeta({ ...m, fw: 5000 })).toBeNull();
    expect(parsePreviewMeta({ ...m, fps: 0 })).toBeNull();
  });
});
