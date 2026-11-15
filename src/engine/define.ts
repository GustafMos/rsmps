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

/** Number/color/vec2 params double as input sockets, like Blender. Returns the socket type a param accepts, if any. */
export function paramSocketType(def: AnyNodeDef, key: string): SocketType | null {
  const p = def.params[key];
  if (!p) return null;
  if (p.type === 'number') return 'number';
  if (p.type === 'color') return 'color';
  if (p.type === 'palette') return 'palette';
  return null;
}

/** Can an output of type `from` feed an input of type `to`? */
export function canConnect(from: SocketType, to: SocketType): boolean {
  if (from === to) return true;
  if (from === 'mask' && to === 'image') return true;
  return false;
}
