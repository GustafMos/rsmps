import { useSyncExternalStore } from 'react';
import { QUERIES, type ViewportClass } from './breakpoints';

export interface ViewportInfo {
  cls: ViewportClass;
  /** The main pointer is a finger (phones, tablets, touch laptops). */
  coarse: boolean;
  /** No hover: tooltips and hover-only buttons need a touch equivalent. */
  noHover: boolean;
  landscape: boolean;
  reducedMotion: boolean;
}

type MatchMediaFn = (query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/**
 * A small external store over `matchMedia`. The media-query lists are the only inputs, so a fake `matchMedia` is enough to test it.
 * `snapshot()` returns the same object until a class or flag really changes (safe for useSyncExternalStore).
 */
export function createViewportStore(matchMedia: MatchMediaFn | undefined) {
  const lists = matchMedia
    ? {
        phone: matchMedia(QUERIES.phone),
        tablet: matchMedia(QUERIES.tablet),
        coarse: matchMedia(QUERIES.coarse),
        noHover: matchMedia(QUERIES.noHover),
        landscape: matchMedia(QUERIES.landscape),
        reducedMotion: matchMedia(QUERIES.reducedMotion),
      }
    : null;
  const read = (): ViewportInfo => ({
    cls: !lists ? 'desktop' : lists.phone.matches ? 'phone' : lists.tablet.matches ? 'tablet' : 'desktop',
    coarse: !!lists?.coarse.matches,
    noHover: !!lists?.noHover.matches,
    landscape: lists ? lists.landscape.matches : true,
    reducedMotion: !!lists?.reducedMotion.matches,
  });
  let current = read();
  const listeners = new Set<() => void>();
  const onChange = () => {
    const next = read();
    if (next.cls === current.cls && next.coarse === current.coarse && next.noHover === current.noHover && next.landscape === current.landscape && next.reducedMotion === current.reducedMotion) return;
    current = next;
    listeners.forEach((l) => l());
  };
  let attached = false;
  const attach = () => {
    if (attached || !lists) return;
    attached = true;
    for (const l of Object.values(lists)) l.addEventListener('change', onChange);
    current = read();
  };
  const detach = () => {
    if (!attached || !lists) return;
    attached = false;
    for (const l of Object.values(lists)) l.removeEventListener('change', onChange);
  };
  return {
    snapshot: () => current,
    subscribe(fn: () => void) {
      listeners.add(fn);
      attach();
      return () => {
        listeners.delete(fn);
        if (!listeners.size) detach();
      };
    },
  };
}

export const viewportStore = createViewportStore(typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined);

/** The whole picture: class, input type, orientation, reduced motion. */
export function useViewport(): ViewportInfo {
  return useSyncExternalStore(viewportStore.subscribe, viewportStore.snapshot, viewportStore.snapshot);
}

/** `'phone' | 'tablet' | 'desktop'`. */
export function useViewportClass(): ViewportClass {
  return useViewport().cls;
}

/**
 * Mirror the viewport onto <html> so stylesheets can select on it (`html[data-vp="phone"]`). Call once at start-up, before the first
 * render, so the boot and error screens are laid out right too. Returns the stop function.
 */
export function installViewportAttributes(root: HTMLElement = document.documentElement): () => void {
  const apply = () => {
    const v = viewportStore.snapshot();
    root.dataset.vp = v.cls;
    root.dataset.orient = v.landscape ? 'landscape' : 'portrait';
    if (v.coarse) root.dataset.touch = '1';
    else delete root.dataset.touch;
    if (v.noHover) root.dataset.nohover = '1';
    else delete root.dataset.nohover;
    if (v.reducedMotion) root.dataset.reduced = '1';
    else delete root.dataset.reduced;
  };
  apply();
  return viewportStore.subscribe(apply);
}
