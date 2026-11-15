import type { Registry } from '../define';

/**
 * Built-in nodes are discovered by file name: any `*.node.ts` under this folder is registered.
 * Adding a node = adding one file. There is no list to update.
 */
const modules = import.meta.glob('./**/*.node.ts', { eager: true }) as Record<string, Record<string, unknown>>;

export function registerBuiltins(registry: Registry): string[] {
  const ids: string[] = [];
  for (const path of Object.keys(modules).sort()) {
    try {
      ids.push(...registry.registerModule(modules[path]));
    } catch (err) {
      throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ids;
}
