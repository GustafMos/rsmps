/**
 * Sharing a look: a graph WITHOUT media, as a small `.rsmps.json` file or as a link whose URL FRAGMENT (`#g=...`) holds the same data
 * (deflate, then base64url). The fragment is never sent to a server.
 *
 * Everything that comes in is UNTRUSTED DATA and is never run:
 *  - the text is size-capped before parsing, the deflated payload is inflated in small steps and stopped at a cap (zip-bomb guard);
 *  - the JSON root must be a plain object; every value is copied by `safeClone` (own keys only, `__proto__` / `constructor` /
 *    `prototype` are dropped, depth / key / array / string budgets), so a payload cannot pollute prototypes or smuggle huge data;
 *  - node ids must be plain identifiers; params not declared by the node type are dropped (and counted in the report);
 *  - asset params become placeholders (name and kind only), saved results of process nodes are removed;
 *  - live sources that would make the app fetch from a remote host (URL / phone / camera sources) are dropped;
 *  - groups are checked with the same validator as saved group nodes (`validateGroupNode`);
 *  - plugin node types that are missing are LISTED (needs plugin X), never installed. A Custom Shader's WGSL is just a string param: it
 *    compiles on the GPU and cannot run JavaScript; the confirmation still says "contains a custom shader".
 * Pure: no DOM, no storage (base64 uses `btoa` / `atob`, available in browsers and Node).
 */
import { Inflate, deflateSync } from 'fflate';
import type { Registry } from '../engine/define';
import { GROUP_KEYS, GROUP_MAX_DEPTH, GROUP_TYPE, validateGroupNode } from '../engine/group';
import { DEFAULT_PROJECT, type Edge, type FrameBox, type GraphDoc, type NodeInstance, type ParamDef, type ProjectSettings } from '../engine/types';

export const SHARE_VERSION = 1;
export const SHARE_FILE_EXT = '.rsmps.json';
export const SHARE_HASH_KEY = 'g';

export const SHARE_LIMITS = {
  /** Text of a file / decompressed link payload, bytes (chars). */
  maxJsonChars: 2 * 1024 * 1024,
  /** Fragment (base64url) above this is refused as a link: offer the file. */
  maxFragmentChars: 60_000,
  /** Fragment above this gets a warning (long links break in chats and some mailers). */
  warnFragmentChars: 8_000,
  maxNodes: 1500,
  maxEdges: 6000,
  maxFrames: 200,
  maxDepth: 40,
  maxKeys: 400_000,
  maxString: 200_000,
  maxArray: 100_000,
  /** Compressed bytes fed to the inflater per step; with a 1032:1 ratio worst case, overshoot stays near 1 MB. */
  inflateStep: 1024,
} as const;

const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PROCESS_KEY = '__process';

export class ShareError extends Error {
  constructor(message: string, readonly code: 'format' | 'too-large' | 'corrupt' | 'unsupported' | 'empty' = 'format') {
    super(message);
    this.name = 'ShareError';
  }
}

/** One media slot that was emptied. */
export interface SharePlaceholder {
  node: string;
  param: string;
  /** Names of the media that was there (as far as the sender knew them). */
  names: string[];
  kind: string;
}

export interface ShareReport {
  nodeCount: number;
  /** Node type id -> how many. */
  nodeTypes: Record<string, number>;
  /** Node types this app does not have (a plugin is missing). */
  needsPlugins: string[];
  placeholders: SharePlaceholder[];
  /** Short notes about things that were removed (unknown fields, live sources, results...). */
  dropped: string[];
  hasShader: boolean;
}

