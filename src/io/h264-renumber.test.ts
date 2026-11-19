/**
 * H.264 renumbering on hand-made units: the bits are written here exactly as the standard lays them out, so the test does not need
 * an encoder. (The real encoder and decoder only exist in a browser.)
 */
import { describe, expect, it } from 'vitest';
import { escapeRbsp, findSps, newH264Counter, parseSps, renumberChunk, renumberSlice, splitAnnexB, unescapeRbsp, type H264Sps } from './h264-renumber';

/** Writes bits, most significant first. */
class W {
  bits: number[] = [];
  u(n: number, v: number) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2);
    return this;
  }
  ue(v: number) {
    const x = v + 1;
    const len = Math.floor(Math.log2(x));
    this.u(len, 0);
    return this.u(len + 1, x);
  }
  se(v: number) {
    return this.ue(v > 0 ? 2 * v - 1 : -2 * v);
  }
  /** Stop bit and padding to a whole byte, then the escape bytes. */
  nal(): Uint8Array {
    const b = [...this.bits, 1];
    while (b.length % 8) b.push(0);
    const out = new Uint8Array(b.length / 8);
    for (let i = 0; i < b.length; i++) out[i >> 3] |= b[i] << (7 - (i & 7));
    return escapeRbsp(out);
  }
}

