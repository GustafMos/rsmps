import { canConnect, paramSocketPorts } from '../../engine/define';
import type { AnyNodeDef, AssetInfo, InputSchema, OutputSchema, ParamSchema, SocketType } from '../../engine/types';

type AssetKind = AssetInfo['kind'];
import type { Registry } from '../../engine/define';

/** Input ports (including wireable params) of a definition that accept a value of `src`, best match first. */
export function inputsAccepting(def: AnyNodeDef, src: SocketType): string[] {
  const exact: string[] = [];
  const loose: string[] = [];
  for (const [port, d] of Object.entries(def.inputs as InputSchema)) {
    if (d.type === src) exact.push(port);
    else if (canConnect(src, d.type)) loose.push(port);
  }
  for (const s of paramSocketPorts(def)) if (s.type === src) loose.push(s.port);
  return [...exact, ...loose];
}

/** Output ports of a definition that can feed an input of type `dst`, best match first. */
export function outputsFeeding(def: AnyNodeDef, dst: SocketType): string[] {
  const exact: string[] = [];
  const loose: string[] = [];
  for (const [port, d] of Object.entries(def.outputs as OutputSchema)) {
    if (d.type === dst) exact.push(port);
    else if (canConnect(d.type, dst)) loose.push(port);
  }
  return [...exact, ...loose];
}

export function isSourceFor(def: AnyNodeDef, kind: AssetKind): string | null {
  if (def.category === 'output') return null;
  // Subtitles has optional inputs (fill picture, palette) but is still where a dropped .srt / .vtt goes.
  const hasInputs = Object.keys(def.inputs).length > 0;
  for (const [key, p] of Object.entries(def.params as ParamSchema)) {
    if (p.type !== 'assets') continue;
    if (hasInputs && p.accept !== 'subtitles') continue;
    const ok =
      p.accept === 'any' ||
      (p.accept === 'image-video' && (kind === 'image' || kind === 'video')) ||
      (p.accept === 'audio' && kind === 'audio') ||
      (p.accept === 'midi' && kind === 'midi') ||
      (p.accept === 'model' && kind === 'model') ||
      (p.accept === 'lut' && kind === 'lut') ||
      (p.accept === 'splat' && kind === 'splat') ||
      (p.accept === 'subtitles' && kind === 'subtitles');
    if (ok) return key;
  }
  return null;
}

/** Find a node type that can host an imported asset of this kind (no hard-coded ids). */
export function sourceDefFor(registry: Registry, kind: AssetKind): { def: AnyNodeDef; key: string } | null {
  const defs = registry.list();
  // prefer category 'input' (e.g. Media In)
  const sorted = [...defs].sort((a, b) => Number(b.category === 'input') - Number(a.category === 'input'));
  for (const def of sorted) {
    const key = isSourceFor(def, kind);
    if (key) return { def, key };
  }
  return null;
}

/** The palette input port of a node that also takes an image (Dither, Quantize…), or null. Generic: found by socket type. */
export function paletteInputPort(def: AnyNodeDef): string | null {
  const ins = Object.entries(def.inputs as InputSchema);
  if (!ins.some(([, d]) => d.type === 'image')) return null;
  return ins.find(([, d]) => d.type === 'palette')?.[0] ?? null;
}
export function firstImagePort(def: AnyNodeDef): string | null {
  return Object.entries(def.inputs as InputSchema).find(([, d]) => d.type === 'image')?.[0] ?? null;
}
