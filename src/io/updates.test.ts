import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  KEY_LAST_CHECK,
  checkForUpdate,
  compareVersions,
  downloadTarget,
  isAllowedReleaseUrl,
  isCheckDue,
  isCheckEnabled,
  isSkipped,
  parseLatestRelease,
  parseVersion,
  setCheckEnabled,
  skipVersion,
  type KV,
} from './updates';

function mem(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const SAMPLE = {
  url: 'https://api.github.com/repos/GustafMos/rsmps/releases/1',
  tag_name: 'v0.6.0',
  name: 'RSMPS 0.6.0',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/GustafMos/rsmps/releases/tag/v0.6.0',
  assets: [],
};
const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

describe('version compare', () => {
  it('parses plain versions with or without v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.5.0')).toEqual([0, 5, 0]);
  });
  it('rejects malformed tags and pre-releases', () => {
    for (const t of ['', 'v1', '1.2', 'v1.2.3-beta.1', 'latest', '1.2.3.4', 'v1.x.3', null, 5]) expect(parseVersion(t)).toBeNull();
  });
  it('orders numerically, not as text', () => {
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0', 'v0.5.1')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
  it('gives null when either side is malformed', () => {
    expect(compareVersions('junk', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'v1.0.0-rc1')).toBeNull();
  });
});

describe('URL allow-list', () => {
  it('allows only https github.com/GustafMos/rsmps', () => {
    expect(isAllowedReleaseUrl('https://github.com/GustafMos/rsmps/releases/tag/v0.6.0')).toBe(true);
    expect(isAllowedReleaseUrl('https://github.com/GustafMos/rsmps')).toBe(true);
  });
  it('refuses lookalikes and other schemes', () => {
    for (const u of [
      'http://github.com/GustafMos/rsmps/releases',
      'https://github.com/GustafMos/rsmps-evil/releases',
      'https://github.com/Other/rsmps/releases',
      'https://github.com.evil.com/GustafMos/rsmps/',
      'https://evil.com/https://github.com/GustafMos/rsmps/',
      'https://user:pw@github.com/GustafMos/rsmps/',
      'https://github.com:8443/GustafMos/rsmps/',
      'javascript:alert(1)',
      'file:///C:/x',
      '',
      'not a url',
    ]) expect(isAllowedReleaseUrl(u), u).toBe(false);
    expect(isAllowedReleaseUrl(undefined)).toBe(false);
  });
});

describe('parseLatestRelease', () => {
  it('reads a sample API response', () => {
    expect(parseLatestRelease(SAMPLE)).toEqual({ version: '0.6.0', tag: 'v0.6.0', url: SAMPLE.html_url });
  });
  it('ignores drafts, pre-releases, bad tags, foreign links and junk', () => {
    expect(parseLatestRelease({ ...SAMPLE, draft: true })).toBeNull();
    expect(parseLatestRelease({ ...SAMPLE, prerelease: true })).toBeNull();
    expect(parseLatestRelease({ ...SAMPLE, tag_name: 'v0.6' })).toBeNull();
    expect(parseLatestRelease({ ...SAMPLE, html_url: 'https://evil.example/x' })).toBeNull();
    expect(parseLatestRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('x')).toBeNull();
  });
});

describe('download target', () => {
  const info = { version: '0.6.0', tag: 'v0.6.0', url: SAMPLE.html_url };
  it('is the release page while the store link is null or unusable', () => {
    expect(downloadTarget(info, null)).toBe(info.url);
    expect(downloadTarget(info, 'http://insecure.example/')).toBe(info.url);
    expect(downloadTarget(info, 'nonsense')).toBe(info.url);
  });
  it('is the store page once set', () => {
    expect(downloadTarget(info, 'https://example.itch.io/rsmps')).toBe('https://example.itch.io/rsmps');
  });
});