export interface SharedDoc extends GraphDoc {
  share?: { v: number; placeholders: SharePlaceholder[] };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Safe copy                                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------------------ */

interface Budget {
  keys: number;
  notes: string[];
}

/**
 * Deep copy of JSON data with own-property semantics: banned keys are skipped, functions / undefined / symbols are skipped, non-finite
 * numbers become null, and depth / key / string / array budgets are enforced (throws ShareError('too-large')).
 */
export function safeClone(value: unknown, budget: Budget = { keys: 0, notes: [] }, depth = 0): unknown {
  if (depth > SHARE_LIMITS.maxDepth) throw new ShareError('The shared data is nested too deeply.', 'too-large');
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'string':
      if (value.length > SHARE_LIMITS.maxString) throw new ShareError('The shared data contains a text that is too long.', 'too-large');
      return value;
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length > SHARE_LIMITS.maxArray) throw new ShareError('The shared data contains a list that is too long.', 'too-large');
        budget.keys += value.length;
        if (budget.keys > SHARE_LIMITS.maxKeys) throw new ShareError('The shared data is too large.', 'too-large');
        return value.map((v) => safeClone(v, budget, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object)) {
        if (BANNED_KEYS.has(key)) {
          budget.notes.push(`removed key "${key}"`);
          continue;
        }
        if (++budget.keys > SHARE_LIMITS.maxKeys) throw new ShareError('The shared data is too large.', 'too-large');
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') continue;
        Object.defineProperty(out, key, { value: safeClone(v, budget, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default:
      return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const safeId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !BANNED_KEYS.has(v);
const jsonEq = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** A live source value (camera / URL / phone) that would make the app reach out. */
const isLiveSource = (v: unknown): boolean => isObj(v) && (v.kind === 'url' || v.kind === 'phone' || v.kind === 'camera');

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Cleaning a graph                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface CleanOptions {
  /** Drop params equal to the node's default (smaller links). */
  compact?: boolean;
  /** Names of media by asset id (for placeholders when SENDING). */
  assetInfo?: (id: string) => { name: string; kind: string } | undefined;
}

type Reg = Pick<Registry, 'get'>;

class Cleaner {
  report: ShareReport = { nodeCount: 0, nodeTypes: {}, needsPlugins: [], placeholders: [], dropped: [], hasShader: false };
  private budget: Budget = { keys: 0, notes: [] };
  private droppedKeys = 0;
  private liveDropped = 0;
  constructor(private registry: Reg, private opts: CleanOptions) {}

  note(msg: string): void {
    if (this.report.dropped.length < 30 && !this.report.dropped.includes(msg)) this.report.dropped.push(msg);
  }

  finish(): ShareReport {
    if (this.droppedKeys) this.note(`${this.droppedKeys} unknown setting${this.droppedKeys === 1 ? '' : 's'} removed`);
    if (this.liveDropped) this.note(`${this.liveDropped} live source${this.liveDropped === 1 ? '' : 's'} (camera, web address or phone) removed`);
    const banned = this.budget.notes.length;
    if (banned) this.note(`${banned} unsafe key${banned === 1 ? '' : 's'} removed`);
    this.report.needsPlugins.sort();
    return this.report;
  }

  node(raw: unknown, depth: number, top: boolean): NodeInstance | null {
    if (!isObj(raw)) return null;
    if (!safeId(raw.id) || typeof raw.type !== 'string' || !raw.type || raw.type.length > 80) {
      this.note('a damaged node was removed');
      return null;
    }
    const id = raw.id;
    const type = raw.type;
    const def = type === GROUP_TYPE ? undefined : this.registry.get(type);
    const rawParams = isObj(raw.params) ? raw.params : {};
    let params: Record<string, unknown> = {};

    if (type === GROUP_TYPE) {
      if (depth >= GROUP_MAX_DEPTH) {
        this.note('a group nested too deeply was removed');
        return null;
      }
      for (const key of Object.keys(rawParams)) {
        if (key === PROCESS_KEY) continue;
        if (key === 'ui') continue; // open-view state
        if (!GROUP_KEYS.includes(key)) {
          this.droppedKeys++;
          continue;
        }
        if (key === 'nodes') {
          const list = Array.isArray(rawParams.nodes) ? rawParams.nodes : [];
          if (list.length > SHARE_LIMITS.maxNodes) throw new ShareError('A group contains too many nodes.', 'too-large');
          params.nodes = list.map((n) => this.node(n, depth + 1, false)).filter((n): n is NodeInstance => !!n);
        } else params[key] = safeClone(rawParams[key], this.budget);
      }
      if (!Array.isArray(params.nodes)) params.nodes = [];
      if (!Array.isArray(params.edges)) params.edges = [];
      const kept = new Set((params.nodes as NodeInstance[]).map((n) => n.id));
      params.edges = (params.edges as unknown[]).filter((e) => isObj(e) && isObj(e.from) && isObj(e.to));
      void kept;
      const problems = validateGroupNode({ id, type, x: 0, y: 0, params }, this.registry);
      if (problems.length) {
        this.note(`a group was removed (${problems[0]})`);
        return null;
      }
    } else if (def) {
      const declared = def.params as Record<string, ParamDef>;
      for (const key of Object.keys(rawParams)) {
        if (BANNED_KEYS.has(key)) {
          this.budget.notes.push(key);
          continue;
        }
        const p = declared[key];
        if (key === PROCESS_KEY) continue;
        if (!p) {
          this.droppedKeys++;
          continue;
        }
        const v = this.param(id, key, p, rawParams[key], def.id);
        if (v === undefined) continue;
        if (this.opts.compact && jsonEq(v, p.default)) continue;
        params[key] = v;
      }
    } else {
      // Unknown type (plugin): keep the data as is (copied safely) so the sender's graph can be inspected; it is listed as needing a plugin.
      for (const key of Object.keys(rawParams)) {
        if (key === PROCESS_KEY) continue;
        if (BANNED_KEYS.has(key)) {
          this.budget.notes.push(key);
          continue;
        }
        const v = rawParams[key];
        if (isLiveSource(v)) {
          this.liveDropped++;
          continue;
        }
        const c = safeClone(v, this.budget);
        if (c !== undefined) params[key] = c;
      }
      if (!this.report.needsPlugins.includes(type)) this.report.needsPlugins.push(type);
    }

    const out: NodeInstance = { id, type, x: num(raw.x, 0), y: num(raw.y, 0), params };
    if (raw.bypass === true) out.bypass = true;
    if (typeof raw.label === 'string' && raw.label) out.label = raw.label.slice(0, 80);
    if (raw.collapsed === true) out.collapsed = true;
    if (top && typeof raw.frame === 'string' && safeId(raw.frame)) out.frame = raw.frame;
    if (top) {
      this.report.nodeCount++;
      this.report.nodeTypes[type] = (this.report.nodeTypes[type] ?? 0) + 1;
      if (type === 'custom-shader') this.report.hasShader = true;
    } else if (type === 'custom-shader') this.report.hasShader = true;
    return out;
  }

  private param(nodeId: string, key: string, p: ParamDef, v: unknown, _type: string): unknown {
    switch (p.type) {
      case 'assets': {
        const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        if (ids.length) {
          const names = ids.map((id) => this.opts.assetInfo?.(id)?.name ?? 'media').slice(0, 20);
          const kind = ids.length ? (this.opts.assetInfo?.(ids[0])?.kind ?? String(p.accept)) : String(p.accept);
          this.report.placeholders.push({ node: nodeId, param: key, names: names.map((n) => n.slice(0, 80)), kind });
        }
        return [];
      }
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      case 'bool':
        return typeof v === 'boolean' ? v : undefined;
      case 'string':
      case 'enum':
      case 'color':
      case 'device': {
        if (p.type === 'device') return ''; // a device id means nothing on another machine
        if (typeof v === 'string') {
          if (v.length > SHARE_LIMITS.maxString) throw new ShareError('The shared data contains a text that is too long.', 'too-large');
          return v;
        }
        // colors are sometimes arrays: copy them safely
        return p.type === 'color' ? safeClone(v, this.budget) : undefined;
      }
      default: {
        if (isLiveSource(v)) {
          this.liveDropped++;
          return undefined;
        }
        return safeClone(v, this.budget);
      }
    }
  }

  project(raw: unknown): ProjectSettings {
    const p = isObj(raw) ? raw : {};
    const d = DEFAULT_PROJECT;
    const clamp = (v: unknown, lo: number, hi: number, f: number) => Math.min(hi, Math.max(lo, num(v, f)));
    const out: ProjectSettings = {
      ...d,
      width: Math.round(clamp(p.width, 1, 16384, d.width)),
      height: Math.round(clamp(p.height, 1, 16384, d.height)),
      fps: clamp(p.fps, 1, 240, d.fps),
      duration: clamp(p.duration, 0.01, 36000, d.duration),
      loop: typeof p.loop === 'boolean' ? p.loop : d.loop,
      lengthMode: p.lengthMode === 'absolute' ? 'absolute' : 'relative',
      referenceSide: clamp(p.referenceSide, 1, 16384, d.referenceSide),
    };
    return out;
  }
}

/** Clean a graph for sending: media removed, defaults dropped (compact), results removed. */
export function prepareShare(graph: GraphDoc, registry: Reg, opts: CleanOptions = {}): { doc: SharedDoc; report: ShareReport } {
  return clean(graph, registry, { compact: true, ...opts }, true);
}

function clean(raw: unknown, registry: Reg, opts: CleanOptions, sending: boolean): { doc: SharedDoc; report: ShareReport } {
  if (!isObj(raw)) throw new ShareError('This is not a shared graph (the root must be an object).');
  if (raw.schema !== 'rsmps/graph') throw new ShareError('This is not an RSMPS graph (missing "rsmps/graph").', 'format');
  if (raw.version !== 2) throw new ShareError(`Unsupported graph version ${String(raw.version)}; this app reads version 2.`, 'unsupported');
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new ShareError('The shared graph is damaged (nodes or wires missing).', 'corrupt');
  if (raw.nodes.length > SHARE_LIMITS.maxNodes) throw new ShareError(`Too many nodes (${raw.nodes.length}; the limit is ${SHARE_LIMITS.maxNodes}).`, 'too-large');
  if (raw.edges.length > SHARE_LIMITS.maxEdges) throw new ShareError('Too many wires.', 'too-large');
  if (raw.nodes.length === 0) throw new ShareError('The shared graph has no nodes.', 'empty');

  const c = new Cleaner(registry, opts);
  const nodes: NodeInstance[] = [];
  const seen = new Set<string>();
  for (const n of raw.nodes) {
    const node = c.node(n, 0, true);
    if (!node) continue;
    if (seen.has(node.id)) {
      c.note('a node with a repeated id was removed');
      continue;
    }
    seen.add(node.id);
    nodes.push(node);
  }
  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  for (const e of raw.edges) {
    if (!isObj(e) || !isObj(e.from) || !isObj(e.to) || !safeId(e.id) || edgeIds.has(e.id)) {
      c.note('a damaged wire was removed');
      continue;
    }
    const f = e.from, t = e.to;
    if (!safeId(f.node) || !safeId(t.node) || typeof f.port !== 'string' || typeof t.port !== 'string' || f.port.length > 80 || t.port.length > 80 || BANNED_KEYS.has(f.port) || BANNED_KEYS.has(t.port)) {
      c.note('a damaged wire was removed');
      continue;
    }
    if (!seen.has(f.node) || !seen.has(t.node)) {
      c.note('a wire to a removed node was removed');
      continue;
    }
    edgeIds.add(e.id);
    edges.push({ id: e.id, from: { node: f.node, port: f.port }, to: { node: t.node, port: t.port } });
  }
  const frames: FrameBox[] = [];
  if (Array.isArray(raw.frames)) {
    for (const f of raw.frames.slice(0, SHARE_LIMITS.maxFrames)) {
      if (isObj(f) && safeId(f.id)) frames.push({ id: f.id, label: typeof f.label === 'string' ? f.label.slice(0, 80) : '', color: typeof f.color === 'string' ? f.color.slice(0, 32) : '#888888', ...(f.collapsed === true ? { collapsed: true } : {}) });
    }
  }
  // Placeholders: a label on each emptied media node tells the receiver what to drop there.
  if (!sending && isObj(raw.share) && Array.isArray(raw.share.placeholders)) {
    for (const p of raw.share.placeholders.slice(0, 200)) {
      if (!isObj(p) || !safeId(p.node) || !seen.has(p.node) || typeof p.param !== 'string' || p.param.length > 80 || BANNED_KEYS.has(p.param)) continue;
      const names = (Array.isArray(p.names) ? p.names : []).filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 80));
      c.report.placeholders.push({ node: p.node, param: p.param, names, kind: typeof p.kind === 'string' ? p.kind.slice(0, 20) : 'any' });
    }
  }
  const placeholders = c.report.placeholders;
  if (!sending) {
    for (const n of nodes) {
      const ph = placeholders.find((p) => p.node === n.id);
      if (ph && !n.label) n.label = `Drop ${ph.names[0] && ph.names[0] !== 'media' ? ph.names[0] : `your ${ph.kind === 'any' ? 'media' : ph.kind}`} here`.slice(0, 60);
    }
  }
  const report = c.finish();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Shared look';
  const doc: SharedDoc = {
    schema: 'rsmps/graph',
    version: 2,
    name,
    project: c.project(raw.project),
    nodes,
    edges,
    ...(frames.length ? { frames } : {}),
    ...(placeholders.length ? { share: { v: SHARE_VERSION, placeholders } } : {}),
  };
  return { doc, report };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* File                                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Text of a share file (a `.rsmps.json` graph without media; opens in any RSMPS version that reads graphs). */
export function shareFileText(graph: GraphDoc, registry: Reg, opts: CleanOptions = {}): { text: string; report: ShareReport } {
  const { doc, report } = clean(graph, registry, { ...opts, compact: false }, true);
  return { text: JSON.stringify(doc, null, 1), report };
}

/** Parse + sanitize the text of a share file (or any `.rsmps.json`). Never executes anything. */
export function parseShareText(text: string, registry: Reg): { graph: GraphDoc; report: ShareReport } {
  if (typeof text !== 'string') throw new ShareError('This is not a shared graph.');
  if (text.length > SHARE_LIMITS.maxJsonChars) throw new ShareError(`This file is too large to import as a shared look (${Math.round(text.length / 1024)} KB).`, 'too-large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ShareError('This is not a shared graph (it is not valid JSON).', 'corrupt');
  }
  return parseShared(raw, registry);
}

/** Sanitize already-parsed data (a file or a decoded link). */
export function parseShared(raw: unknown, registry: Reg): { graph: GraphDoc; report: ShareReport } {
  const { doc, report } = clean(raw, registry, {}, false);
  const { share: _share, ...graph } = doc;
  void _share;
  return { graph, report };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Link                                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ShareError('The link is damaged (unexpected characters).', 'corrupt');
  if (text.length % 4 === 1) throw new ShareError('The link is damaged (cut off).', 'corrupt');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new ShareError('The link is damaged.', 'corrupt');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Inflate with a hard output cap, in small steps, so a compression bomb is stopped early. */
export function inflateLimited(data: Uint8Array, maxBytes: number = SHARE_LIMITS.maxJsonChars): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failed: ShareError | null = null;
  const inf = new Inflate((chunk) => {
    total += chunk.length;
    if (total > maxBytes) {
      failed = new ShareError('The link expands to more data than is allowed.', 'too-large');
      return;
    }
    chunks.push(chunk);
  });
  try {
    for (let i = 0; i < data.length && !failed; i += SHARE_LIMITS.inflateStep) {
      inf.push(data.subarray(i, i + SHARE_LIMITS.inflateStep), i + SHARE_LIMITS.inflateStep >= data.length);
    }
  } catch {
    throw failed ?? new ShareError('The link is damaged (it cannot be unpacked).', 'corrupt');
  }
  if (failed) throw failed;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export type LinkSize = 'ok' | 'warn' | 'too-large';

export interface EncodedLink {
  /** The base64url payload (without `g=`). */
  payload: string;
  /** `#g=...` */
  fragment: string;
  chars: number;
  size: LinkSize;
  report: ShareReport;
}

/** Encode a graph as a link payload. `size` says whether it is fine, long (warn) or too large for a link (offer the file). */
export function encodeShareLink(graph: GraphDoc, registry: Reg, opts: CleanOptions = {}): EncodedLink {
  const { doc, report } = prepareShare(graph, registry, opts);
  const json = JSON.stringify(doc);
  const payload = toBase64Url(deflateSync(enc.encode(json), { level: 9 }));
  const chars = payload.length;
  const size: LinkSize = chars > SHARE_LIMITS.maxFragmentChars ? 'too-large' : chars > SHARE_LIMITS.warnFragmentChars ? 'warn' : 'ok';
  return { payload, fragment: `#${SHARE_HASH_KEY}=${payload}`, chars, size, report };
}

/** The payload of a location hash (`#g=...`), or null when the hash is not a share link. */
export function readShareHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    if (part.startsWith(`${SHARE_HASH_KEY}=`)) return part.slice(SHARE_HASH_KEY.length + 1);
  }
  return null;
}

/** Decode and sanitize a payload. Throws ShareError with a readable message. */
export function decodeShareLink(payload: string, registry: Reg): { graph: GraphDoc; report: ShareReport } {
  if (!payload) throw new ShareError('The link has no data.', 'empty');
  if (payload.length > SHARE_LIMITS.maxFragmentChars * 2) throw new ShareError('The link is too large.', 'too-large');
  const bytes = fromBase64Url(payload);
  const raw = inflateLimited(bytes);
  let text: string;
  try {
    text = dec.decode(raw);
  } catch {
    throw new ShareError('The link is damaged (not text).', 'corrupt');
  }
  return parseShareText(text, registry);
}

/** The address with the share hash removed (for `history.replaceState` after the confirmation). */
export function withoutShareHash(url: string): string {
  const i = url.indexOf('#');
  if (i < 0) return url;
  const kept = url.slice(i + 1).split('&').filter((p) => !p.startsWith(`${SHARE_HASH_KEY}=`));
  return url.slice(0, i) + (kept.length ? `#${kept.join('&')}` : '');
}

/** One line for the confirmation: "12 nodes: Blur x2, Grain ...". */
export function shareSummary(report: ShareReport, title: (type: string) => string = (t) => t): string {
  const top = Object.entries(report.nodeTypes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
  const list = top.map(([t, n]) => (n > 1 ? `${title(t)} x${n}` : title(t))).join(', ');
  return `${report.nodeCount} node${report.nodeCount === 1 ? '' : 's'}${list ? `: ${list}` : ''}`;
}
