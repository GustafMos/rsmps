/**
 * Splat file readers and the writer. Pure functions on bytes (no GPU, no DOM), tested by generating files and round-tripping them.
 *
 *  - standard 3D Gaussian Splatting `.ply` (binary little endian), as written by the original trainer and most tools:
 *      x y z (nx ny nz) f_dc_0..2 f_rest_* opacity scale_0..2 rot_0..3
 *    colour = 0.28209479177387814 * f_dc + 0.5, opacity = sigmoid(opacity), scale = exp(scale_i), rotation = normalised (w, x, y, z).
 *    Properties are located by NAME and read by their declared type, so extra properties and any order are fine.
 *  - `.splat` (antimatter15's web viewer format): 32 bytes per splat, no header:
 *      0..11 position f32 x3 | 12..23 scale f32 x3 (already linear) | 24..27 rgba u8 | 28..31 rotation u8 x4, (v - 128) / 128, (w, x, y, z)
 *  - refused with a readable error: ASCII / big-endian .ply, compressed .ply (PlayCanvas / SuperSplat: chunk + packed_* properties),
 *    SPZ / gzip, anything that is not a Gaussian splat (a mesh, a plain point cloud).
 */
import { finishCloud, SH_C0, sigmoid, type SplatCloud, type UpHint, MAX_SPLATS_IN_FILE } from './splat-cloud';

export class SplatError extends Error {}

const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

interface Prop {
  name: string;
  type: string;
  offset: number;
}
interface Element {
  name: string;
  count: number;
  props: Prop[];
  list: boolean;
  stride: number;
}

function readerFor(type: string, dv: DataView): (at: number) => number {
  switch (type) {
    case 'float': case 'float32': return (o) => dv.getFloat32(o, true);
    case 'double': case 'float64': return (o) => dv.getFloat64(o, true);
    case 'uchar': case 'uint8': return (o) => dv.getUint8(o);
    case 'char': case 'int8': return (o) => dv.getInt8(o);
    case 'ushort': case 'uint16': return (o) => dv.getUint16(o, true);
    case 'short': case 'int16': return (o) => dv.getInt16(o, true);
    case 'uint': case 'uint32': return (o) => dv.getUint32(o, true);
    default: return (o) => dv.getInt32(o, true);
  }
}

/** Read a PLY header: elements, where the body starts, and the `up` comment. */
function readHeader(bytes: Uint8Array): { elements: Element[]; bodyStart: number; format: string; up: UpHint } {
  const limit = Math.min(bytes.length, 1 << 20);
  let end = -1;
  const marker = 'end_header';
  for (let i = 0; i + marker.length < limit; i++) {
    if (bytes[i] === 0x65 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x64 && bytes[i + 3] === 0x5f) {
      let ok = true;
      for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker.charCodeAt(k)) { ok = false; break; }
      if (ok) {
        end = i + marker.length;
        break;
      }
    }
  }
  if (end < 0) throw new SplatError('This .ply file has no header end ("end_header"): it is damaged or not a PLY file.');
  let bodyStart = end;
  if (bytes[bodyStart] === 0x0d) bodyStart++;
  if (bytes[bodyStart] === 0x0a) bodyStart++;
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, end));
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== 'ply') throw new SplatError('This file does not start with "ply": it is not a PLY file.');
  let format = '';
  let up: UpHint = null;
  const elements: Element[] = [];
  let cur: Element | null = null;
  for (const line of lines.slice(1)) {
    const w = line.split(/\s+/);
    if (w[0] === 'format') format = w[1] ?? '';
    else if (w[0] === 'comment') {
      if (w[1] === 'up' && (w[2] === '+y' || w[2] === '-y' || w[2] === '+z')) up = w[2];
    } else if (w[0] === 'element') {
      cur = { name: w[1], count: Number(w[2]), props: [], list: false, stride: 0 };
      elements.push(cur);
    } else if (w[0] === 'property' && cur) {
      if (w[1] === 'list') {
        cur.list = true;
        continue;
      }
      const size = TYPE_SIZE[w[1]];
      if (!size) throw new SplatError(`This .ply uses a property type this reader does not know ("${w[1]}").`);
      cur.props.push({ name: w[2], type: w[1], offset: cur.stride });
      cur.stride += size;
    }
  }
  return { elements, bodyStart, format, up };
}

