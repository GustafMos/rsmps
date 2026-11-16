import { describe, expect, it } from 'vitest';
import { PHOTO_LIMITS, PHOTO_TYPES, bytesToBase64, crc32, crcHex, encodeChunkFrame, FRAME_PHOTO, parseChunkFrame, type TransferLimits } from './scan-protocol';
import { ChunkSender, TransferReceiver, type CompletedTransfer } from './scan-transfer';

/** A JPEG-looking file of `n` bytes (starts with FF D8 FF, the rest is pseudo-random). */
function jpeg(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  b.set([0xff, 0xd8, 0xff], 0);
  return b;
}

const CHUNK = 4096;
const small: TransferLimits = { ...PHOTO_LIMITS, chunkBytes: CHUNK, window: 4, maxBytes: 200_000, maxSessionBytes: 500_000, maxCount: 3, maxOpen: 2, idleMs: 1000 };

/** Sender and receiver wired through a controllable "network". */
function rig(opts: { limits?: TransferLimits; bytes?: Uint8Array; id?: number; name?: string; mime?: string } = {}) {
  const limits = opts.limits ?? small;
  const bytes = opts.bytes ?? jpeg(20_000);
  const toReceiver: Array<{ json?: Record<string, unknown>; frame?: Uint8Array }> = [];
  const toSender: Record<string, unknown>[] = [];
  const done: CompletedTransfer[] = [];
  let buffered = 0;
  let clock = 0;
  const sendEvents: string[] = [];
  const receiver = new TransferReceiver({ prefix: 'scan', limits, allowed: PHOTO_TYPES, send: (m) => toSender.push(m), onComplete: (d) => done.push(d) });
  const events = { done: false, failed: '' as string, code: '' as string };
  const sender = new ChunkSender({
    prefix: 'scan',
    id: opts.id ?? 7,
    name: opts.name ?? 'sheet.jpg',
    mime: opts.mime ?? 'image/jpeg',
    w: 4000,
    h: 3000,
    bytes,
    chunkBytes: limits.chunkBytes,
    window: limits.window,
    transport: {
      sendJson: (m) => {
        sendEvents.push(String(m.type));
        toReceiver.push({ json: m });
      },
      sendChunk: (f) => {
        sendEvents.push('chunk');
        toReceiver.push({ frame: f });
      },
      buffered: () => buffered,
    },
    onDone: () => (events.done = true),
    onFail: (r, c) => ((events.failed = r), (events.code = c ?? '')),
  });
  /** Deliver everything in flight (optionally dropping some chunk frames), and the answers back, until quiet. */
  function run(drop: (seq: number, n: number) => boolean = () => false, maxRounds = 200): void {
    let n = 0;
    for (let round = 0; round < maxRounds && (toReceiver.length || toSender.length); round++) {
      const batch = toReceiver.splice(0);
      for (const m of batch) {
        if (m.json) receiver.handleJson(m.json, clock);
        else {
          const f = parseChunkFrame(m.frame!)!;
          if (drop(f.seq, n++)) continue;
          receiver.handleChunk(f, clock);
        }
      }
      for (const a of toSender.splice(0)) sender.onMessage(a as never, clock);
    }
  }
  return { sender, receiver, done, events, toReceiver, toSender, run, setBuffered: (n: number) => (buffered = n), advance: (ms: number) => (clock += ms), now: () => clock, sendEvents, bytes };
}

