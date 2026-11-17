/** Minimal argument parser (no dependency). */

export interface OptionSpec {
  /** Takes a value. */
  value?: boolean;
  /** Collects every occurrence into an array. */
  repeat?: boolean;
  /** Greedy: also consumes following non-option tokens (used by --input). */
  greedy?: boolean;
  alias?: string;
}

export interface Parsed {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export function parseArgs(argv: string[], spec: Record<string, OptionSpec>): Parsed {
  const aliases = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) if (s.alias) aliases.set(s.alias, name);
  const out: Parsed = { positionals: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith('-') || tok === '-') {
      out.positionals.push(tok);
      continue;
    }
    let name = tok.replace(/^--?/, '');
    let inline: string | undefined;
    const eq = name.indexOf('=');
    if (tok.startsWith('--') && eq > 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = aliases.get(name) ?? name;
    const s = spec[name];
    if (!s) throw new Error(`Unknown option: ${tok}`);
    if (!s.value) {
      if (inline !== undefined) throw new Error(`Option --${name} does not take a value.`);
      out.flags.add(name);
      continue;
    }
    const vals: string[] = [];
    if (inline !== undefined) vals.push(inline);
    else {
      if (i + 1 >= argv.length) throw new Error(`Option --${name} needs a value.`);
      vals.push(argv[++i]);
    }
    if (s.greedy) while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i]);
    const list = out.values.get(name) ?? [];
    if (!s.repeat && list.length) throw new Error(`Option --${name} given more than once.`);
    list.push(...vals);
    out.values.set(name, list);
  }
  return out;
}

export function one(p: Parsed, name: string): string | undefined {
  return p.values.get(name)?.[0];
}

export function numberOpt(p: Parsed, name: string, min = -Infinity): number | undefined {
  const v = one(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`Option --${name} needs a number${min > -Infinity ? ` >= ${min}` : ''}, got "${v}".`);
  return n;
}

/** `--for <name>` covers sheet presets (generic|godot|unity|gamemaker|rpgmaker|web) and video presets (vj|editing|web). "web" sets both. */
export function parseForFlag(name: string): { preset?: string; videoFor?: string } {
  const sheetFor = ['generic', 'godot', 'unity', 'gamemaker', 'rpgmaker', 'web'];
  const videoFor = ['vj', 'editing', 'web'];
  if (!sheetFor.includes(name) && !videoFor.includes(name)) throw new Error(`Unknown --for "${name}" (${[...sheetFor, 'vj', 'editing'].join(', ')}).`);
  return { ...(sheetFor.includes(name) ? { preset: name } : {}), ...(videoFor.includes(name) ? { videoFor: name } : {}) };
}
