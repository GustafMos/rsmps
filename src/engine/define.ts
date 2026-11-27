import type { AnyNodeDef, InputSchema, NodeDef, OutputSchema, ParamSchema, SocketType } from './types';

/**
 * Declare a node. Built-in nodes and plugins use this same function.
 * The generics infer `ctx.params`, `ctx.in` and the return type from the schemas.
 */
export function defineNode<const P extends ParamSchema, const I extends InputSchema, const O extends OutputSchema>(
  def: NodeDef<P, I, O>,
): NodeDef<P, I, O> {
  return def;
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)?$/;

/** Returns a list of problems with a definition (empty = valid). Run on every registration. */
export function validateDef(def: AnyNodeDef): string[] {
  const problems: string[] = [];
  if (!def || typeof def !== 'object') return ['not an object'];
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) problems.push(`id "${def.id}" must be kebab-case (optionally "plugin/name")`);
  if (!def.title) problems.push('missing title');
  if (!def.description) problems.push('missing description');
  if (!def.render && !def.audio) problems.push('needs render() or audio');
  const inputs = Object.keys(def.inputs ?? {});
  const params = Object.keys(def.params ?? {});
  for (const key of params) {
    if (inputs.includes(key)) problems.push(`"${key}" is both an input and a param`);
    const p = def.params[key];
    if (p.type === 'number') {
      if (typeof p.default !== 'number' || Number.isNaN(p.default)) problems.push(`param ${key}: bad default`);
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) problems.push(`param ${key}: min > max`);
    }
    if (p.type === 'enum' && !p.options.some((o: { value: string }) => o.value === p.default)) {
      problems.push(`param ${key}: default not in options`);
    }
  }
  if (Object.keys(def.outputs ?? {}).length === 0 && def.category !== 'output') problems.push('no outputs');
  if (def.guide) {
    if (!def.guide.does || !def.guide.steps?.length) problems.push('guide: needs "does" and at least one step');
    for (const n of def.guide.needs ?? []) if (!inputs.includes(n.input)) problems.push(`guide: needs "${n.input}" is not an input`);
  }
  if (def.process) {
    const pr = def.process;
    if (!pr.title) problems.push('process: missing title');
    if (!['bypass', 'preview', 'last', 'placeholder'].includes(pr.standIn)) problems.push(`process: standIn must be bypass, preview, last or placeholder (got "${pr.standIn}")`);
    if (typeof pr.run !== 'function') problems.push('process: run() is required');
    if (typeof pr.signature !== 'function') problems.push('process: signature() is required');
    if (pr.required !== undefined && !['always', 'once-run', 'never'].includes(pr.required)) problems.push('process: required must be always, once-run or never');
    if (!def.render) problems.push('process: the node needs render() to show its stand-in and its result');
    if (pr.standIn === 'placeholder' && !Object.values((def.outputs ?? {}) as Record<string, { type: string }>).some((o) => o.type === 'image')) problems.push('process: a placeholder stand-in needs an image output');
  }
  return problems;
}

export class Registry {
  private defs = new Map<string, AnyNodeDef>();
  private listeners = new Set<() => void>();

