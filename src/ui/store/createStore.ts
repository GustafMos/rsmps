import { useCallback, useRef, useSyncExternalStore } from 'react';

/** A tiny external store: get / set / subscribe. */
export interface Store<S> {
  get(): S;
  set(next: S | ((s: S) => S)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const n = typeof next === 'function' ? (next as (s: S) => S)(state) : next;
      if (n === state) return;
      state = n;
      listeners.forEach((l) => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Subscribe to a slice of a store. The component re-renders only when the selected value
 * changes (Object.is, or the supplied equality for derived objects).
 */
export function useSelector<S, T>(store: Store<S>, selector: (s: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ s: S; sel: (s: S) => T; v: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const s = store.get();
    const c = cache.current;
    if (c && c.s === s && c.sel === selector) return c.v;
    const v = selector(s);
    if (c && isEqual(c.v, v)) {
      cache.current = { s, sel: selector, v: c.v };
      return c.v;
    }
    cache.current = { s, sel: selector, v };
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
