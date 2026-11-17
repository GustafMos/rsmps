/**
 * Saved group nodes ("Save group as node…"): reusable nodes made from groups, kept in the user's library and shared as small files
 * (`.rsmps-node.json`). A saved node is DATA ONLY: a group record (inner nodes, wires, ports, exposed params). Nothing in it is ever run as
 * code; importing validates it (format, size, known node types, nesting depth) before anything else sees it. Adding one to a graph makes
 * an editable copy (not a live link), so editing the saved node later never changes graphs that already use it.
 *
 * The pure part (file format, validation, instancing) is at the top and tested without a browser; `NodePresetStore` keeps them in
 * IndexedDB (the presets store, ids prefixed `node:`).
 */
import type { Registry } from '../engine/define';
import { groupData, GROUP_TYPE, validateGroupNode, withoutProcessResults } from '../engine/group';
import { CATEGORIES, type Category, type NodeInstance } from '../engine/types';
import { idbAll, idbDelete, idbPut } from './db';

export const NODE_FILE_SCHEMA = 'rsmps/node';
export const NODE_FILE_EXT = '.rsmps-node.json';
/** A saved node file larger than this is refused (a group is a few KB; this leaves room for big palettes and curves). */
export const NODE_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** Key prefix in the presets store. */
export const NODE_PRESET_PREFIX = 'node:';

export interface NodePresetMeta {
  name: string;
  category: Category;
  keywords: string[];
  description: string;
}

/** A saved group node. `group` is a group node record (type `group`) without position, id or stored results. */
export interface NodePreset extends NodePresetMeta {
  id: string;
  group: { type: typeof GROUP_TYPE; params: Record<string, unknown>; label?: string };
  created: number;
}

/** What a `.rsmps-node.json` file holds. */
export interface NodePresetFile extends NodePresetMeta {
  schema: typeof NODE_FILE_SCHEMA;
  version: 1;
  group: NodePreset['group'];
}

/** The API another feature (a template gallery) builds on: `io.nodePresets`. */
export interface NodePresetApi {
  /** Saved nodes, oldest first (loaded by `restore`). */
  list(): NodePreset[];
  subscribe(fn: () => void): () => void;
  /** Load the saved nodes from storage (boot). */
  restore(): Promise<void>;
  /** Save a group node (its inside and exposed params; position and stored results are dropped). */
  save(group: NodeInstance, meta: Partial<NodePresetMeta> & { name: string }): Promise<NodePreset>;
  remove(id: string): Promise<void>;
  /** The text of a `.rsmps-node.json` file for a saved node or a group node. */
  toFile(source: NodePreset | NodeInstance, meta?: Partial<NodePresetMeta>): string;
  /** Validate a file's text without storing it (throws a readable Error). */
  parse(text: string): NodePresetFile;
  /** Validate and store a file. Throws a readable Error. */
  importFile(file: Blob | string): Promise<NodePreset>;
  /** A fresh group node (no id / position yet) to add to a graph: an editable copy. */
  instantiate(preset: NodePreset | NodePresetFile): NodeInstance;
}

const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const category = (v: unknown, fallback: Category = 'math'): Category => (typeof v === 'string' && v in CATEGORIES ? (v as Category) : fallback);

function cleanMeta(meta: Partial<NodePresetMeta>, group: NodePreset['group']): NodePresetMeta {
  const d = groupData(group);
  return {
    name: str(meta.name, 60) || d.title || 'Saved node',
    category: category(meta.category, d.color ?? 'math'),
    keywords: (Array.isArray(meta.keywords) ? meta.keywords : []).filter((k): k is string => typeof k === 'string').map((k) => k.trim().slice(0, 32)).filter(Boolean).slice(0, 16),
    description: str(meta.description, 600) || d.description || '',
  };
}

/** The storable part of a group node: params only, without stored results (inside too), without UI positions of an open group. */
export function groupRecord(node: Pick<NodeInstance, 'type' | 'params' | 'label'>, clearOf: (n: NodeInstance) => Record<string, unknown> | null = () => null): NodePreset['group'] {
  if (node.type !== GROUP_TYPE) throw new Error('Only a group node can be saved as a node.');
  const clean = withoutProcessResults(structuredClone({ id: 'x', x: 0, y: 0, ...node }) as NodeInstance, clearOf);
  const params = { ...clean.params };
  delete params.ui;
  return { type: GROUP_TYPE, params, ...(node.label ? { label: node.label } : {}) };
}

/** Text of a `.rsmps-node.json` file. */
export function nodePresetFileText(group: NodePreset['group'], meta: Partial<NodePresetMeta>): string {
  const file: NodePresetFile = { schema: NODE_FILE_SCHEMA, version: 1, ...cleanMeta(meta, group), group };
  return JSON.stringify(file, null, 1);
}

/**
 * Parse and validate a saved node file. Data only: it must be the documented JSON shape, under the size cap, every node type inside must
 * exist in this app (a missing plugin is named), groups may not nest deeper than the cap. Throws an Error whose message is shown as is.
 */
