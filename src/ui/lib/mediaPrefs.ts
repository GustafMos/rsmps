/** Media panel preferences: defaults, limits and loading the saved choices. Pure (the store in store/media.ts does the saving). */
import type { Density } from './mediaLayout';
import type { SortKey, TypeFilter, ViewMode } from './mediaFilter';

export const RAIL_WIDTH = 36;
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 520;
export const DEFAULT_WIDTH = 264;

export interface MediaUi {
  /** Collapsed to the slim rail. */
  collapsed: boolean;
  width: number;
  view: ViewMode;
  density: Density;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  /** Ids of sections (bins, type groups) the user folded. */
  closed: string[];
  // per session
  type: TypeFilter;
  unusedOnly: boolean;
  text: string;
  /** Set to ask the panel to focus its search box (the panel clears it once it has). */
  searchFocus: boolean;
  /** A bin that was just created: its name field opens for typing. */
  renamingBin: string | null;
}

export const MEDIA_KEY = 'rsmps.ui.media';
const LEGACY_PREFS_KEY = 'rsmps.ui.prefs';

export const DEFAULTS: MediaUi = {
  collapsed: false,
  width: DEFAULT_WIDTH,
  view: 'bins',
  density: 'grid',
  sortKey: 'added',
  sortDir: 'asc',
  closed: [],
  type: 'all',
  unusedOnly: false,
  text: '',
  searchFocus: false,
  renamingBin: null,
};

export const clampWidth = (w: number): number => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number.isFinite(w) ? w : DEFAULT_WIDTH)));

export const PERSISTED = ['collapsed', 'width', 'view', 'density', 'sortKey', 'sortDir', 'closed'] as const;

/** Read the saved choices; anything missing or odd falls back. The old "hide the media panel" pref (leftOpen = false) starts collapsed. */
export function loadMediaUi(read: (k: string) => string | null): MediaUi {
  let saved: Partial<MediaUi> = {};
  try {
    const raw = read(MEDIA_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<MediaUi>;
    else {
      const legacy = JSON.parse(read(LEGACY_PREFS_KEY) ?? '{}') as { leftOpen?: boolean };
      if (legacy.leftOpen === false) saved = { collapsed: true };
    }
  } catch {
    /* storage unavailable or damaged */
  }
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    ...DEFAULTS,
    collapsed: saved.collapsed === true,
    width: clampWidth(saved.width ?? DEFAULT_WIDTH),
    view: pick(saved.view, ['bins', 'type', 'flat'], DEFAULTS.view),
    density: pick(saved.density, ['grid', 'list'], DEFAULTS.density),
    sortKey: pick(saved.sortKey, ['name', 'added', 'type', 'duration', 'size'], DEFAULTS.sortKey),
    sortDir: pick(saved.sortDir, ['asc', 'desc'], DEFAULTS.sortDir),
    closed: Array.isArray(saved.closed) ? saved.closed.filter((x): x is string => typeof x === 'string') : [],
  };
}

