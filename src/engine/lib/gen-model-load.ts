import { parseGltf } from './gen-gltf';
import { ModelError, type ParsedModel } from './gen-model';
import { parseObj } from './gen-obj';

/** Detect the format from the bytes (.glb magic, JSON for .gltf, otherwise .obj text) and parse. */
export function parseModelBytes(buf: ArrayBuffer): ParsedModel {
  if (buf.byteLength < 4) throw new ModelError('This file is empty or too small to be a 3D model.');
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 256));
  if (head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return parseGltf(buf);
  const firstText = new TextDecoder().decode(head).trimStart()[0];
  if (firstText === '{') return parseGltf(buf);
  if (head.some((b) => b === 0)) throw new ModelError('Unrecognised 3D file. Supported formats: .glb, .gltf (self-contained) and .obj.');
  return parseObj(buf);
}
