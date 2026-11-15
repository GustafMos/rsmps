/**
 * PluginManager: user-installed node modules. A plugin is one ES module file (no imports) whose default
 * export is a node definition or an array of them. The source text is kept in IndexedDB and re-registered
 * on every start-up. Plugins run with full page privileges: only install files you trust.
 */
import type { Registry } from '../engine/define';
import type { AnyNodeDef } from '../engine/types';
import type { PluginInfo, PluginManager } from './api';
import { idbAll, idbDelete, idbPut } from './db';
import { errorMessage, hashString } from './util';

interface StoredPlugin {
  id: string;
  fileName: string;
  text: string;
  added: number;
}

/** Collect node definitions from a module namespace the same way `Registry.registerModule` does. */
export function collectDefs(mod: Record<string, unknown>): AnyNodeDef[] {
  const defs: AnyNodeDef[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object' && 'id' in v && 'inputs' in v && 'outputs' in v && 'params' in v) defs.push(v as AnyNodeDef);
  };
  Object.values(mod).forEach(visit);
  return defs;
}

export class PluginManagerImpl implements PluginManager {
  private infos = new Map<string, PluginInfo>();
  private listeners = new Set<() => void>();

  constructor(private registry: Registry) {}

  list(): PluginInfo[] {
    return [...this.infos.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  async install(file: File): Promise<PluginInfo> {
    const id = `p_${hashString(file.name)}`;
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      return { id, fileName: file.name, nodeIds: [], error: `Could not read the file: ${errorMessage(err)}` };
    }
    // Re-installing the same file name replaces the old version.
    this.unregister(id);
    const info = await this.load(id, file.name, text);
    this.infos.set(id, info);
    try {
      const record: StoredPlugin = { id, fileName: file.name, text, added: Date.now() };
      await idbPut('plugins', id, record);
    } catch (err) {
      info.error ??= `Loaded, but could not be saved for the next session: ${errorMessage(err)}`;
    }
    this.notify();
    return info;
  }

  async remove(id: string): Promise<void> {
    this.unregister(id);
    this.infos.delete(id);
    try {
      await idbDelete('plugins', id);
    } catch (err) {
      console.warn('Could not delete the stored plugin:', err);
    }
    this.notify();
  }

  async restore(): Promise<void> {
    let stored: StoredPlugin[] = [];
    try {
      stored = await idbAll<StoredPlugin>('plugins');
    } catch (err) {
      console.warn('Could not restore plugins:', err);
      return;
    }
    stored.sort((a, b) => a.added - b.added);
    for (const p of stored) {
      if (!p?.text) continue;
      this.infos.set(p.id, await this.load(p.id, p.fileName, p.text));
    }
    if (stored.length) this.notify();
  }

  private unregister(id: string): void {
    const info = this.infos.get(id);
    if (info) for (const nodeId of info.nodeIds) this.registry.unregister(nodeId);
  }

  /** Import the module and register its nodes. Never throws: failures land in `error`. */
  private async load(id: string, fileName: string, text: string): Promise<PluginInfo> {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const before = new Set(this.registry.list().map((d) => d.id));
    try {
      const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      const defs = collectDefs(mod);
      if (defs.length === 0) throw new Error('The file exports no node definitions. Export one (or an array of them) as the default export.');
      for (const def of defs) {
        if (typeof def.id !== 'string' || !def.id.includes('/')) {
          throw new Error(`Node id "${String(def.id)}" must be namespaced, like "myname/effect".`);
        }
        if (before.has(def.id)) throw new Error(`Node id "${def.id}" is already taken by another node or plugin.`);
      }
      const ids = this.registry.registerModule({ default: defs });
      return { id, fileName, nodeIds: ids };
    } catch (err) {
      // Roll back anything this file managed to register before failing.
      const added = this.registry.list().map((d) => d.id).filter((nodeId) => !before.has(nodeId));
      for (const nodeId of added) this.registry.unregister(nodeId);
      return { id, fileName, nodeIds: [], error: errorMessage(err) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
