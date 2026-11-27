/**
 * Which effect picture each region gets (Effects On Regions). Pure: the result depends only on the regions and the
 * settings, never on the clock, so a region keeps its effect from frame to frame as long as its id and the list it
 * belongs to stay the same.
 *
 * The result has one entry per input region, in input order: 0..3 = effect A..D, -1 = no effect (shows the original).
 */
import type { Region } from '../types';
import { areaOf, centerOf, hashInts } from './track-core';

export type GiveMode = 'all' | 'cycle' | 'size' | 'left' | 'top' | 'label' | 'random';

export interface AssignOptions {
  mode: GiveMode;
  /** Which of the four effect pictures are wired. Unwired ones are skipped. */
  wired: readonly [boolean, boolean, boolean, boolean];
  /** Per effect: "person, 12" (labels or ids, comma separated). Only used by mode 'label'. */
  labels?: readonly [string, string, string, string];
  seed?: number;
}

/** Does a region match a list such as "person, 12"? Plain numbers match the id exactly, words match the label (ignoring case, containing). */
export function matchesList(r: Region, list: string): boolean {
  const l = r.label.toLowerCase();
  for (const raw of list.split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      if (Number(t) === r.id) return true;
    } else if (l.includes(t)) return true;
  }
  return false;
}

export function assignEffects(items: readonly Region[], o: AssignOptions): number[] {
  const out = new Array<number>(items.length).fill(-1);
  const avail = [0, 1, 2, 3].filter((k) => o.wired[k]);
  if (!avail.length || !items.length) return out;
  const n = avail.length;
  const order = (cmp: (a: number, b: number) => number): void => {
    const idx = items.map((_, i) => i).sort((a, b) => cmp(a, b) || items[a].id - items[b].id || a - b);
    idx.forEach((i, rank) => (out[i] = avail[rank % n]));
  };
  switch (o.mode) {
    case 'all':
      out.fill(avail[0]);
      break;
    case 'cycle':
      order((a, b) => items[a].id - items[b].id);
      break;
    case 'size':
      order((a, b) => areaOf(items[b].box) - areaOf(items[a].box));
      break;
    case 'left':
      order((a, b) => centerOf(items[a].box)[0] - centerOf(items[b].box)[0]);
      break;
    case 'top':
      order((a, b) => centerOf(items[a].box)[1] - centerOf(items[b].box)[1]);
      break;
    case 'label':
      items.forEach((r, i) => {
        for (const k of avail) {
          if (matchesList(r, o.labels?.[k] ?? '')) {
            out[i] = k;
            break;
          }
        }
      });
      break;
    case 'random': {
      const seed = Math.round(o.seed ?? 0);
      items.forEach((r, i) => (out[i] = avail[hashInts(r.id, seed, 7919) % n]));
      break;
    }
  }
  return out;
}