describe('chunked transfer', () => {
  it('moves a photo in order and the receiver gets the exact bytes', () => {
    const r = rig();
    r.sender.start(0);
    r.run();
    expect(r.events.done).toBe(true);
    expect(r.done).toHaveLength(1);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
    expect(r.done[0]).toMatchObject({ id: 7, name: 'sheet.jpg', mime: 'image/jpeg', w: 4000, h: 3000 });
    expect(r.sender.fraction).toBe(1);
    // begin first, end last
    expect(r.sendEvents[0]).toBe('scan-begin');
    expect(r.sendEvents.at(-1)).toBe('scan-end');
    expect(r.sendEvents.filter((e) => e === 'chunk').length).toBe(Math.ceil(r.bytes.length / CHUNK));
  });

  it('does not send a single chunk before the computer accepted the begin', () => {
    const r = rig();
    r.sender.start(0);
    r.sender.pump();
    expect(r.sendEvents).toEqual(['scan-begin']);
  });

  it('ignores a duplicate chunk', () => {
    const r = rig();
    r.sender.start(0);
    // deliver begin, then every chunk twice
    r.run((_s, _n) => false, 1);
    const frames = r.toReceiver.splice(0);
    for (const f of frames) {
      if (f.frame) r.receiver.handleChunk(parseChunkFrame(f.frame)!, 0);
      if (f.frame) r.receiver.handleChunk(parseChunkFrame(f.frame)!, 0);
      if (f.json) r.receiver.handleJson(f.json, 0);
    }
    for (const a of r.toSender.splice(0)) r.sender.onMessage(a as never, 0);
    r.run();
    expect(r.events.done).toBe(true);
    expect(r.done).toHaveLength(1);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
  });

  it('asks again for a missing chunk (nak) and finishes', () => {
    const r = rig();
    r.sender.start(0);
    let lost = false;
    r.run((seq) => (seq === 2 && !lost ? (lost = true) : false)); // the first copy of chunk 2 is lost
    expect(r.events.done).toBe(true);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
    expect(r.sender.sentFrames).toBeGreaterThan(Math.ceil(r.bytes.length / CHUNK)); // something was sent again
  });

  it('recovers from a burst of lost chunks', () => {
    const r = rig();
    r.sender.start(0);
    r.run((seq) => seq >= 3, 20); // nothing from chunk 3 on gets through for a while (the receiver keeps asking for 3)
    expect(r.events.done).toBe(false);
    r.advance(5000);
    r.sender.tick(r.now()); // the burst is over; nothing has been heard for a while
    r.run();
    expect(r.events.done).toBe(true);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
  });

  it('recovers from silence: acknowledgements and chunks vanish, the sender repeats after the stall time', () => {
    const r = rig();
    r.sender.start(0);
    r.run(() => false, 1); // begin accepted, the first window is on its way
    r.toReceiver.length = 0; // ...and lost, as are the answers
    r.toSender.length = 0;
    r.advance(5000);
    r.sender.tick(r.now()); // nothing heard for 4 s: the oldest unacknowledged chunks go out again
    expect(r.toReceiver.length).toBeGreaterThan(0);
    r.run();
    expect(r.events.done).toBe(true);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
  });

  it('gives up after repeated silence with a plain message', () => {
    const r = rig();
    r.sender.start(0);
    r.toReceiver.length = 0; // the computer never answers
    for (let i = 0; i < 12; i++) {
      r.advance(5000);
      r.sender.tick(r.now());
    }
    expect(r.sender.state).toBe('failed');
    expect(r.events.failed).toMatch(/did not answer/);
    expect(r.events.code).toBe('stalled');
  });

  it('never has more than the window unacknowledged', () => {
    const r = rig({ bytes: jpeg(40 * CHUNK) });
    r.sender.start(0);
    r.run(() => false, 1); // begin accepted: ack 0
    r.sender.pump();
    expect(r.sendEvents.filter((e) => e === 'chunk').length).toBeLessThanOrEqual(small.window);
  });

  it('waits while the socket queue is full and continues when it drains (back-pressure)', () => {
    const r = rig({ bytes: jpeg(10 * CHUNK) });
    r.sender.start(0);
    r.setBuffered(5_000_000); // the phone's socket is backed up
    r.run(() => false, 1); // begin accepted, the sender would like to send but the socket is full
    r.sender.pump();
    expect(r.sendEvents.filter((e) => e === 'chunk').length).toBe(0);
    r.setBuffered(0);
    r.sender.tick(r.now()); // the page's timer calls tick, which pumps
    expect(r.sendEvents.filter((e) => e === 'chunk').length).toBeGreaterThan(0);
    r.run();
    expect(r.events.done).toBe(true);
  });

  it('resumes after the socket dropped: begin again, the computer says where it is', () => {
    const r = rig({ bytes: jpeg(12 * CHUNK) });
    r.sender.start(0);
    r.run(() => false, 3); // a few rounds: part of the photo is there
    r.sender.pause();
    r.toReceiver.length = 0;
    r.toSender.length = 0;
    const had = r.receiver.stats.bytes;
    expect(had).toBeGreaterThan(0);
    r.sender.start(100); // reconnected
    r.run();
    expect(r.events.done).toBe(true);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes));
    expect(r.done).toHaveLength(1);
  });

  it('a damaged photo (checksum mismatch) is thrown away and sent again from the start', () => {
    const r = rig();
    r.sender.start(0);
    let flipped = false;
    // corrupt one chunk on its way, once
    const orig = r.receiver.handleChunk.bind(r.receiver);
    r.receiver.handleChunk = (f, now) => {
      if (!flipped && f.seq === 1) {
        flipped = true;
        const p = f.payload.slice();
        p[10] ^= 0xff;
        return orig({ ...f, payload: p }, now);
      }
      return orig(f, now);
    };
    r.run();
    expect(flipped).toBe(true);
    expect(r.events.done).toBe(true);
    expect(Array.from(r.done[0].bytes)).toEqual(Array.from(r.bytes)); // the good copy, not the damaged one
    expect(r.done).toHaveLength(1);
  });

  it('refuses a length mismatch in the end message', () => {
    const out: Record<string, unknown>[] = [];
    const done: CompletedTransfer[] = [];
    const rcv = new TransferReceiver({ prefix: 'scan', limits: small, allowed: PHOTO_TYPES, send: (m) => out.push(m), onComplete: (d) => done.push(d) });
    const bytes = jpeg(5000);
    rcv.handleJson({ type: 'scan-begin', id: 9, name: 'a.jpg', size: 5000, mime: 'image/jpeg', w: 1, h: 1, chunks: 2, chunk: CHUNK }, 0);
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 9, seq: 0, payload: bytes.subarray(0, CHUNK) }, 0);
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 9, seq: 1, payload: bytes.subarray(CHUNK) }, 0);
    rcv.handleJson({ type: 'scan-end', id: 9, len: 4999, crc: crcHex(crc32(bytes)) }, 0);
    expect(out.at(-1)).toMatchObject({ type: 'scan-reject', code: 'mismatch' });
    expect(done).toHaveLength(0);
  });
});

