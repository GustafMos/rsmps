/**
 * Every link the update notice uses, in one place.
 *
 * DOWNLOAD_URL: where "Get it" goes. Fill it in (https only) when the itch.io / Gumroad page exists; until then "Get it" opens the
 * GitHub release page. See docs/STORE.md and docs/RELEASING.md.
 */
export const DOWNLOAD_URL: string | null = null;

/** The one URL the desktop app asks, once a day, whether a newer version exists. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/GustafMos/rsmps/releases/latest';

/** The only github.com pages the notice may open ("What's new", and "Get it" while DOWNLOAD_URL is null). */
export const RELEASE_URL_PREFIX = 'https://github.com/GustafMos/rsmps/';
