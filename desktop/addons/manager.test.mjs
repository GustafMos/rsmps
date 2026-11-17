import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAddonManager, parseCatalogue, probeAddon, sha256File } from './manager.mjs';

const real = JSON.parse(readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8'));
const KEY = 'win32-x64';
const fakeProbe = async (file) => (existsSync(file) && readFileSync(file, 'utf8').startsWith('FAKE-FFMPEG') ? { ok: true, version: 'test-1' } : { ok: false, version: '' });

describe('catalogue', () => {
  it('the shipped catalogue parses and every download is https with a sha256, size and licence', () => {
    const list = parseCatalogue(real);
    const ff = list.find((a) => a.id === 'ffmpeg');
    expect(ff).toBeTruthy();
    expect(list.map((a) => a.id)).toEqual(['ffmpeg', 'colmap', 'colmap-cuda', 'brush']);
    for (const b of list.flatMap((a) => Object.values(a.builds))) {
      expect(b.url.startsWith('https://')).toBe(true);
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.size).toBeGreaterThan(1e6);
      expect(b.license.name).toBeTruthy();
    }
  });
  const mutate = (fn) => {
    const c = structuredClone(real);
    fn(c.addons[0].builds[KEY]);
    return c;
  };
  it('rejects http, bad hashes, unsafe archive paths and unknown formats', () => {
    expect(() => parseCatalogue(mutate((b) => (b.url = 'http://example.com/x.zip')))).toThrow(/https/);
    expect(() => parseCatalogue(mutate((b) => (b.sha256 = 'abc')))).toThrow(/sha256/);
    expect(() => parseCatalogue(mutate((b) => (b.extract.binary = '../evil.exe')))).toThrow(/unsafe/);
    expect(() => parseCatalogue(mutate((b) => (b.extract.binary = '/abs/ffmpeg')))).toThrow(/unsafe/);
    expect(() => parseCatalogue(mutate((b) => (b.format = 'exe')))).toThrow(/format/);
    expect(() => parseCatalogue({ schema: 2, addons: [] })).toThrow();
  });
  it('allows 127.0.0.1 http only when asked (tests)', () => {
    const c = mutate((b) => (b.url = 'http://127.0.0.1:1/x.zip'));
    expect(() => parseCatalogue(c)).toThrow();
    expect(() => parseCatalogue(c, { allowLocalHttp: true })).not.toThrow();
  });
});

