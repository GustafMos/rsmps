/**
 * Renumber H.264 delta frames. Pure byte work: no codec, no DOM.
 *
 * WHY: every H.264 picture carries a running number (`frame_num`) and a display counter (`pic_order_cnt_lsb`) in the header of each
 * of its slices. Codec Datamosh leaves frames out and feeds others several times, so those numbers jump or repeat. A decoder that
 * sees that either refuses the stream or "repairs" it by throwing pictures away, which is exactly what must not happen: the decoder
 * should believe it is reading one ordinary, unbroken stream and apply every delta frame to whatever picture it holds. So the two
 * counters are rewritten to count up evenly in the order the chunks are fed. Nothing else is touched: the motion vectors and the
 * corrections stay the codec's own.
 *
 * Both fields have a fixed number of bits (given by the sequence header, the SPS), so they are overwritten in place; only the escape
 * bytes of the unit ("emulation prevention") are removed before and put back after.
 *
 * Chunks are expected in Annex B form (units separated by 00 00 01 start codes), which is what the encoder is asked for.
 */

export interface H264Sps {
  /** Bits of `frame_num`. */
  frameNumBits: number;
  /** 0: the slice header has `pic_order_cnt_lsb`; 1 or 2: it has not (nothing to rewrite). */
  pocType: number;
  /** Bits of `pic_order_cnt_lsb` (poc type 0 only). */
  pocBits: number;
  frameMbsOnly: boolean;
  separateColourPlane: boolean;
}

export interface NalUnit {
  /** First byte of the unit (its header byte), after the start code. */
  start: number;
  /** One past its last byte. */
  end: number;
  /** nal_unit_type: 1 = slice of a delta picture, 5 = slice of a key picture, 7 = SPS, 8 = PPS. */
  type: number;
  /** nal_ref_idc: 0 = no later picture is predicted from this one. */
  refIdc: number;
}

/** The units of an Annex B chunk. */
export function splitAnnexB(data: Uint8Array): NalUnit[] {
  const starts: { code: number; payload: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // A four byte start code (00 00 00 01) belongs to the start code, not to the unit before it.
      starts.push({ code: i > 0 && data[i - 1] === 0 ? i - 1 : i, payload: i + 3 });
      i += 2;
    }
  }
  const out: NalUnit[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k].payload;
    const end = k + 1 < starts.length ? starts[k + 1].code : data.length;
    if (end <= start) continue;
    out.push({ start, end, type: data[start] & 0x1f, refIdc: (data[start] >> 5) & 3 });
  }
  return out;
}

/** Remove the escape bytes: inside a unit, 00 00 03 stands for 00 00. */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

/** Put the escape bytes back: 00 00 followed by 00, 01, 02 or 03 gets a 03 in between, and so does 00 00 at the very end. */
export function escapeRbsp(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + Math.ceil(raw.length / 2) + 1);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (zeros >= 2 && b <= 3) {
      out[n++] = 3;
      zeros = 0;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  if (zeros >= 2) out[n++] = 3;
  return out.slice(0, n);
}

