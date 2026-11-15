/**
 * Key bindings storage: user overrides on top of the defaults declared in shortcuts.ts.
 * A binding is a normalised string such as "Ctrl+Shift+Z", "Shift+Space" or "`".
 */
import { useSyncExternalStore } from 'react';

const KEY = 'rsmps.ui.keymap';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

export function eventToBinding(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const raw = e.key === ' ' ? 'Space' : e.key;
  const key = raw.length === 1 ? raw.toUpperCase() : raw;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is part of the character for symbols and digits, so only record it for letters and named keys
  if (e.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) mods.push('Shift');
  return [...mods, key].join('+');
}

export const NODE_PREFIX = 'add:';
/** Defaults for a handful of common nodes. They are only used when the node type exists, and none collides with a built-in shortcut. */
export const NODE_DEFAULTS: Record<string, string[]> = {
  'add:blur': ['Shift+B'],
  'add:color-adjust': ['Shift+C'],
  'add:transform': ['Shift+T'],
  'add:merge': ['Shift+M'],
  'add:pixelate': ['Shift+P'],
  'add:noise': ['Shift+N'],
};

interface Stored {
  overrides: Record<string, string[]>;
}

let state: Stored = load();
let version = 0;
const listeners = new Set<() => void>();
let defaultsOf: (id: string) => string[] | undefined = () => undefined;

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { overrides: raw && typeof raw.overrides === 'object' ? raw.overrides : {} };
  } catch {
    return { overrides: {} };
  }
}
function commit(next: Stored) {
  state = next;
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** shortcuts.ts registers how to look up built-in defaults. */
export function setDefaultsLookup(fn: (id: string) => string[] | undefined): void {
  defaultsOf = fn;
}

export function bindingsOf(id: string): string[] {
  return state.overrides[id] ?? defaultsOf(id) ?? NODE_DEFAULTS[id] ?? [];
}
export const isModified = (id: string): boolean => id in state.overrides;
export function setBindings(id: string, list: string[]): void {
  const base = defaultsOf(id) ?? NODE_DEFAULTS[id] ?? [];
  const same = list.length === base.length && list.every((b, i) => b === base[i]);
  const overrides = { ...state.overrides };
  if (same) delete overrides[id];
  else overrides[id] = list;
  commit({ overrides });
}
export function resetBindings(id: string): void {
  const overrides = { ...state.overrides };
  delete overrides[id];
  commit({ overrides });
}
export function resetAll(): void {
  commit({ overrides: {} });
}
export function overrideIds(): string[] {
  return Object.keys(state.overrides);
}
export function exportKeymap(): string {
  return JSON.stringify({ format: 'rsmps/keymap', version: 1, overrides: state.overrides }, null, 2);
}
export function importKeymap(text: string): void {
  const raw = JSON.parse(text);
  if (!raw || typeof raw.overrides !== 'object') throw new Error('Not an RSMPS keymap file');
  const overrides: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw.overrides as Record<string, unknown>)) {
    if (Array.isArray(v) && v.every((b) => typeof b === 'string')) overrides[k] = v as string[];
  }
  commit({ overrides });
}

export function subscribeKeymap(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const keymapVersion = (): number => version;
export function useKeymapVersion(): number {
  return useSyncExternalStore(subscribeKeymap, keymapVersion);
}

/** Ids of every command that currently owns `binding` (optionally ignoring one). */
export function owners(binding: string, ids: string[], except?: string): string[] {
  return ids.filter((id) => id !== except && bindingsOf(id).includes(binding));
}