  register(def: AnyNodeDef): void {
    const problems = validateDef(def);
    if (problems.length) throw new Error(`Invalid node "${def?.id}": ${problems.join('; ')}`);
    if (def.maskable) {
      if ('mask' in def.inputs || 'mix' in def.params) throw new Error(`Invalid node "${def.id}": maskable nodes must not declare "mask" or "mix" themselves`);
      def = {
        ...def,
        inputs: { ...def.inputs, mask: { type: 'mask', label: 'Mask' } },
        params: { ...def.params, mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' } },
      };
    }
    this.defs.set(def.id, def);
    this.listeners.forEach((fn) => fn());
  }

  /** Register every NodeDef found among a module's exports (default export may be a def or an array of defs). */
  registerModule(mod: Record<string, unknown>): string[] {
    const ids: string[] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && 'id' in v && 'inputs' in v && 'outputs' in v && 'params' in v) {
        this.register(v as AnyNodeDef);
        ids.push((v as AnyNodeDef).id);
      }
    };
    Object.values(mod).forEach(visit);
    return ids;
  }

  unregister(id: string): void {
    this.defs.delete(id);
    this.listeners.forEach((fn) => fn());
  }

  get(id: string): AnyNodeDef | undefined {
    return this.defs.get(id);
  }

  list(): AnyNodeDef[] {
    return [...this.defs.values()];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * A bundled param socket: ONE `vector` input that drives two or three number params of a node (see "Vector sockets" in docs/ENGINE.md).
 * Derived from the param names, so no node declares it: number params `<stem>X`, `<stem>Y` and optionally `<stem>Z` (or plain `x`, `y`,
 * `z`) make the bundle `<stem>@xyz`.
 */
export interface ParamBundle {
  /** Port name of the bundle socket. Contains `@`, which no param or input name does, so it cannot collide with one. */
  port: string;
  stem: string;
  /** What the members share, for the UI: "Move", "Rotate", "Spin". */
  label: string;
  /** Param keys in x, y(, z) order. */
  members: string[];
}

/** Suffix of every bundle port. The same for two and three members, so a node that gains a Z param later keeps its wires. */
export const BUNDLE_SUFFIX = '@xyz';

const AXES = ['X', 'Y', 'Z'] as const;
const bundleMemo = new WeakMap<object, ParamBundle[]>();

function bundleLabel(stem: string, labels: (string | undefined)[]): string {
  // The part the member labels share once the axis letter is taken out: "Move X" / "Move Y" / "Move Z" -> "Move".
  const stripped = labels.map((l, i) => (l ?? '').replace(new RegExp(`(^|\\s)${AXES[i]}(?=\\s|$)`), ' ').replace(/\s+/g, ' ').trim());
  if (stripped[0] && stripped[0] !== (labels[0] ?? '') && stripped.every((l) => l === stripped[0])) return stripped[0];
  if (!stem) return 'Vector';
  const words = stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every bundled param socket of a definition (memoised per params object). The ONE place that derives them. */
export function paramBundles(def: AnyNodeDef): ParamBundle[] {
  const params = def.params as Record<string, { type: string; label?: string }>;
  const hit = bundleMemo.get(params);
  if (hit) return hit;
  const out: ParamBundle[] = [];
  const isNum = (k: string) => params[k]?.type === 'number';
  for (const key of Object.keys(params)) {
    // `<stem>X` with a lower-case letter or digit before the axis (posX, shift2X), or a bare `x`.
    const m = /^(?:(.*[a-z0-9])X|x)$/.exec(key);
    if (!m || !isNum(key)) continue;
    const stem = m[1] ?? '';
    const name = (axis: string) => (stem ? stem + axis : axis.toLowerCase());
    if (!isNum(name('Y'))) continue;
    const members = [key, name('Y')];
    if (isNum(name('Z'))) members.push(name('Z'));
    const port = stem + BUNDLE_SUFFIX;
    if (port in params || port in (def.inputs ?? {})) continue;
    out.push({ port, stem, label: bundleLabel(stem, members.map((k) => params[k].label)), members });
  }
  bundleMemo.set(params, out);
  return out;
}

/**
 * The Motion socket: ONE `motion` input on every node with the standard transform params (posX/Y/Z and rotX/Y/Z, plus objectScale if
 * present) that drives all of them together. Derived, so no node declares it.
 * Precedence per component: a wire on the single param wins over a vector bundle wire, which wins over the Motion wire.
 */
export interface ParamMotion {
  port: string;
  label: string;
  pos: [string, string, string];
  rot: [string, string, string];
  scale: string | null;
}

export const MOTION_PORT = 'xform@motion';
const motionMemo = new WeakMap<object, ParamMotion | null>();

export function paramMotion(def: AnyNodeDef): ParamMotion | null {
  const params = def.params as Record<string, { type: string }>;
  if (motionMemo.has(params)) return motionMemo.get(params) ?? null;
  const pos = ['posX', 'posY', 'posZ'] as const;
  const rot = ['rotX', 'rotY', 'rotZ'] as const;
  const ok = [...pos, ...rot].every((k) => params[k]?.type === 'number') && !(MOTION_PORT in params) && !(MOTION_PORT in (def.inputs ?? {}));
  const m: ParamMotion | null = ok ? { port: MOTION_PORT, label: 'Motion', pos: [...pos], rot: [...rot], scale: params.objectScale?.type === 'number' ? 'objectScale' : null } : null;
  motionMemo.set(params, m);
  return m;
}

/** The motion socket behind a port name, or null. */
export function motionPort(def: AnyNodeDef, port: string): ParamMotion | null {
  if (port !== MOTION_PORT) return null;
  return paramMotion(def);
}

/** The bundle behind a port name, or null. */
export function paramBundle(def: AnyNodeDef, port: string): ParamBundle | null {
  if (!port.endsWith(BUNDLE_SUFFIX)) return null;
  return paramBundles(def).find((b) => b.port === port) ?? null;
}

/**
 * Number / color / palette / vec2 params double as input sockets, like Blender, and bundles of number params get one `vector` socket.
 * Returns the socket type a param (or bundle port) accepts, if any.
 */
export function paramSocketType(def: AnyNodeDef, key: string): SocketType | null {
  const p = def.params[key];
  if (!p) return paramBundle(def, key) ? 'vector' : motionPort(def, key) ? 'motion' : null;
  if (p.type === 'number') return 'number';
  if (p.type === 'color') return 'color';
  if (p.type === 'palette') return 'palette';
  if (p.type === 'vec2') return 'vector';
  return null;
}

/** Every port of a definition that is a param socket: wireable params in definition order, each bundle right before its first member. */
export function paramSocketPorts(def: AnyNodeDef): { port: string; type: SocketType; bundle: ParamBundle | null }[] {
  const bundles = paramBundles(def);
  const out: { port: string; type: SocketType; bundle: ParamBundle | null }[] = [];
  for (const key of Object.keys(def.params)) {
    const mo = paramMotion(def);
    if (mo && key === mo.pos[0]) out.push({ port: mo.port, type: 'motion', bundle: null });
    const b = bundles.find((x) => x.members[0] === key);
    if (b) out.push({ port: b.port, type: 'vector', bundle: b });
    const t = paramSocketType(def, key);
    if (t) out.push({ port: key, type: t, bundle: null });
  }
  return out;
}

/** Is `port` something a wire can end on: an input, a wireable param or a bundle? */
export function isInputPort(def: AnyNodeDef, port: string): boolean {
  return port in def.inputs || port in def.params || !!paramBundle(def, port) || !!motionPort(def, port);
}

/** Can an output of type `from` feed an input of type `to`? */
export function canConnect(from: SocketType, to: SocketType): boolean {
  if (from === to) return true;
  if (from === 'mask' && to === 'image') return true;
  return false;
}
