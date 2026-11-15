/** Graph loading and command-line overrides (inputs, --set, --size, ...). Pure functions over GraphDoc. */
import { readFileSync } from 'node:fs';
import type { Registry } from '../engine/define';
import { setParam } from '../engine/graph';
import { DEFAULT_PROJECT, type GraphDoc, type NodeInstance, type ParamDef } from '../engine/types';
import { expandInputs } from './media';

/** Parse and normalise a graph document (same rules as the app's project loader, without its browser imports). */
export function parseGraph(raw: unknown): GraphDoc {
  if (!raw || typeof raw !== 'object') throw new Error('This file is not an RSMPS project.');
  const doc = raw as Partial<GraphDoc>;
  if (doc.schema !== 'rsmps/graph') throw new Error('This file is not an RSMPS project (missing "rsmps/graph" schema).');
  if (doc.version !== 2) throw new Error(`Unsupported project version ${String(doc.version)}; this tool reads version 2.`);
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('The project file is damaged (nodes or wires missing).');
  return {
    schema: 'rsmps/graph',
    version: 2,
    name: typeof doc.name === 'string' ? doc.name : 'Untitled',
    project: { ...DEFAULT_PROJECT, ...(doc.project ?? {}) },
    nodes: doc.nodes,
    edges: doc.edges,
    frames: Array.isArray(doc.frames) ? doc.frames : [],
  };
}

export function loadGraph(file: string): GraphDoc {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read graph file: ${file}`);
  }
  try {
    return parseGraph(JSON.parse(text.replace(/^﻿/, '')));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
}

/** Find a node by id, then by label (case-insensitive), then by unique type id. */
export function findNode(graph: GraphDoc, ref: string): NodeInstance {
  const byId = graph.nodes.find((n) => n.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const byLabel = graph.nodes.filter((n) => (n.label ?? '').toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`Node label "${ref}" is ambiguous (${byLabel.map((n) => n.id).join(', ')}): use the id.`);
  const byType = graph.nodes.filter((n) => n.type.toLowerCase() === lower);
  if (byType.length === 1) return byType[0];
  if (byType.length > 1) throw new Error(`Several "${ref}" nodes exist (${byType.map((n) => n.id).join(', ')}): use the id or give them labels.`);
  throw new Error(`No node matches "${ref}". Nodes: ${graph.nodes.map((n) => n.label || n.id).join(', ')}`);
}

export interface GraphOverrides {
  size?: string;
  fps?: number;
  duration?: number;
  loop?: boolean;
  sets?: string[];
}

export function parseSize(s: string): { width: number; height: number } {
  const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(s.trim());
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error(`Bad --size "${s}": expected WIDTHxHEIGHT, e.g. 1920x1080.`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Parse a --set value: JSON when it parses, otherwise the raw string (so `--set out.name={name}_x` works). */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function applyOverrides(graph: GraphDoc, registry: Registry, o: GraphOverrides): GraphDoc {
  let g = graph;
  const project = { ...g.project };
  if (o.size) Object.assign(project, parseSize(o.size));
  if (o.fps !== undefined) project.fps = o.fps;
  if (o.duration !== undefined) project.duration = o.duration;
  if (o.loop !== undefined) project.loop = o.loop;
  g = { ...g, project };
  for (const s of o.sets ?? []) {
    const eq = s.indexOf('=');
    if (eq < 1) throw new Error(`Bad --set "${s}": expected <node>.<param>=<json>.`);
    const target = s.slice(0, eq);
    const dot = target.lastIndexOf('.');
    if (dot < 1) throw new Error(`Bad --set "${s}": expected <node>.<param>=<json>.`);
    const node = findNode(g, target.slice(0, dot));
    const param = target.slice(dot + 1);
    const def = registry.get(node.type);
    if (def && !(param in def.params)) {
      throw new Error(`Node "${node.label || node.id}" (${node.type}) has no param "${param}". Params: ${Object.keys(def.params).join(', ')}`);
    }
    g = setParam(g, node.id, param, parseValue(s.slice(eq + 1)));
  }
  return g;
}

export interface InputAssignment {
  /** Positional inputs: go to the first Media In node. */
  positional: string[];
  /** `--input node=path` entries. */
  targeted: { node: string; paths: string[] }[];
  recursive?: boolean;
  sequence?: boolean;
}

/** Fill `assets` params from command-line inputs. Returns the new graph and a description per node. */
export function assignInputs(graph: GraphDoc, registry: Registry, a: InputAssignment): { graph: GraphDoc; assigned: { node: string; count: number }[] } {
  let g = graph;
  const assigned: { node: string; count: number }[] = [];
  const assetsParam = (node: NodeInstance): string => {
    const def = registry.get(node.type);
    const key = def && Object.entries(def.params).find(([, p]) => (p as ParamDef).type === 'assets')?.[0];
    if (!key) throw new Error(`Node "${node.label || node.id}" (${node.type}) has no media/assets param.`);
    return key;
  };
  const opts = { recursive: a.recursive, sequence: a.sequence };
  if (a.positional.length) {
    const first = g.nodes.find((n) => n.type === 'media-in');
    if (!first) throw new Error('The graph has no Media In node to receive the input files. Use --input <node>=<path> to target another node.');
    const ids = expandInputs(a.positional, opts);
    g = setParam(g, first.id, assetsParam(first), ids);
    assigned.push({ node: first.label || first.id, count: ids.length });
  }
  for (const t of a.targeted) {
    const node = findNode(g, t.node);
    const ids = expandInputs(t.paths, opts);
    g = setParam(g, node.id, assetsParam(node), ids);
    assigned.push({ node: node.label || node.id, count: ids.length });
  }
  return { graph: g, assigned };
}

/** "1-3,7,10-" (1-based, inclusive) → 0-based indices below `count`. */
export function parseItemRange(spec: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)(?:\s*-\s*(\d*))?$/.exec(part);
    if (!m || (m[1] === '' && !m[2])) throw new Error(`Bad --items "${spec}": use numbers and ranges like 1-5,8,10-.`);
    const a = m[1] === '' ? 1 : Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? count : Number(m[2]);
    if (a < 1 || b < a) throw new Error(`Bad --items range "${part}".`);
    for (let i = a; i <= Math.min(b, count); i++) out.add(i - 1);
  }
  if (out.size === 0) throw new Error(`--items "${spec}" selects nothing (the batch has ${count} items).`);
  return [...out].sort((x, y) => x - y);
}