/** Standard 3D Gaussian Splatting .ply -> SplatCloud. */
export function parsePly(buffer: ArrayBuffer): SplatCloud {
  const bytes = new Uint8Array(buffer);
  const { elements, bodyStart, format, up } = readHeader(bytes);
  if (format !== 'binary_little_endian') {
    throw new SplatError(
      format === 'ascii'
        ? 'This is an ASCII .ply. Gaussian splat files are binary: re-export it as binary little endian.'
        : `This .ply is "${format || 'of unknown format'}": only binary little endian Gaussian splat files are supported.`,
    );
  }
  const names = new Set(elements.flatMap((e) => e.props.map((p) => p.name)));
  if (elements.some((e) => e.name === 'chunk') || names.has('packed_position') || names.has('packed_rotation')) {
    throw new SplatError('This is a compressed splat .ply (PlayCanvas / SuperSplat "compressed"). Export an uncompressed .ply from the tool that made it.');
  }
  const vertexIndex = elements.findIndex((e) => e.name === 'vertex');
  if (vertexIndex < 0) throw new SplatError('This .ply has no "vertex" element: it is not a Gaussian splat file.');
  const vertex = elements[vertexIndex];
  const has = (n: string) => vertex.props.some((p) => p.name === n);
  const need = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const missing = need.filter((n) => !has(n));
  if (missing.length) {
    throw new SplatError(
      has('x') && !has('scale_0')
        ? 'This .ply is a plain point cloud or mesh, not a Gaussian splat (it has no scale_0..2 / rot_0..3 / opacity). Use the file the splat trainer wrote.'
        : `This .ply is missing the Gaussian splat properties: ${missing.join(', ')}.`,
    );
  }
  const hasDc = has('f_dc_0') && has('f_dc_1') && has('f_dc_2');
  const hasRgb = has('red') && has('green') && has('blue');
  if (!hasDc && !hasRgb) throw new SplatError('This .ply has no color (f_dc_0..2 or red/green/blue).');
  if (vertex.list) throw new SplatError('This .ply has list properties on its vertices: not a Gaussian splat file.');
  const count = vertex.count;
  if (!Number.isFinite(count) || count < 0 || count > MAX_SPLATS_IN_FILE) throw new SplatError(`This .ply claims ${count} splats, which is not plausible.`);
  // elements before the vertex element have to be skipped by size
  let start = bodyStart;
  for (let e = 0; e < vertexIndex; e++) {
    if (elements[e].list) throw new SplatError('This .ply has a list element before its vertices: not a Gaussian splat file.');
    start += elements[e].count * elements[e].stride;
  }
  const need2 = start + count * vertex.stride;
  if (bytes.length < need2) {
    throw new SplatError(`This .ply is cut short: its header promises ${count.toLocaleString('en-US')} splats (${need2.toLocaleString('en-US')} bytes) but the file has ${bytes.length.toLocaleString('en-US')}.`);
  }
  const dv = new DataView(buffer, 0, bytes.length);
  const stride = vertex.stride;
  const offset = (name: string) => vertex.props.find((p) => p.name === name)!;
  const rd = (name: string) => {
    const p = offset(name);
    return { at: p.offset, f: readerFor(p.type, dv) };
  };
  const px = rd('x'), py = rd('y'), pz = rd('z');
  const sx = rd('scale_0'), sy = rd('scale_1'), sz = rd('scale_2');
  const r0 = rd('rot_0'), r1 = rd('rot_1'), r2 = rd('rot_2'), r3 = rd('rot_3');
  const op = rd('opacity');
  const c0 = hasDc ? rd('f_dc_0') : rd('red');
  const c1 = hasDc ? rd('f_dc_1') : rd('green');
  const c2 = hasDc ? rd('f_dc_2') : rd('blue');
  const rgbScale = hasDc ? 1 : 1 / 255;
  // f_rest layout: channel-major, perChannel coefficients per colour channel; degree 1 = the first 3 of each channel
  const restNames = vertex.props.filter((p) => /^f_rest_\d+$/.test(p.name)).map((p) => Number(p.name.slice(7)));
  const nRest = restNames.length ? Math.max(...restNames) + 1 : 0;
  const perChannel = Math.floor(nRest / 3);
  const shDegreeInFile = perChannel >= 15 ? 3 : perChannel >= 8 ? 2 : perChannel >= 3 ? 1 : 0;
  const restReaders: { at: number; f: (o: number) => number }[] = [];
  if (perChannel >= 3 && Array.from({ length: 3 }, (_, c) => [0, 1, 2].every((k) => has(`f_rest_${c * perChannel + k}`))).every(Boolean)) {
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) restReaders.push(rd(`f_rest_${c * perChannel + k}`));
  }

  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const sh1 = restReaders.length ? new Float32Array(count * 9) : null;
  let j = 0;
  for (let i = 0; i < count; i++) {
    const b = start + i * stride;
    const x = px.f(b + px.at), y = py.f(b + py.at), z = pz.f(b + pz.at);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const o = sigmoid(op.f(b + op.at));
    const s0 = Math.exp(sx.f(b + sx.at)), s1 = Math.exp(sy.f(b + sy.at)), s2 = Math.exp(sz.f(b + sz.at));
    if (!Number.isFinite(o) || !Number.isFinite(s0) || !Number.isFinite(s1) || !Number.isFinite(s2)) continue;
    positions[j * 3] = x; positions[j * 3 + 1] = y; positions[j * 3 + 2] = z;
    scales[j * 3] = s0; scales[j * 3 + 1] = s1; scales[j * 3 + 2] = s2;
    let qw = r0.f(b + r0.at), qx = r1.f(b + r1.at), qy = r2.f(b + r2.at), qz = r3.f(b + r3.at);
    const ql = Math.hypot(qw, qx, qy, qz);
    if (ql > 1e-12 && Number.isFinite(ql)) {
      qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    } else {
      qw = 1; qx = 0; qy = 0; qz = 0;
    }
    rotations[j * 4] = qw; rotations[j * 4 + 1] = qx; rotations[j * 4 + 2] = qy; rotations[j * 4 + 3] = qz;
    if (hasDc) {
      colors[j * 3] = SH_C0 * c0.f(b + c0.at) + 0.5;
      colors[j * 3 + 1] = SH_C0 * c1.f(b + c1.at) + 0.5;
      colors[j * 3 + 2] = SH_C0 * c2.f(b + c2.at) + 0.5;
    } else {
      colors[j * 3] = c0.f(b + c0.at) * rgbScale;
      colors[j * 3 + 1] = c1.f(b + c1.at) * rgbScale;
      colors[j * 3 + 2] = c2.f(b + c2.at) * rgbScale;
    }
    opacity[j] = o;
    if (sh1) for (let k = 0; k < 9; k++) sh1[j * 9 + k] = restReaders[k].f(b + restReaders[k].at);
    j++;
  }
  const trim = <T extends Float32Array>(a: T, per: number): T => (j === count ? a : (a.slice(0, j * per) as T));
  return finishCloud(
    {
      count: j,
      positions: trim(positions, 3),
      scales: trim(scales, 3),
      rotations: trim(rotations, 4),
      colors: trim(colors, 3),
      opacity: trim(opacity, 1),
      sh1: sh1 ? trim(sh1, 9) : null,
      shDegreeInFile,
      upHint: up,
    },
    'ply',
  );
}

