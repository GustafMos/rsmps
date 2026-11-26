import { createStore } from './createStore';

/** Per-node body view state: which params are pinned on the node and whether the full list is expanded. */
const KEY = 'rsmps.ui.pins';

interface NodeViewState {
  /** Explicit pinned params per node id; absent = the default heuristic (first rows). */
  pins: Record<string, string[]>;
  expanded: Record<string, boolean>;
  /** Show every bundle socket (the vector socket of an X / Y / Z group) on the nodes: on while a vector wire is being placed by tapping. */
  bundles: boolean;
}

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const nodeViewStore = createStore<NodeViewState>({ pins: load(), expanded: {}, bundles: false });

export function setPin(nodeId: string, key: string, on: boolean, current: string[]): void {
  const set = new Set(current);
  on ? set.add(key) : set.delete(key);
  const pins = { ...nodeViewStore.get().pins, [nodeId]: [...set] };
  nodeViewStore.set((s) => ({ ...s, pins }));
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

export function showBundleSockets(on: boolean): void {
  if (nodeViewStore.get().bundles !== on) nodeViewStore.set((s) => ({ ...s, bundles: on }));
}

export function toggleExpanded(nodeId: string): void {
  nodeViewStore.set((s) => ({ ...s, expanded: { ...s.expanded, [nodeId]: !s.expanded[nodeId] } }));
}