export function parseNodePresetFile(text: string, registry: Pick<Registry, 'get'>): NodePresetFile {
  if (typeof text !== 'string') throw new Error('This is not a saved node file.');
  if (text.length > NODE_FILE_MAX_BYTES) throw new Error(`This file is too large for a saved node (${Math.round(text.length / 1024)} KB; the limit is ${NODE_FILE_MAX_BYTES / 1024 / 1024} MB).`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a saved node (it is not valid JSON).');
  }
  if (!raw || typeof raw !== 'object') throw new Error('This file is not a saved node.');
  const f = raw as Partial<NodePresetFile>;
  if (f.schema !== NODE_FILE_SCHEMA) throw new Error(`This file is not a saved node (missing "${NODE_FILE_SCHEMA}").`);
  if (f.version !== 1) throw new Error(`Unsupported saved node version ${String(f.version)}; this app reads version 1.`);
  const g = f.group;
  if (!g || typeof g !== 'object' || g.type !== GROUP_TYPE || !g.params || typeof g.params !== 'object') throw new Error('The saved node has no group inside.');
  const problems = validateGroupNode({ id: 'imported', x: 0, y: 0, type: GROUP_TYPE, params: g.params }, registry);
  if (problems.length) throw new Error(`This saved node cannot be used: ${problems.slice(0, 3).join('; ')}.`);
  const group: NodePreset['group'] = { type: GROUP_TYPE, params: g.params as Record<string, unknown>, ...(typeof g.label === 'string' ? { label: g.label.slice(0, 60) } : {}) };
  return { schema: NODE_FILE_SCHEMA, version: 1, ...cleanMeta(f, group), group };
}

/** A fresh group node from a saved one (id and position are given when it is added to a graph). */
export function instantiatePreset(preset: Pick<NodePreset, 'group' | 'name'>): NodeInstance {
  const params = structuredClone(preset.group.params);
  if (!params.title) params.title = preset.name;
  return { id: '', type: GROUP_TYPE, x: 0, y: 0, params, ...(preset.group.label ? { label: preset.group.label } : {}) };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Store                                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Storage seam (IndexedDB in the app, a Map in tests). */
export interface NodePresetStorage {
  all(): Promise<NodePreset[]>;
  put(p: NodePreset): Promise<void>;
  delete(id: string): Promise<void>;
}

export const idbNodePresetStorage: NodePresetStorage = {
  all: async () => (await idbAll<NodePreset & { id: string }>('presets')).filter((p) => typeof p?.id === 'string' && p.id.startsWith(NODE_PRESET_PREFIX) && !!p.group),
  put: (p) => idbPut('presets', p.id, p),
  delete: (id) => idbDelete('presets', id),
};

export class NodePresetStore implements NodePresetApi {
  private items: NodePreset[] = [];
  private listeners = new Set<() => void>();
  private n = 0;

  constructor(
    private registry: Registry,
    private storage: NodePresetStorage = idbNodePresetStorage,
    private clearOf: (n: NodeInstance) => Record<string, unknown> | null = () => null,
  ) {}

  list(): NodePreset[] {
    return this.items;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  async restore(): Promise<void> {
    try {
      const all = await this.storage.all();
      this.items = all.sort((a, b) => a.created - b.created);
    } catch (err) {
      console.warn('Could not load saved nodes:', err);
    }
    this.notify();
  }

  async save(group: NodeInstance, meta: Partial<NodePresetMeta> & { name: string }): Promise<NodePreset> {
    const rec = groupRecord(group, this.clearOf);
    const problems = validateGroupNode({ ...group, params: rec.params }, this.registry);
    if (problems.length) throw new Error(`This group cannot be saved: ${problems[0]}.`);
    const preset: NodePreset = { id: `${NODE_PRESET_PREFIX}${Date.now().toString(36)}${(++this.n).toString(36)}`, ...cleanMeta(meta, rec), group: rec, created: Date.now() };
    await this.storage.put(preset);
    this.items = [...this.items, preset];
    this.notify();
    return preset;
  }

  async remove(id: string): Promise<void> {
    await this.storage.delete(id);
    this.items = this.items.filter((p) => p.id !== id);
    this.notify();
  }

  toFile(source: NodePreset | NodeInstance, meta: Partial<NodePresetMeta> = {}): string {
    if ('group' in source && 'created' in source) return nodePresetFileText(source.group, { ...source, ...meta });
    const node = source as NodeInstance;
    return nodePresetFileText(groupRecord(node, this.clearOf), { name: node.label || groupData(node).title || 'Saved node', ...meta });
  }

  parse(text: string): NodePresetFile {
    return parseNodePresetFile(text, this.registry);
  }

  async importFile(file: Blob | string): Promise<NodePreset> {
    if (typeof file !== 'string' && file.size > NODE_FILE_MAX_BYTES) throw new Error(`This file is too large for a saved node (the limit is ${NODE_FILE_MAX_BYTES / 1024 / 1024} MB).`);
    const text = typeof file === 'string' ? file : await file.text();
    const parsed = this.parse(text);
    return this.save({ id: 'imported', type: GROUP_TYPE, x: 0, y: 0, params: parsed.group.params, label: parsed.group.label }, parsed);
  }

  instantiate(preset: NodePreset | NodePresetFile): NodeInstance {
    return instantiatePreset(preset);
  }
}
