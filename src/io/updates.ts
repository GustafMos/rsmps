/**
 * Update notice (NOT an updater: nothing is downloaded or installed). The desktop app asks GitHub once a day whether a newer
 * release exists and, if so, shows a dismissible notice. Everything here is pure or takes its clock, storage and fetch as
 * arguments so it can be tested without a network. Any failure is silent for the automatic check.
 */
import { DOWNLOAD_URL, LATEST_RELEASE_API, RELEASE_URL_PREFIX } from './update-links';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const KEY_LAST_CHECK = 'rsmps.update.lastCheck';
export const KEY_SKIPPED = 'rsmps.update.skipped';
export const KEY_ENABLED = 'rsmps.update.enabled';

export type Version = readonly [number, number, number];

/** `v1.2.3` or `1.2.3` only. Pre-release suffixes, missing parts and junk give null. */
export function parseVersion(tag: unknown): Version | null {
  if (typeof tag !== 'string') return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b; null when either is malformed. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** https on github.com/GustafMos/rsmps/…, no credentials. Nothing else is ever opened by the notice. */
export function isAllowedReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return false;
  const base = new URL(RELEASE_URL_PREFIX).pathname; // "/GustafMos/rsmps/"
  return u.pathname === base.replace(/\/$/, '') || u.pathname.startsWith(base);
}

export interface ReleaseInfo {
  /** `X.Y.Z` without the v. */
  version: string;
  tag: string;
  /** The release page (allow-listed). */
  url: string;
}

/** Reads the `releases/latest` answer. Null for drafts, pre-releases, a bad tag, a foreign html_url or a wrong shape. */
export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const v = parseVersion(r.tag_name);
  if (!v || !isAllowedReleaseUrl(r.html_url)) return null;
  return { version: v.join('.'), tag: String(r.tag_name).trim(), url: r.html_url };
}

/** Where "Get it" goes: the store page once DOWNLOAD_URL is set (https only), else the release page. */
export function downloadTarget(info: ReleaseInfo, store: string | null = DOWNLOAD_URL): string {
  if (store) {
    try {
      if (new URL(store).protocol === 'https:') return store;
    } catch {
      /* fall back to the release page */
    }
  }
  return info.url;
}

/** The storage the logic needs (localStorage fits). Every access is guarded: a blocked storage just means "no memory". */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function read(s: KV, k: string): string | null {
  try {
    return s.getItem(k);
  } catch {
    return null;
  }
}
function write(s: KV, k: string, v: string): void {
  try {
    s.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** "Check for new versions on start" (default on). */
export function isCheckEnabled(s: KV): boolean {
  return read(s, KEY_ENABLED) !== '0';
}
export function setCheckEnabled(s: KV, on: boolean): void {
  write(s, KEY_ENABLED, on ? '1' : '0');
}

/** The automatic check is due when enabled and the last successful check is 24 h or more old (or unknown, or in the future). */
export function isCheckDue(s: KV, now: number): boolean {
  if (!isCheckEnabled(s)) return false;
  const last = Number(read(s, KEY_LAST_CHECK));
  if (!Number.isFinite(last) || last <= 0 || last > now) return true;
  return now - last >= DAY_MS;
}

export function skipVersion(s: KV, version: string): void {
  write(s, KEY_SKIPPED, version);
}
export function isSkipped(s: KV, version: string): boolean {
  return read(s, KEY_SKIPPED) === version;
}

export type UpdateResult =
  | { status: 'newer'; info: ReleaseInfo }
  | { status: 'latest' }
  | { status: 'failed' }
  /** Automatic check only: turned off, not due yet, or the newer version was skipped. */
  | { status: 'quiet' };

export interface CheckDeps {
  fetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  storage: KV;
  now: () => number;
  /** The running version, `X.Y.Z`. */
  current: string;
  /** True for File > Check for updates: ignores the 24 h limit, the off switch and "skipped". */
  manual?: boolean;
  timeoutMs?: number;
}

/** Asks GitHub (one GET, nothing sent but what fetch sends) and compares. Never throws. */
export async function checkForUpdate(d: CheckDeps): Promise<UpdateResult> {
  if (!d.manual && !isCheckDue(d.storage, d.now())) return { status: 'quiet' };
  let json: unknown;
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = ctl ? setTimeout(() => ctl.abort(), d.timeoutMs ?? 10000) : null;
  try {
    const res = await d.fetch(LATEST_RELEASE_API, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl?.signal });
    if (!res.ok) return { status: 'failed' };
    json = await res.json();
  } catch {
    return { status: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const info = parseLatestRelease(json);
  if (!info) return { status: 'failed' };
  write(d.storage, KEY_LAST_CHECK, String(d.now()));
  const cmp = compareVersions(info.version, d.current);
  if (cmp === null) return { status: 'failed' };
  if (cmp <= 0) return { status: 'latest' };
  if (!d.manual && isSkipped(d.storage, info.version)) return { status: 'quiet' };
  return { status: 'newer', info };
}
