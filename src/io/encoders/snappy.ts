/**
 * Snappy raw (block) format, encoder and decoder. Written from the public format description (google/snappy format_description.txt).
 * Stream: varint uncompressed length, then elements. Tag low 2 bits: 00 literal, 01 copy with 1-byte offset (len 4..11, offset < 2048),
 * 10 copy with 2-byte offset (len 1..64), 11 copy with 4-byte offset. The encoder is a greedy hash matcher over a 64 KiB window.
 */

/** Upper bound of the compressed size (same bound as the reference library). */
export function snappyMaxSize(n: number): number {
  return 32 + n + Math.floor(n / 6);
}

const HASH_BITS = 15;

export function snappyEncode(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(snappyMaxSize(n) + 8);
  let o = 0;
  let rest = n;
  while (rest >= 128) {
    out[o++] = (rest % 128) | 128;
    rest = Math.floor(rest / 128);
  }
  out[o++] = rest;
  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  const hash = (i: number) => Math.imul(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24), 0x1e35a7bd) >>> (32 - HASH_BITS);

  const literal = (from: number, to: number) => {
    const len = to - from;
    if (len <= 0) return;
    const l = len - 1;
    if (l < 60) out[o++] = l << 2;
    else if (l < 256) {
      out[o++] = 60 << 2;
      out[o++] = l;
    } else if (l < 65536) {
      out[o++] = 61 << 2;
      out[o++] = l & 255;
      out[o++] = l >> 8;
    } else if (l < 16777216) {
      out[o++] = 62 << 2;
      out[o++] = l & 255;
      out[o++] = (l >> 8) & 255;
      out[o++] = l >> 16;
    } else {
      out[o++] = 63 << 2;
      out[o++] = l & 255;
      out[o++] = (l >> 8) & 255;
      out[o++] = (l >> 16) & 255;
      out[o++] = (l >>> 24) & 255;
    }
    out.set(src.subarray(from, to), o);
    o += len;
  };
  const copy = (offset: number, len: number) => {
    while (len > 0) {
      const l = Math.min(len, 64);
      if (offset < 2048 && l >= 4 && l <= 11) {
        out[o++] = 1 | ((l - 4) << 2) | ((offset >> 8) << 5);
        out[o++] = offset & 255;
      } else {
        out[o++] = 2 | ((l - 1) << 2);
        out[o++] = offset & 255;
        out[o++] = offset >> 8;
      }
      len -= l;
    }
  };

  let lit = 0;
  let i = 0;
  const limit = n - 4;
  while (i <= limit) {
    const h = hash(i);
    const cand = table[h];
    table[h] = i;
    if (cand >= 0 && i - cand < 65536 && src[cand] === src[i] && src[cand + 1] === src[i + 1] && src[cand + 2] === src[i + 2] && src[cand + 3] === src[i + 3]) {
      let len = 4;
      while (i + len < n && src[cand + len] === src[i + len]) len++;
      literal(lit, i);
      copy(i - cand, len);
      const end = i + len;
      for (let k = i + 1; k < end && k <= limit; k += 2) table[hash(k)] = k;
      i = end;
      lit = i;
    } else {
      i++;
    }
  }
  literal(lit, n);
  return out.slice(0, o);
}

/** Uncompressed size stated at the start of a Snappy block, and where the elements begin. */
function snappyHeader(src: Uint8Array): { length: number; start: number } {
  let i = 0;
  let n = 0;
  let mul = 1;
  for (;;) {
    const b = src[i++];
    if (b === undefined) throw new Error('snappy: truncated header');
    n += (b & 127) * mul;
    mul *= 128;
    if (!(b & 128)) break;
  }
  return { length: n, start: i };
}

/** Uncompressed size of a Snappy block (read from its header; nothing is decoded). */
export function snappyLength(src: Uint8Array): number {
  return snappyHeader(src).length;
}

export function snappyDecode(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(snappyLength(src));
  snappyDecodeInto(src, out, 0);
  return out;
}

/**
 * Decode a Snappy block into `out` starting at `at` (HAP frames made of several chunks are decoded straight into one texture).
 * Returns the number of bytes written.
 */
export function snappyDecodeInto(src: Uint8Array, out: Uint8Array, at = 0): number {
  const head = snappyHeader(src);
  const n = head.length;
  if (at + n > out.length) throw new Error('snappy: the output does not fit');
  const end = at + n;
  let i = head.start;
  let o = at;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const extra = len - 59;
        len = 0;
        for (let k = 0; k < extra; k++) len += src[i++] * 2 ** (8 * k);
      }
      len += 1;
      if (i + len > src.length || o + len > end) throw new Error('snappy: literal overruns');
      out.set(src.subarray(i, i + len), o);
      i += len;
      o += len;
    } else {
      let len: number;
      let offset: number;
      if (kind === 1) {
        len = ((tag >> 2) & 7) + 4;
        offset = ((tag >> 5) << 8) | src[i++];
      } else if (kind === 2) {
        len = (tag >> 2) + 1;
        offset = src[i] | (src[i + 1] << 8);
        i += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;
        i += 4;
      }
      if (offset === 0 || offset > o - at || o + len > end) throw new Error('snappy: bad copy');
      // A copy that does not overlap itself is one block move; an overlapping one repeats a pattern and must go byte by byte.
      if (offset >= len) out.copyWithin(o, o - offset, o - offset + len);
      else for (let k = 0; k < len; k++) out[o + k] = out[o + k - offset];
      o += len;
    }
  }
  if (o !== end) throw new Error('snappy: length mismatch');
  return n;
}
