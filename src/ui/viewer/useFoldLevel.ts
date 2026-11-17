import { useLayoutEffect, useEffect, useState, type RefObject } from 'react';

/** True when a flex row has wrapped: some child sits lower than the first one. */
function wrapped(el: HTMLElement): boolean {
  const kids = Array.from(el.children).filter((c) => (c as HTMLElement).offsetParent !== null || getComputedStyle(c).position === 'fixed') as HTMLElement[];
  if (kids.length < 2) return false;
  const top = kids[0].offsetTop;
  return kids.some((c) => c.offsetTop > top + 6);
}

/**
 * "Priority+" folding for a toolbar: returns a level 0..max. Each level folds one more group of secondary buttons away (the caller maps
 * levels to groups, least important first). The level only rises while the row wraps; it starts again from 0 when the bar's width or the
 * `key` (anything that changes what the bar holds) changes. Runs before paint, so no wrapped frame is shown.
 */
export function useFoldLevel(ref: RefObject<HTMLElement | null>, max: number, key: string): number {
  const [level, setLevel] = useState(0);
  const [seen, setSeen] = useState(key);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) { w = el.clientWidth; setLevel(0); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    if (key !== seen) { setSeen(key); setLevel(0); return; }
    const el = ref.current;
    if (el && level < max && wrapped(el)) setLevel(level + 1);
  });
  return level;
}