describe('install, verification and state', () => {
  let server, url, zip, sha, dir;
  beforeAll(async () => {
    zip = Buffer.from(zipSync({ 'pkg/bin/ffmpeg.exe': new TextEncoder().encode('FAKE-FFMPEG binary'), 'pkg/LICENSE': new TextEncoder().encode('lic') }));
    sha = createHash('sha256').update(zip).digest('hex');
    server = createServer((_q, r) => (r.writeHead(200, { 'content-length': zip.length }), r.end(zip)));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${server.address().port}/a.zip`;
    dir = mkdtempSync(join(tmpdir(), 'rsmps-addon-test-'));
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const make = (name, hash) => {
    const c = structuredClone(real);
    Object.assign(c.addons[0].builds[KEY], { url, sha256: hash, size: zip.length, extract: { binary: 'pkg/bin/ffmpeg.exe', extra: ['pkg/LICENSE'] } });
    return createAddonManager({ userData: join(dir, name), catalogue: parseCatalogue(c, { allowLocalHttp: true }), platformKey: KEY, allowLocalHttp: true, detectSystem: false, probe: fakeProbe });
  };

  it('good hash: not-installed -> installing -> installed, file in place, hash recorded; remove deletes it', async () => {
    const m = make('good', sha);
    expect((await m.get('ffmpeg')).state).toBe('not-installed');
    const done = m.install('ffmpeg');
    expect((await m.get('ffmpeg')).state).toBe('installing');
    await done;
    const st = await m.get('ffmpeg');
    expect(st.state).toBe('installed');
    expect(st.installed.source).toBe('download');
    const bin = await m.binary('ffmpeg');
    expect(await sha256File(bin)).toBe(m.state().ffmpeg.binarySha256);
    m.remove('ffmpeg');
    expect((await m.get('ffmpeg')).state).toBe('not-installed');
    expect(existsSync(bin)).toBe(false);
  });

  it('bad hash: error, nothing installed, nothing left on disk', async () => {
    const m = make('bad', '0'.repeat(64));
    await m.install('ffmpeg');
    const st = await m.get('ffmpeg');
    expect(st.state).toBe('error');
    expect(st.error).toMatch(/checksum/);
    expect(st.installed).toBeNull();
    expect(await m.binary('ffmpeg')).toBeNull();
    expect(existsSync(join(dir, 'bad', 'addons', 'ffmpeg'))).toBe(false);
  });

  it('a downloaded program changed afterwards is not used', async () => {
    const m = make('tamper', sha);
    await m.install('ffmpeg');
    const bin = await m.binary('ffmpeg');
    writeFileSync(bin, 'FAKE-FFMPEG tampered');
    const again = make('tamper', sha); // new process: hash cache empty
    expect(await again.binary('ffmpeg')).toBeNull();
  });

  it('locate: accepts only something that answers like ffmpeg, and survives a restart', async () => {
    const m = make('locate', sha);
    const good = join(dir, 'my-ffmpeg.exe');
    const other = join(dir, 'notepad.exe');
    writeFileSync(good, 'FAKE-FFMPEG mine');
    writeFileSync(other, 'MZ something else');
    await expect(m.locate('ffmpeg', other)).rejects.toThrow(/FFmpeg/);
    await expect(m.locate('ffmpeg', join(dir, 'missing.exe'))).rejects.toThrow(/exist/);
    await m.locate('ffmpeg', good);
    expect((await m.get('ffmpeg')).installed.source).toBe('custom');
    expect(await make('locate', sha).binary('ffmpeg')).toBe(good);
    m.remove('ffmpeg');
    expect(existsSync(good)).toBe(true); // a located program is never deleted
  });

  it('no download offered for a platform without a build', async () => {
    const m = createAddonManager({ userData: join(dir, 'none'), catalogue: parseCatalogue(real), platformKey: 'linux-x64', detectSystem: false, probe: fakeProbe });
    const st = await m.get('ffmpeg');
    expect(st.download).toBeNull();
    expect(st.bringYourOwn).toMatch(/apt/);
    expect(() => m.install('ffmpeg')).toThrow(/No download/);
  });
});

describe('multi-file tools (COLMAP, Brush)', () => {
  let server, url, zip, sha, dir;
  const enc = (t) => new TextEncoder().encode(t);
  beforeAll(async () => {
    // COLMAP-like layout: the program needs its DLL folder and Qt plugins; the archive also carries test programs we do not want
    zip = Buffer.from(
      zipSync({
        'bin/colmap.exe': enc('FAKE-COLMAP program'),
        'bin/ceres.dll': enc('dll'),
        'bin/feature_test.exe': enc('a test program'),
        'plugins/platforms/qwindows.dll': enc('plugin'),
        'COLMAP.bat': enc('@echo off'),
      }),
    );
    sha = createHash('sha256').update(zip).digest('hex');
    server = createServer((_q, r) => (r.writeHead(200, { 'content-length': zip.length }), r.end(zip)));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${server.address().port}/c.zip`;
    dir = mkdtempSync(join(tmpdir(), 'rsmps-addon-tree-'));
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = async (file, addon) => (existsSync(file) && readFileSync(file, 'utf8').startsWith(addon?.id === 'colmap' ? 'FAKE-COLMAP' : 'FAKE-FFMPEG') ? { ok: true, version: '4.2.1' } : { ok: false, version: '' });
  const make = (name) => {
    const c = structuredClone(real);
    const col = c.addons.find((a) => a.id === 'colmap');
    Object.assign(col.builds[KEY], { url, sha256: sha, size: zip.length });
    return createAddonManager({ userData: join(dir, name), catalogue: parseCatalogue(c, { allowLocalHttp: true }), platformKey: KEY, allowLocalHttp: true, detectSystem: false, probe });
  };

  it('the shipped COLMAP and Brush entries keep their layout rules, licences and the unsigned notice', () => {
    const list = parseCatalogue(real);
    const col = list.find((a) => a.id === 'colmap');
    expect(col.builds['win32-x64'].extract).toMatchObject({ binary: 'bin/colmap.exe', tree: ['bin/', 'plugins/'], exclude: ['_test.exe'] });
    expect(col.builds['linux-x64']).toBeUndefined(); // COLMAP publishes no Linux binary: bring your own
    expect(col.bringYourOwn.linux).toMatch(/Locate/);
    for (const id of ['colmap', 'colmap-cuda', 'brush']) {
      const a = list.find((x) => x.id === id);
      expect(a.group).toBe('splat-train');
      expect(a.notice).toMatch(/third-party program that runs on your computer/);
      expect(a.probe.args.length).toBeGreaterThan(0);
    }
    expect(list.find((a) => a.id === 'brush').builds['win32-x64'].license.name).toBe('Apache-2.0');
    expect(() => parseCatalogue({ ...real, addons: [{ ...real.addons[1], builds: { [KEY]: { ...real.addons[1].builds[KEY], extract: { binary: 'bin/colmap.exe', tree: ['bin'] } } } }] })).toThrow(/tree/);
  });

  it('installs the whole needed tree with paths kept, skips excluded files, records the main program hash', async () => {
    const m = make('tree');
    await m.install('colmap');
    const st = await m.get('colmap');
    expect(st.state).toBe('installed');
    const bin = await m.binary('colmap');
    expect(bin.replace(/\\/g, '/')).toMatch(/addons\/colmap\/4\.2\.1\/bin\/colmap\.exe$/);
    const root = join(bin, '..', '..');
    expect(existsSync(join(root, 'bin', 'ceres.dll'))).toBe(true);
    expect(existsSync(join(root, 'plugins', 'platforms', 'qwindows.dll'))).toBe(true);
    expect(existsSync(join(root, 'bin', 'feature_test.exe'))).toBe(false);
    expect(existsSync(join(root, 'COLMAP.bat'))).toBe(false); // scripts from the archive are never unpacked
    expect(m.state().colmap.binarySha256).toBe(await sha256File(bin));
    writeFileSync(bin, 'FAKE-COLMAP tampered');
    expect(await make('tree').binary('colmap')).toBeNull(); // re-checked before use in a new session
  });

  it('locate works for add-ons with a probe and is refused where the catalogue says so', async () => {
    const m = make('loc');
    const mine = join(dir, 'colmap-mine.exe');
    writeFileSync(mine, 'FAKE-COLMAP mine');
    await m.locate('colmap', mine);
    expect((await m.get('colmap')).installed.source).toBe('custom');
    await expect(m.locate('colmap', join(dir, 'colmap-mine.exe.missing'))).rejects.toThrow(/exist/);
    writeFileSync(join(dir, 'other.exe'), 'nope');
    await expect(m.locate('colmap', join(dir, 'other.exe'))).rejects.toThrow(/COLMAP/);
    await expect(m.locate('colmap-cuda', mine)).rejects.toThrow(/cannot be located/);
    expect((await m.get('colmap-cuda')).canLocate).toBe(false);
  });

  it('probeAddon runs the program with the catalogue arguments and reads the version from its output', async () => {
    const ok = await probeAddon(process.execPath, { probe: { args: ['-e', 'console.log("COLMAP 4.2.1 (Commit x)")'], pattern: '^COLMAP (\\S+)' } });
    expect(ok).toEqual({ ok: true, version: '4.2.1' });
    const bad = await probeAddon(process.execPath, { probe: { args: ['-e', 'console.log("something else")'], pattern: '^COLMAP (\\S+)' } });
    expect(bad.ok).toBe(false);
    const failed = await probeAddon(process.execPath, { probe: { args: ['-e', 'console.log("COLMAP 1"); process.exit(3)'], pattern: '^COLMAP (\\S+)' } });
    expect(failed.ok).toBe(false); // a crashing program is not accepted even when it printed the right words
  });
});
