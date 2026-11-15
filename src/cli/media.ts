/** File-type helpers and input expansion (files, folders, globs). Pure Node, no GPU. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.gif', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv']);
export const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.aif', '.aiff']);
export const MIDI_EXT = new Set(['.mid', '.midi']);

export type MediaKind = 'image' | 'video' | 'audio' | 'midi';

export function kindByExtension(file: string): MediaKind | null {
  const e = extname(file).toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (MIDI_EXT.has(e)) return 'midi';
  return null;
}

export function isSupportedMedia(file: string): boolean {
  return kindByExtension(file) !== null;
}

/** Natural ordering: frame2 < frame10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function hasMagic(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

function segmentRegex(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/\\\\]*';
    else if (c === '?') re += '[^/\\\\]';
    else if (c === '{') {
      const end = seg.indexOf('}', i);
      if (end > i) {
        const alts = seg.slice(i + 1, end).split(',');
        re += '(?:' + alts.map((p) => p.replace(/[.+^$()|\\[\]]/g, '\\$&').replace(/\*/g, '[^/\\\\]*')).join('|') + ')';
        i = end;
        continue;
      }
      re += '\\{';
    } else re += c.replace(/[.+^$()|\\[\]}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Expand a glob pattern (`*`, `?`, `{a,b}`, `**`) into existing paths. */
export function expandGlob(pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/');
  const parts = norm.split('/');
  // The longest prefix without wildcards is the walk root.
  let i = 0;
  while (i < parts.length && !hasMagic(parts[i])) i++;
  const rootParts = parts.slice(0, i);
  const rest = parts.slice(i);
  const root = rootParts.length ? rootParts.join('/') || '/' : '.';
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    if (segs.length === 0) {
      out.push(dir);
      return;
    }
    const [seg, ...tail] = segs;
    if (seg === '**') {
      walk(dir, tail);
      for (const name of listDir(dir).sort(naturalCompare)) {
        const p = join(dir, name);
        try {
          if (statSync(p).isDirectory()) walk(p, segs);
        } catch {
          /* unreadable */
        }
      }
      return;
    }
    const re = segmentRegex(seg);
    for (const name of listDir(dir).sort(naturalCompare)) {
      if (re.test(name)) walk(join(dir, name), tail);
    }
  };
  walk(root, rest);
  return [...new Set(out)];
}

export interface ExpandOptions {
  recursive?: boolean;
  /** Directories become one image-sequence asset each instead of a list of files. */
  sequence?: boolean;
  cwd?: string;
}

function filesIn(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const name of listDir(dir).sort(naturalCompare)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (recursive) out.push(...filesIn(p, true));
    } else if (isSupportedMedia(p)) out.push(p);
  }
  return out;
}

/** Turn user inputs (files, folders, globs) into absolute asset ids. Throws on a path that matches nothing. */
export function expandInputs(inputs: string[], opts: ExpandOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const out: string[] = [];
  for (const raw of inputs) {
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let matches: string[];
    if (existsSync(abs)) matches = [abs];
    else if (hasMagic(raw)) matches = expandGlob(abs);
    else throw new Error(`Input not found: ${raw}`);
    if (matches.length === 0) throw new Error(`Input matched nothing: ${raw}`);
    for (const m of matches) {
      const st = statSync(m);
      if (st.isDirectory()) {
        if (opts.sequence) out.push(resolve(m));
        else {
          const files = filesIn(m, !!opts.recursive);
          if (files.length === 0) throw new Error(`No supported media files in folder: ${raw}`);
          out.push(...files.map((f) => resolve(f)));
        }
      } else if (isSupportedMedia(m)) out.push(resolve(m));
    }
  }
  return out;
}

/** Image files of a sequence folder, in natural order. */
export function sequenceFiles(dir: string): string[] {
  return listDir(dir)
    .filter((n) => kindByExtension(n) === 'image')
    .sort(naturalCompare)
    .map((n) => join(dir, n));
}

/** Display name used for `{name}`: file stem, or folder name for sequences. */
export function assetName(id: string): string {
  const base = basename(id);
  try {
    if (statSync(id).isDirectory()) return base;
  } catch {
    /* fall through */
  }
  const e = extname(base);
  return e ? base.slice(0, -e.length) : base;
}
