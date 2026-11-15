import { parseHex, toHex, type RGB } from './colorMath';

const KEY = 'rsmps.ui.recentColors';

export function getRecentColors(): RGB[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    return list.map((h) => parseHex(h)?.rgb).filter((c): c is RGB => !!c);
  } catch {
    return [];
  }
}

export function pushRecentColor(rgb: RGB): void {
  try {
    const hex = toHex(rgb);
    const list = [hex, ...(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]).filter((h) => h !== hex)].slice(0, 12);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}
