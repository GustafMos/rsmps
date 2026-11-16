import { useCallback, useMemo } from 'react';
import type { MediaOrg } from '../../engine/types';
import { useApp, useAssets, useEd } from '../store/context';
import type { EditorState } from '../store/editor';
import { toItem, type MediaItem } from '../lib/mediaFilter';
import { normalizeOrg } from '../lib/mediaOrg';
import { assetUsage, usageEqual } from '../lib/mediaUsage';

/** The library's visible assets (hidden bake / process / scan assets are already left out) as panel items, oldest first. */
export function useMediaItems(): MediaItem[] {
  const { io } = useApp();
  const assets = useAssets();
  return useMemo(() => assets.map((a, i) => toItem(a, io.library.assetMeta(a.id), i)), [assets, io]);
}

/** asset id -> ids of the nodes of the open project that use it. Re-renders only when that mapping really changes. */
export function useAssetUsage(items: readonly MediaItem[]): Map<string, string[]> {
  const ids = useMemo(() => new Set(items.map((a) => a.id)), [items]);
  const select = useCallback((s: EditorState) => assetUsage(s.graph.nodes, ids), [ids]);
  return useEd(select, usageEqual);
}

/** The bins of the open project. */
export function useOrg(): MediaOrg {
  const raw = useEd((s) => s.graph.media);
  return useMemo(() => normalizeOrg(raw), [raw]);
}
