import { createStore } from './createStore';

/** Per-node body view state: which params are pinned on the node and whether the full list is expanded. */
const KEY = 'rsmps.ui.pins';

interface NodeViewState {
  /** Explicit pinned params per node id; absent = the default heuristic (first rows). */
  pins: Record<string, string[]>;
  expanded: Record<string, boolean>;
}

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const nodeViewStore = createStore<NodeViewState>({ pins: load(), expanded: {} });

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

export function toggleExpanded(nodeId: string): void {
  nodeViewStore.set((s) => ({ ...s, expanded: { ...s.expanded, [nodeId]: !s.expanded[nodeId] } }));
}