describe('what the receiver refuses', () => {
  function recv(limits = small) {
    const out: Record<string, unknown>[] = [];
    const done: CompletedTransfer[] = [];
    const rcv = new TransferReceiver({ prefix: 'scan', limits, allowed: PHOTO_TYPES, send: (m) => out.push(m), onComplete: (d) => done.push(d) });
    const begin = (id: number, size = 5000, extra: Record<string, unknown> = {}) => rcv.handleJson({ type: 'scan-begin', id, name: `p${id}.jpg`, size, mime: 'image/jpeg', w: 10, h: 10, chunks: Math.ceil(size / CHUNK), chunk: CHUNK, ...extra }, 0);
    return { out, done, rcv, begin };
  }

  it('a chunk for an id that was never announced', () => {
    const { rcv, out } = recv();
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 123, seq: 0, payload: new Uint8Array(10) }, 0);
    expect(out.at(-1)).toMatchObject({ type: 'scan-reject', id: 123, code: 'unknown-id' });
    rcv.handleJson({ type: 'scan-end', id: 123, len: 10, crc: '00000000' }, 0);
    expect(out.at(-1)).toMatchObject({ code: 'unknown-id' });
  });

  it('a chunk outside the announced count, or with the wrong length', () => {
    const { rcv, out, begin } = recv();
    begin(1);
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 1, seq: 2, payload: new Uint8Array(CHUNK) }, 0);
    expect(out.at(-1)).toMatchObject({ code: 'bad-chunk' });
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 1, seq: 0, payload: new Uint8Array(CHUNK - 1) }, 0);
    expect(out.at(-1)).toMatchObject({ code: 'bad-chunk' });
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 1, seq: 1, payload: new Uint8Array(CHUNK) }, 0); // the last chunk must be 5000-4096 long
    expect(out.at(-1)).toMatchObject({ code: 'bad-chunk' });
  });

  it('a photo over the cap and one with a wrong type', () => {
    const { out, begin } = recv();
    begin(2, 300_000);
    expect(out.at(-1)).toMatchObject({ code: 'too-big' });
    begin(3, 5000, { mime: 'application/zip' });
    expect(out.at(-1)).toMatchObject({ code: 'bad-type' });
  });

  it('a file that is not the picture it claims to be (checked on the real bytes)', () => {
    const { out, done, rcv, begin } = recv();
    begin(4, 100);
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(100, ' '));
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 4, seq: 0, payload: html }, 0);
    rcv.handleJson({ type: 'scan-end', id: 4, len: 100, crc: crcHex(crc32(html)) }, 0);
    expect(out.at(-1)).toMatchObject({ type: 'scan-reject', code: 'bad-type' });
    expect(done).toHaveLength(0);
  });

  it('a PNG that claims to be a JPEG', () => {
    const { out, done, rcv, begin } = recv();
    begin(5, 20);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(12).fill(0)]);
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 5, seq: 0, payload: png }, 0);
    rcv.handleJson({ type: 'scan-end', id: 5, len: 20, crc: crcHex(crc32(png)) }, 0);
    expect(out.at(-1)).toMatchObject({ code: 'bad-type' });
    expect(done).toHaveLength(0);
  });

  it('an id that is already used by a different picture', () => {
    const { out, begin } = recv();
    begin(6, 5000);
    begin(6, 9000);
    expect(out.at(-1)).toMatchObject({ code: 'id-in-use' });
  });

  it('too many open at once', () => {
    const { out, begin } = recv({ ...small, maxOpen: 2 });
    begin(1, 5000);
    begin(2, 5000);
    begin(3, 5000);
    expect(out.at(-1)).toMatchObject({ code: 'busy' });
  });

  it('too many bytes in one session', () => {
    const { out, begin } = recv({ ...small, maxSessionBytes: 12_000 });
    begin(1, 5000);
    begin(2, 5000);
    begin(3, 5000); // 15 000 > 12 000
    expect(out.at(-1)).toMatchObject({ code: 'session-full' });
  });

  it('too many photos in one session (finished ones count)', () => {
    const { out, begin, rcv } = recv({ ...small, maxCount: 2 });
    const a = jpeg(100);
    begin(1, 100);
    rcv.handleChunk({ kind: FRAME_PHOTO, id: 1, seq: 0, payload: a }, 0);
    rcv.handleJson({ type: 'scan-end', id: 1, len: 100, crc: crcHex(crc32(a)) }, 0);
    begin(2, 100);
    begin(3, 100);
    expect(out.at(-1)).toMatchObject({ code: 'too-many' });
  });

  it('drops an upload that went quiet and gives its bytes back', () => {
    const { rcv, begin } = recv();
    begin(1, 5000);
    expect(rcv.stats.bytes).toBe(5000);
    expect(rcv.sweep(500)).toEqual([]);
    expect(rcv.sweep(5000)).toEqual([1]);
    expect(rcv.stats.bytes).toBe(0);
  });

  it('accepts base64 JSON chunks as a fallback', () => {
    const { out, done, rcv, begin } = recv();
    const bytes = jpeg(5000);
    begin(8, 5000);
    rcv.handleJson({ type: 'scan-chunk', id: 8, seq: 0, data: bytesToBase64(bytes.subarray(0, CHUNK)) }, 0);
    rcv.handleJson({ type: 'scan-chunk', id: 8, seq: 1, data: bytesToBase64(bytes.subarray(CHUNK)) }, 0);
    rcv.handleJson({ type: 'scan-chunk', id: 8, seq: 1, data: '***' }, 0);
    expect(out.at(-1)).toMatchObject({ code: 'bad-chunk' });
    rcv.handleJson({ type: 'scan-end', id: 8, len: 5000, crc: crcHex(crc32(bytes)) }, 0);
    expect(done).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ type: 'scan-ok', id: 8 });
  });

  it('answers a repeated begin / end for a finished photo with ok (the first answer may have been lost)', () => {
    const r = rig();
    r.sender.start(0);
    r.run();
    r.receiver.handleJson({ type: 'scan-begin', id: 7, name: 'sheet.jpg', size: r.bytes.length, mime: 'image/jpeg', w: 1, h: 1, chunks: Math.ceil(r.bytes.length / CHUNK), chunk: CHUNK }, 0);
    expect(r.toSender.at(-1)).toMatchObject({ type: 'scan-ok', id: 7 });
    expect(r.done).toHaveLength(1); // not delivered twice
  });

  it('the sender ignores answers about other photos', () => {
    const r = rig();
    r.sender.start(0);
    r.sender.onMessage({ type: 'scan-reject', id: 99, code: 'too-big', reason: 'x' }, 0);
    r.sender.onMessage({ type: 'scan-ok', id: 99 }, 0);
    expect(r.sender.state).toBe('begin');
    r.sender.onMessage({ type: 'scan-reject', id: 7, code: 'too-big', reason: 'This file is too big.' }, 0);
    expect(r.sender.state).toBe('failed');
    expect(r.events.failed).toBe('This file is too big.');
  });

  it('the frame helper builds what the receiver parses', () => {
    const f = encodeChunkFrame(FRAME_PHOTO, 5, 6, new Uint8Array([9]));
    expect(parseChunkFrame(f)).toMatchObject({ id: 5, seq: 6 });
  });
});