describe('once per day, skip and off switch (fake clock and storage)', () => {
  it('is due with no history, after 24 h, and with a timestamp from the future', () => {
    const s = mem();
    expect(isCheckDue(s, 1_000_000)).toBe(true);
    s.setItem(KEY_LAST_CHECK, '1000000');
    expect(isCheckDue(s, 1_000_000 + DAY_MS - 1)).toBe(false);
    expect(isCheckDue(s, 1_000_000 + DAY_MS)).toBe(true);
    expect(isCheckDue(s, 500)).toBe(true);
    s.setItem(KEY_LAST_CHECK, 'garbage');
    expect(isCheckDue(s, 1_000_000)).toBe(true);
  });
  it('is never due when switched off, and on by default', () => {
    const s = mem();
    expect(isCheckEnabled(s)).toBe(true);
    setCheckEnabled(s, false);
    expect(isCheckEnabled(s)).toBe(false);
    expect(isCheckDue(s, 9e12)).toBe(false);
    setCheckEnabled(s, true);
    expect(isCheckDue(s, 9e12)).toBe(true);
  });
  it('asks once, then stays quiet for 24 h, then asks again', async () => {
    const s = mem();
    let now = 5_000_000;
    let calls = 0;
    const fetchFn = async () => (calls++, { ok: true, json: async () => SAMPLE });
    const run = (manual = false) => checkForUpdate({ fetch: fetchFn, storage: s, now: () => now, current: '0.5.0', manual });
    expect((await run()).status).toBe('newer');
    expect((await run()).status).toBe('quiet');
    expect(calls).toBe(1);
    now += DAY_MS - 1;
    expect((await run()).status).toBe('quiet');
    now += 1;
    expect((await run()).status).toBe('newer');
    expect(calls).toBe(2);
  });
  it('a skipped version is silent automatically but shown by the manual check', async () => {
    const s = mem();
    skipVersion(s, '0.6.0');
    expect(isSkipped(s, '0.6.0')).toBe(true);
    expect(isSkipped(s, '0.6.1')).toBe(false);
    const deps = { fetch: ok(SAMPLE), storage: s, now: () => 1e9, current: '0.5.0' };
    expect((await checkForUpdate(deps)).status).toBe('quiet');
    expect((await checkForUpdate({ ...deps, manual: true })).status).toBe('newer');
    // a later version is not covered by the skip
    expect((await checkForUpdate({ ...deps, manual: true, fetch: ok({ ...SAMPLE, tag_name: 'v0.6.1' }) })).status).toBe('newer');
    s.data.delete(KEY_LAST_CHECK);
    expect((await checkForUpdate({ ...deps, fetch: ok({ ...SAMPLE, tag_name: 'v0.6.1' }) })).status).toBe('newer');
  });
  it('same or older version is "latest"; the manual check ignores the limit and the off switch', async () => {
    const s = mem();
    setCheckEnabled(s, false);
    const deps = { fetch: ok(SAMPLE), storage: s, now: () => 1e9, current: '0.6.0' };
    expect((await checkForUpdate(deps)).status).toBe('quiet');
    expect((await checkForUpdate({ ...deps, manual: true })).status).toBe('latest');
    expect((await checkForUpdate({ ...deps, manual: true, current: '0.7.0' })).status).toBe('latest');
  });
  it('fails silently on network errors, bad status and bad JSON, and does not record a check', async () => {
    const s = mem();
    const base = { storage: s, now: () => 1e9, current: '0.5.0' };
    expect((await checkForUpdate({ ...base, fetch: async () => { throw new Error('offline'); } })).status).toBe('failed');
    expect((await checkForUpdate({ ...base, fetch: async () => ({ ok: false, json: async () => ({}) }) })).status).toBe('failed');
    expect((await checkForUpdate({ ...base, fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }) })).status).toBe('failed');
    expect((await checkForUpdate({ ...base, fetch: ok({ tag_name: 'banana' }) })).status).toBe('failed');
    expect(s.data.has(KEY_LAST_CHECK)).toBe(false);
  });
  it('sends no headers or credentials of its own', async () => {
    let init: RequestInit | undefined;
    await checkForUpdate({ fetch: async (_u, i) => ((init = i), { ok: true, json: async () => SAMPLE }), storage: mem(), now: () => 1, current: '0.5.0' });
    expect(init?.headers).toBeUndefined();
    expect(init?.credentials).toBe('omit');
  });
});
