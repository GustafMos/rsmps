/**
 * Media panel state that is NOT part of a project: layout (collapsed to the rail, width), view choices (bins / by type / flat, grid / list,
 * sort), the type filter and the search text. The first group is remembered per user in localStorage; the filters are per session.
 * Bins themselves live in the project document (`GraphDoc.media`), edited through `editOrg` below so they save and undo with the project.
 * New store file on purpose: editor.ts stays untouched (same approach as bake.ts).
 */
import type { MediaOrg } from '../../engine/types';
import { uid } from '../../engine/graph';
import { frameGraph } from '../graph/gestures';
import { createStore, useSelector } from './createStore';
import type { AppCtx } from './context';
import { DEFAULT_WIDTH, MAX_WIDTH, MEDIA_KEY, MIN_WIDTH, PERSISTED, RAIL_WIDTH, clampWidth, loadMediaUi, type MediaUi } from '../lib/mediaPrefs';
import { createBin, normalizeOrg, pruneOrg } from '../lib/mediaOrg';
import type { TypeFilter } from '../lib/mediaFilter';

export { RAIL_WIDTH, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, clampWidth, loadMediaUi, type MediaUi };

export const mediaStore = createStore<MediaUi>(loadMediaUi((k) => { try { return localStorage.getItem(k); } catch { return null; } }));

export function setMedia(p: Partial<MediaUi>): void {
  const prev = mediaStore.get();
  const next = { ...prev, ...p };
  if (p.width !== undefined) next.width = clampWidth(p.width);
  mediaStore.set(next);
  if (PERSISTED.some((k) => prev[k] !== next[k])) {
    try {
      localStorage.setItem(MEDIA_KEY, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, next[k]]))));
    } catch {
      /* lasts for this session only */
    }
  }
}

export function useMedia<T>(selector: (s: MediaUi) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useSelector(mediaStore, selector, isEqual);
}

/** Top bar button, shortcut, rail and header chevron all do this. */
export function toggleMediaPanel(): void {
  setMedia({ collapsed: !mediaStore.get().collapsed });
}

/** Open the panel on a type (a rail icon was clicked). */
export function openMediaOn(type: TypeFilter): void {
  setMedia({ collapsed: false, type });
}

export function focusMediaSearch(): void {
  setMedia({ collapsed: false, searchFocus: true });
}

export function toggleSection(id: string): void {
  const closed = mediaStore.get().closed;
  setMedia({ closed: closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id] });
}

/* ------------------------- bins (stored in the project) ------------------------ */

/** Change the bins of the open project. One undo step; assets that left the library are forgotten on the way. */
export function editOrg(app: Pick<AppCtx, 'ed' | 'io'>, fn: (org: MediaOrg) => MediaOrg): void {
  app.ed.edit((g) => {
    const cur = normalizeOrg(g.media);
    const ids = new Set(app.io.library.list().map((a) => a.id));
    const next = pruneOrg(fn(cur), ids);
    if (next === cur || (next.bins.length === 0 && Object.keys(next.assign).length === 0 && !g.media)) return g;
    return { ...g, media: next };
  });
}

/** Make a bin (optionally holding assets) and open its name for editing. Returns its id. */
export function newBin(app: Pick<AppCtx, 'ed' | 'io'>, assetIds: readonly string[] = []): string {
  const id = uid('bin');
  editOrg(app, (org) => {
    const made = createBin(org, id);
    const assign = { ...made.org.assign };
    for (const a of assetIds) assign[a] = id;
    return { ...made.org, assign };
  });
  setMedia({ renamingBin: id, closed: mediaStore.get().closed.filter((x) => x !== id) });
  return id;
}

/** Select the nodes of this project that use an asset and bring them into view. */
export function revealNodes(app: AppCtx, nodeIds: readonly string[]): void {
  if (!nodeIds.length) return;
  app.ed.select(nodeIds);
  frameGraph(app, true);
}