/** antimatter15 `.splat`: 32 bytes per splat. */
export function parseSplat32(buffer: ArrayBuffer): SplatCloud {
  if (buffer.byteLength % 32 !== 0) throw new SplatError(`This .splat file is ${buffer.byteLength} bytes, which is not a whole number of 32-byte splats.`);
  const count = buffer.byteLength / 32;
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const b = i * 32;
    const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    positions[j * 3] = x; positions[j * 3 + 1] = y; positions[j * 3 + 2] = z;
    scales[j * 3] = dv.getFloat32(b + 12, true); scales[j * 3 + 1] = dv.getFloat32(b + 16, true); scales[j * 3 + 2] = dv.getFloat32(b + 20, true);
    colors[j * 3] = u8[b + 24] / 255; colors[j * 3 + 1] = u8[b + 25] / 255; colors[j * 3 + 2] = u8[b + 26] / 255;
    opacity[j] = u8[b + 27] / 255;
    let qw = (u8[b + 28] - 128) / 128, qx = (u8[b + 29] - 128) / 128, qy = (u8[b + 30] - 128) / 128, qz = (u8[b + 31] - 128) / 128;
    const ql = Math.hypot(qw, qx, qy, qz);
    if (ql > 1e-9) {
      qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    } else {
      qw = 1; qx = 0; qy = 0; qz = 0;
    }
    rotations[j * 4] = qw; rotations[j * 4 + 1] = qx; rotations[j * 4 + 2] = qy; rotations[j * 4 + 3] = qz;
    j++;
  }
  const trim = <T extends Float32Array>(a: T, per: number): T => (j === count ? a : (a.slice(0, j * per) as T));
  return finishCloud({ count: j, positions: trim(positions, 3), scales: trim(scales, 3), rotations: trim(rotations, 4), colors: trim(colors, 3), opacity: trim(opacity, 1) }, 'splat');
}

