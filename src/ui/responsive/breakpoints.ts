/**
 * The breakpoints, defined once. Layout is chosen from the viewport size and the input type, never from the user agent.
 *
 *   phone    < 640 px wide, or a landscape phone (a coarse pointer and under 500 px tall)
 *   tablet   640 - 1023 px
 *   desktop  >= 1024 px
 *
 * CSS does not repeat these numbers: `installViewportAttributes()` (viewport.ts) writes the result to
 * `<html data-vp="phone|tablet|desktop">` (plus `data-touch`, `data-orient`), and the stylesheets select on that.
 * Only touch sizing uses a plain `@media (pointer: coarse)` as well.
 */
export const PHONE_MAX = 640;
export const TABLET_MAX = 1024;
/** A landscape phone is wide (640+) but short: with a coarse pointer under this height it still gets the phone shell. */
export const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

export type ViewportClass = 'phone' | 'tablet' | 'desktop';

/** The media queries behind the class. The .02 keeps fractional widths (zoomed pages) on the right side of the line. */
export const QUERIES = {
  phone: `(max-width: ${PHONE_MAX - 0.02}px), (max-height: ${PHONE_LANDSCAPE_MAX_HEIGHT}px) and (pointer: coarse)`,
  tablet: `(max-width: ${TABLET_MAX - 0.02}px)`,
  coarse: '(pointer: coarse)',
  noHover: '(hover: none)',
  landscape: '(orientation: landscape)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;

/** The class for a plain size (tests, and a reference for the queries above). */
export function classify(width: number, height: number, coarse: boolean): ViewportClass {
  if (width < PHONE_MAX || (coarse && height <= PHONE_LANDSCAPE_MAX_HEIGHT)) return 'phone';
  return width < TABLET_MAX ? 'tablet' : 'desktop';
}