/** Reads and overwrites bits, most significant first. */
class Bits {
  pos = 0;
  constructor(private d: Uint8Array) {}
  bit(): number {
    if (this.pos >= this.d.length * 8) throw new Error('H.264 header ends early');
    const v = (this.d[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  /** Exp-Golomb, unsigned. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error('H.264 header is not readable');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
  /** Exp-Golomb, signed. */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
  /** Overwrite `n` bits at the current position with `value` and move past them. */
  put(n: number, value: number): void {
    for (let i = n - 1; i >= 0; i--) {
      const byte = this.pos >> 3;
      const mask = 1 << (7 - (this.pos & 7));
      if (byte >= this.d.length) throw new Error('H.264 header ends early');
      if (Math.floor(value / 2 ** i) % 2) this.d[byte] |= mask;
      else this.d[byte] &= ~mask;
      this.pos++;
    }
  }
}

/** Profiles whose SPS has the chroma / bit depth / scaling block before the fields we need. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Read what is needed from an SPS unit (`nal` starts with its header byte). */
export function parseSps(nal: Uint8Array): H264Sps {
  const b = new Bits(unescapeRbsp(nal));
  b.u(8); // unit header
  const profile = b.u(8);
  b.u(16); // constraint flags, level
  b.ue(); // sps id
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profile)) {
    const chroma = b.ue();
    if (chroma === 3) separateColourPlane = b.bit() === 1;
    b.ue(); // luma bit depth
    b.ue(); // chroma bit depth
    b.bit(); // transform bypass
    if (b.bit()) {
      // scaling lists: only skipped over
      const lists = chroma === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        if (!b.bit()) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + b.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  const frameNumBits = b.ue() + 4;
  const pocType = b.ue();
  let pocBits = 0;
  if (pocType === 0) pocBits = b.ue() + 4;
  else if (pocType === 1) {
    b.bit();
    b.se();
    b.se();
    const n = b.ue();
    for (let i = 0; i < n; i++) b.se();
  }
  b.ue(); // reference frames
  b.bit(); // gaps allowed
  b.ue(); // width
  b.ue(); // height
  const frameMbsOnly = b.bit() === 1;
  return { frameNumBits, pocType, pocBits, frameMbsOnly, separateColourPlane };
}

/** The SPS of a chunk (key frames carry it), or null. */
export function findSps(chunk: Uint8Array): H264Sps | null {
  for (const u of splitAnnexB(chunk)) {
    if (u.type === 7) {
      try {
        return parseSps(chunk.subarray(u.start, u.end));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * One slice unit of a delta picture with `frame_num` (and, when the stream has it, `pic_order_cnt_lsb`) overwritten. Values are
 * wrapped to the field width. Returns a new unit; the length can differ by a few escape bytes.
 */
export function renumberSlice(nal: Uint8Array, sps: H264Sps, frameNum: number, pocLsb: number): Uint8Array {
  const raw = unescapeRbsp(nal).slice();
  const b = new Bits(raw);
  b.u(8); // unit header
  b.ue(); // first macroblock
  b.ue(); // slice type
  b.ue(); // pps id
  if (sps.separateColourPlane) b.u(2);
  b.put(sps.frameNumBits, frameNum % 2 ** sps.frameNumBits);
  if (!sps.frameMbsOnly && b.bit()) b.bit(); // field picture: which field
  if (sps.pocType === 0) b.put(sps.pocBits, pocLsb % 2 ** sps.pocBits);
  return escapeRbsp(raw);
}

/** Counters carried from chunk to chunk while a stream is fed to the decoder. */
export interface H264Counter {
  /** `frame_num` of the last picture later ones are predicted from. */
  lastRef: number;
  /** Pictures fed since the last key frame. */
  sinceKey: number;
}

export function newH264Counter(): H264Counter {
  return { lastRef: 0, sinceKey: 0 };
}

/**
 * The chunk as it should be fed: a key frame is passed on as it is (it restarts both counters), a delta frame gets the next numbers.
 * Per the standard a picture's `frame_num` is one more than that of the last REFERENCE picture, and the display counter goes up by
 * two per picture (one per field).
 */
export function renumberChunk(chunk: Uint8Array, key: boolean, sps: H264Sps, counter: H264Counter): Uint8Array {
  if (key) {
    counter.lastRef = 0;
    counter.sinceKey = 0;
    return chunk;
  }
  const units = splitAnnexB(chunk);
  counter.sinceKey++;
  const frameNum = counter.lastRef + 1;
  const parts: Uint8Array[] = [];
  let isRef = false;
  for (const u of units) {
    const nal = chunk.subarray(u.start, u.end);
    if (u.type === 1) {
      parts.push(renumberSlice(nal, sps, frameNum, counter.sinceKey * 2));
      if (u.refIdc !== 0) isRef = true;
    } else parts.push(nal);
  }
  if (isRef) counter.lastRef = frameNum % 2 ** sps.frameNumBits;
  let size = 0;
  for (const p of parts) size += 4 + p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set([0, 0, 0, 1], at);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}
