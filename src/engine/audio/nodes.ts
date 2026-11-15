/**
 * Every built-in audio node, imported without touching image nodes, the DOM or WebGPU.
 * The AudioWorklet bundle imports this file; so do tests. (The main app registers the same files
 * through src/engine/nodes/index.ts, which globs all folders.)
 */
import { Registry } from '../define';

const modules = import.meta.glob(
  ['../nodes/audio-source/*.node.ts', '../nodes/audio-fx/*.node.ts', '../nodes/synth/*.node.ts', '../nodes/bridge/*.node.ts'],
  { eager: true },
) as Record<string, Record<string, unknown>>;

/** Register all audio nodes into `registry` (a new one when omitted). */
export function registerAudioNodes(registry: Registry = new Registry()): Registry {
  for (const path of Object.keys(modules).sort()) registry.registerModule(modules[path]);
  return registry;
}