/** Reads bits back for checking. */
class R {
  pos = 0;
  constructor(private d: Uint8Array) {}
  u(n: number) {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v = v * 2 + ((this.d[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return v;
  }
  ue() {
    let z = 0;
    while (this.u(1) === 0) z++;
    return 2 ** z - 1 + this.u(z);
  }
}

function sps(opts: { profile?: number; frameNumBits?: number; pocType?: number; pocBits?: number; frameMbsOnly?: boolean; scaling?: boolean } = {}): Uint8Array {
  const { profile = 66, frameNumBits = 4, pocType = 0, pocBits = 6, frameMbsOnly = true, scaling = false } = opts;
  const w = new W().u(8, 0x67).u(8, profile).u(8, 0xc0).u(8, 31).ue(0);
  if (profile === 100) {
    w.ue(1).ue(0).ue(0).u(1, 0).u(1, scaling ? 1 : 0);
    if (scaling) {
      // 8 lists: the first one present with 16 deltas of 0, the others absent
      w.u(1, 1);
      for (let i = 0; i < 16; i++) w.se(0);
      for (let i = 1; i < 8; i++) w.u(1, 0);
    }
  }
  w.ue(frameNumBits - 4).ue(pocType);
  if (pocType === 0) w.ue(pocBits - 4);
  else if (pocType === 1) w.u(1, 0).se(0).se(2).ue(1).se(2);
  w.ue(1).u(1, 0).ue(19).ue(10).u(1, frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u(1, 0);
  w.u(1, 1).u(1, 0).u(1, 0);
  return w.nal();
}

/** A delta slice: header fields, then `payload` bytes standing in for the macroblock data. */
function slice(s: H264Sps, frameNum: number, pocLsb: number, opts: { refIdc?: number; firstMb?: number; payload?: number[] } = {}): Uint8Array {
  const { refIdc = 2, firstMb = 0, payload = [0xab, 0xcd, 0xef, 0x12] } = opts;
  const w = new W().u(8, (refIdc << 5) | 1).ue(firstMb).ue(5).ue(0).u(s.frameNumBits, frameNum);
  if (!s.frameMbsOnly) w.u(1, 0);
  if (s.pocType === 0) w.u(s.pocBits, pocLsb);
  for (const b of payload) w.u(8, b);
  return w.nal();
}

function readSlice(nal: Uint8Array, s: H264Sps) {
  const r = new R(unescapeRbsp(nal));
  const header = r.u(8);
  const firstMb = r.ue();
  const type = r.ue();
  const pps = r.ue();
  const frameNum = r.u(s.frameNumBits);
  if (!s.frameMbsOnly) r.u(1);
  const poc = s.pocType === 0 ? r.u(s.pocBits) : -1;
  const rest: number[] = [];
  for (let i = 0; i < 4; i++) rest.push(r.u(8));
  return { header, firstMb, type, pps, frameNum, poc, rest };
}

const annexB = (...units: Uint8Array[]) => {
  const out: number[] = [];
  for (const u of units) out.push(0, 0, 0, 1, ...u);
  return new Uint8Array(out);
};

describe('escape bytes', () => {
  it('00 00 0x (x <= 3) gets a 03 in between and loses it again', () => {
    const raw = new Uint8Array([0x65, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 2, 9]);
    const esc = escapeRbsp(raw);
    expect([...esc]).toEqual([0x65, 0, 0, 3, 0, 0, 3, 1, 0, 0, 3, 3, 0, 0, 3, 2, 9]);
    expect([...unescapeRbsp(esc)]).toEqual([...raw]);
  });
  it('an escaped unit never contains a start code', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
    for (let n = 0; n < 50; n++) {
      const raw = new Uint8Array(200).map(() => (rnd() < 150 ? 0 : rnd() % 4));
      raw[0] = 0x41;
      raw[raw.length - 1] = 0x80;
      const esc = escapeRbsp(raw);
      for (let i = 0; i + 2 < esc.length; i++) expect(esc[i] === 0 && esc[i + 1] === 0 && esc[i + 2] <= 2).toBe(false);
      expect([...unescapeRbsp(esc)]).toEqual([...raw]);
    }
  });
});

describe('splitting a chunk into units', () => {
  it('handles three and four byte start codes and reads type and reference flag', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x41, 9, 9, 0, 0, 1, 0x01, 7]);
    const units = splitAnnexB(data);
    expect(units.map((u) => u.type)).toEqual([7, 8, 1, 1]);
    expect(units.map((u) => u.refIdc)).toEqual([3, 3, 2, 0]);
    expect([...data.subarray(units[0].start, units[0].end)]).toEqual([0x67, 1, 2]);
    expect([...data.subarray(units[1].start, units[1].end)]).toEqual([0x68, 3]);
    expect([...data.subarray(units[2].start, units[2].end)]).toEqual([0x41, 9, 9]);
    expect([...data.subarray(units[3].start, units[3].end)]).toEqual([0x01, 7]);
    expect(splitAnnexB(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe('reading the sequence header', () => {
  it('baseline, display counter in the slice', () => {
    expect(parseSps(sps({ frameNumBits: 4, pocType: 0, pocBits: 6 }))).toEqual({ frameNumBits: 4, pocType: 0, pocBits: 6, frameMbsOnly: true, separateColourPlane: false });
    expect(parseSps(sps({ frameNumBits: 9, pocType: 0, pocBits: 16 }))).toMatchObject({ frameNumBits: 9, pocBits: 16 });
  });
  it('display counter types 1 and 2 (nothing in the slice), interlaced streams', () => {
    expect(parseSps(sps({ pocType: 2 }))).toMatchObject({ pocType: 2, pocBits: 0, frameMbsOnly: true });
    expect(parseSps(sps({ pocType: 1, frameNumBits: 7 }))).toMatchObject({ pocType: 1, frameNumBits: 7, frameMbsOnly: true });
    expect(parseSps(sps({ frameMbsOnly: false }))).toMatchObject({ frameMbsOnly: false });
  });
  it('high profile, with and without scaling lists', () => {
    expect(parseSps(sps({ profile: 100, frameNumBits: 8, pocBits: 10 }))).toMatchObject({ frameNumBits: 8, pocType: 0, pocBits: 10, frameMbsOnly: true });
    expect(parseSps(sps({ profile: 100, frameNumBits: 5, pocBits: 7, scaling: true }))).toMatchObject({ frameNumBits: 5, pocBits: 7, frameMbsOnly: true });
  });
  it('is found inside a key frame chunk; a chunk without one gives null', () => {
    const s = sps({ frameNumBits: 6, pocBits: 8 });
    expect(findSps(annexB(s, new Uint8Array([0x68, 0xce]), new Uint8Array([0x65, 0x88])))).toMatchObject({ frameNumBits: 6, pocBits: 8 });
    expect(findSps(annexB(new Uint8Array([0x41, 0x9a])))).toBeNull();
    expect(findSps(annexB(new Uint8Array([0x67, 0x42])))).toBeNull(); // cut short: not readable
  });
});

describe('renumbering', () => {
  const s = parseSps(sps({ frameNumBits: 4, pocType: 0, pocBits: 6 }));

  it('overwrites frame_num and the display counter and nothing else', () => {
    const before = slice(s, 1, 2, { firstMb: 3 });
    const after = renumberSlice(before, s, 9, 18);
    expect(readSlice(before, s)).toMatchObject({ frameNum: 1, poc: 2 });
    expect(readSlice(after, s)).toEqual({ ...readSlice(before, s), frameNum: 9, poc: 18 });
    expect(after.length).toBe(before.length);
  });

  it('wraps the numbers to the width of their fields', () => {
    const after = renumberSlice(slice(s, 1, 2), s, 16 + 5, 64 + 10);
    expect(readSlice(after, s)).toMatchObject({ frameNum: 5, poc: 10 });
  });

  it('keeps the escape bytes right when the new numbers make or remove a 00 00 run', () => {
    // frame_num 0 and counter 0 leave long runs of zero bits in the header; the payload starts with zeros too
    const zeroPayload = slice(s, 3, 7, { payload: [0, 0, 1, 0x55] });
    const made = renumberSlice(zeroPayload, s, 0, 0);
    expect(readSlice(made, s)).toMatchObject({ frameNum: 0, poc: 0, rest: [0, 0, 1, 0x55] });
    for (let i = 0; i + 2 < made.length; i++) expect(made[i] === 0 && made[i + 1] === 0 && made[i + 2] <= 2).toBe(false);
    const back = renumberSlice(made, s, 3, 7);
    expect([...back]).toEqual([...zeroPayload]);
  });

  it('a stream without the display counter in the slice only gets frame_num', () => {
    const s2 = parseSps(sps({ pocType: 2, frameNumBits: 5 }));
    const after = renumberSlice(slice(s2, 1, 0), s2, 17, 99);
    expect(readSlice(after, s2)).toMatchObject({ frameNum: 17, poc: -1, rest: [0xab, 0xcd, 0xef, 0x12] });
  });

  it('a whole stream: key frames pass untouched and restart the count, delta frames count up, repeats included', () => {
    const key = annexB(sps({ frameNumBits: 4, pocType: 0, pocBits: 6 }), new Uint8Array([0x68, 0xce]), new Uint8Array([0x65, 0x88, 0x80]));
    const d = (n: number) => annexB(slice(s, n, n * 2));
    const c = newH264Counter();
    const read = (chunk: Uint8Array) => {
      const u = splitAnnexB(chunk).filter((x) => x.type === 1);
      return u.map((x) => readSlice(chunk.subarray(x.start, x.end), s)).map((x) => [x.frameNum, x.poc]);
    };
    expect(renumberChunk(key, true, s, c)).toBe(key);
    // what the encoder numbered 1, 2, [key removed], 1, 2, 2, 2 (a repeat)... becomes one even count
    const fed = [d(1), d(2), d(1), d(2), d(2), d(2), d(3)].map((x) => read(renumberChunk(x, false, s, c))[0]);
    expect(fed).toEqual([[1, 2], [2, 4], [3, 6], [4, 8], [5, 10], [6, 12], [7, 14]]);
    // a kept key frame restarts both counters
    renumberChunk(key, true, s, c);
    expect(read(renumberChunk(d(5), false, s, c))[0]).toEqual([1, 2]);
  });

  it('counts past the width of the field (a long project) by wrapping, as the standard asks', () => {
    const c = newH264Counter();
    const nums: number[] = [];
    for (let i = 0; i < 40; i++) {
      const out = renumberChunk(annexB(slice(s, 1, 2)), false, s, c);
      const u = splitAnnexB(out)[0];
      nums.push(readSlice(out.subarray(u.start, u.end), s).frameNum);
    }
    expect(nums.slice(0, 17)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
  });

  it('every slice of one picture gets the same numbers, other units are passed on', () => {
    const c = newH264Counter();
    const sei = new Uint8Array([0x06, 5, 1, 0x80]);
    const chunk = annexB(sei, slice(s, 1, 2, { firstMb: 0 }), slice(s, 1, 2, { firstMb: 40 }));
    renumberChunk(annexB(slice(s, 1, 2)), false, s, c);
    const out = renumberChunk(chunk, false, s, c);
    const units = splitAnnexB(out);
    expect(units.map((u) => u.type)).toEqual([6, 1, 1]);
    expect([...out.subarray(units[0].start, units[0].end)]).toEqual([...sei]);
    const a = readSlice(out.subarray(units[1].start, units[1].end), s);
    const b = readSlice(out.subarray(units[2].start, units[2].end), s);
    expect([a.frameNum, a.poc, a.firstMb]).toEqual([2, 4, 0]);
    expect([b.frameNum, b.poc, b.firstMb]).toEqual([2, 4, 40]);
  });

  it('a picture nothing is predicted from does not advance frame_num for the next one', () => {
    const c = newH264Counter();
    const num = (chunk: Uint8Array) => {
      const out = renumberChunk(chunk, false, s, c);
      const u = splitAnnexB(out)[0];
      return readSlice(out.subarray(u.start, u.end), s).frameNum;
    };
    expect(num(annexB(slice(s, 1, 2)))).toBe(1);
    expect(num(annexB(slice(s, 2, 4, { refIdc: 0 })))).toBe(2);
    expect(num(annexB(slice(s, 2, 6)))).toBe(2);
    expect(num(annexB(slice(s, 3, 8)))).toBe(3);
  });
});