/** Whatever the file is: a .ply (by its first bytes) or a 32-byte-record .splat. Throws SplatError with a readable message otherwise. */
export function parseSplatBytes(buffer: ArrayBuffer): SplatCloud {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  if (buffer.byteLength === 0) throw new SplatError('This splat file is empty.');
  if (head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79) return parsePly(buffer);
  if (head[0] === 0x1f && head[1] === 0x8b) throw new SplatError('This looks like a gzip-compressed splat (.spz or .ply.gz). Decompress it, or export a plain .ply.');
  if (head[0] === 0x4e && head[1] === 0x47 && head[2] === 0x53 && head[3] === 0x50) throw new SplatError('This is a Niantic SPZ file, which is not supported. Export a plain .ply.');
  if (buffer.byteLength % 32 === 0) return parseSplat32(buffer);
  throw new SplatError('This file is not a Gaussian splat (.ply with scale/rotation/opacity properties, or a 32-byte-record .splat).');
}

/**
 * Write a cloud as a standard 3DGS .ply (binary little endian): the hand-off format of the asset library. Degree-1 spherical harmonics
 * go to f_rest_0..8 (3 per channel); the file is readable by `parsePly` and by viewers that accept reduced SH degrees. `up` is written as
 * `comment up +y` etc. so that the Gaussian Splat node's automatic orientation needs no guessing.
 */
export function writeSplatPly(cloud: SplatCloud, up: UpHint = null): ArrayBuffer {
  const nRest = cloud.sh1 ? 9 : 0;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: nRest }, (_, i) => `f_rest_${i}`), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header =
    `ply\nformat binary_little_endian 1.0\n${up ?? cloud.upHint ? `comment up ${up ?? cloud.upHint}\n` : ''}element vertex ${cloud.count}\n` +
    props.map((p) => `property float ${p}\n`).join('') +
    'end_header\n';
  const head = new TextEncoder().encode(header);
  const stride = props.length * 4;
  const out = new ArrayBuffer(head.length + cloud.count * stride);
  new Uint8Array(out).set(head, 0);
  const dv = new DataView(out, head.length);
  const logit = (p: number) => {
    const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
    return Math.log(c / (1 - c));
  };
  for (let i = 0; i < cloud.count; i++) {
    let o = i * stride;
    const put = (v: number) => {
      dv.setFloat32(o, v, true);
      o += 4;
    };
    put(cloud.positions[i * 3]); put(cloud.positions[i * 3 + 1]); put(cloud.positions[i * 3 + 2]);
    put(0); put(0); put(0);
    put((cloud.colors[i * 3] - 0.5) / SH_C0); put((cloud.colors[i * 3 + 1] - 0.5) / SH_C0); put((cloud.colors[i * 3 + 2] - 0.5) / SH_C0);
    if (cloud.sh1) for (let k = 0; k < 9; k++) put(cloud.sh1[i * 9 + k]);
    put(logit(cloud.opacity[i]));
    put(Math.log(Math.max(cloud.scales[i * 3], 1e-12))); put(Math.log(Math.max(cloud.scales[i * 3 + 1], 1e-12))); put(Math.log(Math.max(cloud.scales[i * 3 + 2], 1e-12)));
    put(cloud.rotations[i * 4]); put(cloud.rotations[i * 4 + 1]); put(cloud.rotations[i * 4 + 2]); put(cloud.rotations[i * 4 + 3]);
  }
  return out;
}
