// Official add-ons (first: FFmpeg), downloaded only on request. Runs in the Electron main process; no Electron imports here so
// it can be unit-tested with plain Node. A file is only ever run after its SHA-256 matched the pin in the catalogue.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Validates a catalogue object. Throws a readable error for anything unexpected. */
export function parseCatalogue(raw, { allowLocalHttp = false } = {}) {
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.addons)) throw new Error('Unsupported add-on catalogue.');
  const seen = new Set();
  return raw.addons.map((a) => {
    if (!ID_RE.test(a?.id ?? '')) throw new Error(`Bad add-on id "${a?.id}".`);
    if (seen.has(a.id)) throw new Error(`Duplicate add-on "${a.id}".`);
    seen.add(a.id);
    for (const k of ['name', 'title', 'description', 'homepage']) if (typeof a[k] !== 'string' || !a[k]) throw new Error(`${a.id}: missing ${k}.`);
    const builds = {};
    for (const [key, b] of Object.entries(a.builds ?? {})) {
      if (!/^(win32|darwin|linux)-(x64|arm64|ia32)$/.test(key)) throw new Error(`${a.id}: bad platform key "${key}".`);
      const u = new URL(b.url);
      const localOk = allowLocalHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !localOk) throw new Error(`${a.id}/${key}: the download URL must be https.`);
      if (!SHA_RE.test(b.sha256 ?? '')) throw new Error(`${a.id}/${key}: sha256 must be 64 lowercase hex characters.`);
      if (!Number.isInteger(b.size) || b.size <= 0) throw new Error(`${a.id}/${key}: size must be a positive integer.`);
      if (!['zip', 'tar.xz', 'tar.gz'].includes(b.format)) throw new Error(`${a.id}/${key}: unsupported archive format.`);
      const paths = [b.extract?.binary, ...(b.extract?.extra ?? [])];
      for (const p of paths) if (typeof p !== 'string' || !p || p.startsWith('/') || p.split(/[\\/]/).includes('..')) throw new Error(`${a.id}/${key}: unsafe archive path "${p}".`);
      if (!b.version || !b.license?.name || !b.license?.url || !b.source?.name || !b.source?.url) throw new Error(`${a.id}/${key}: version, license and source are required.`);
      builds[key] = b;
    }
    return { ...a, builds };
  });
}

export function sha256File(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

/** Runs `<binary> -version`; resolves { ok, version } (ok only when it prints "ffmpeg version ..."). */
export function probeFfmpeg(binary) {
  return new Promise((ok) => {
    execFile(binary, ['-version'], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const m = !err && /^ffmpeg version (\S+)/m.exec(String(stdout));
      ok(m ? { ok: true, version: m[1] } : { ok: false, version: '' });
    });
  });
}

export const humanSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function download(url, file, { allowLocalHttp, onProgress, signal, maxBytes }) {
  return new Promise((ok, fail) => {
    const go = (u, hops) => {
      const parsed = new URL(u);
      const local = allowLocalHttp && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !local) return fail(new Error('Refusing a non-https download.'));
      const req = (parsed.protocol === 'https:' ? httpsGet : httpGet)(u, { headers: { 'user-agent': 'RSMPS-addon-installer' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 5) return fail(new Error('Too many redirects.'));
          return go(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`The server answered ${res.statusCode}.`));
        }
        const total = Number(res.headers['content-length']) || 0;
        const hash = createHash('sha256');
        const out = createWriteStream(file);
        let received = 0;
        res.on('data', (d) => {
          received += d.length;
          hash.update(d);
          if (received > maxBytes) req.destroy(new Error('The download is larger than expected.'));
          onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => ok({ sha256: hash.digest('hex'), bytes: received }));
        res.on('error', fail);
        out.on('error', fail);
      });
      req.on('error', fail);
      signal?.addEventListener('abort', () => req.destroy(new Error('Cancelled.')), { once: true });
    };
    go(url, 0);
  });
}

function extractTar(archive, dest) {
  return new Promise((ok, fail) => {
    execFile('tar', [archive.endsWith('.xz') ? '-xJf' : '-xzf', archive, '-C', dest], { timeout: 300000, windowsHide: true }, (err) => (err ? fail(new Error('Could not unpack the archive (the "tar" tool with xz support is needed).')) : ok()));
  });
}

/**
 * @param {{ userData: string, catalogue: ReturnType<typeof parseCatalogue>, platformKey?: string, allowLocalHttp?: boolean, detectSystem?: boolean }} cfg
 */
export function createAddonManager({ userData, catalogue, platformKey = `${process.platform}-${process.arch}`, allowLocalHttp = false, detectSystem = true, probe = probeFfmpeg }) {
  const root = join(userData, 'addons');
  const stateFile = join(root, 'state.json');
  const platform = platformKey.split('-')[0];
  /** @type {Record<string, { source: 'download' | 'custom', version: string, path: string, binarySha256?: string }>} */
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    /* nothing installed */
  }
  const save = () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };
  const find = (id) => catalogue.find((a) => a.id === id);
  /** id -> { phase, received, total, error?, abort, done } */
  const jobs = new Map();
  const verifiedPaths = new Set();

  async function systemFfmpeg() {
    const names = platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    for (const n of names) {
      const r = await probe(n);
      if (r.ok) return { path: n, version: r.version };
    }
    return null;
  }

  async function resolveBinary(id) {
    const s = state[id];
    if (s && existsSync(s.path)) {
      if (s.source === 'download' && !verifiedPaths.has(s.path)) {
        // The downloaded program must still be the one we verified (guards against tampering in the profile folder).
        if (s.binarySha256 && (await sha256File(s.path)) !== s.binarySha256) return null;
        verifiedPaths.add(s.path);
      }
      return { path: s.path, source: s.source, version: s.version };
    }
    if (id === 'ffmpeg' && detectSystem) {
      const sys = await systemFfmpeg();
      if (sys) return { path: sys.path, source: 'system', version: sys.version };
    }
    return null;
  }

  async function describe(a) {
    const b = a.builds[platformKey] ?? null;
    const job = jobs.get(a.id);
    const inst = await resolveBinary(a.id);
    const out = {
      id: a.id,
      name: a.name,
      title: a.title,
      description: a.description,
      homepage: a.homepage,
      /** null: no download is offered for this platform; use "bring your own" (locate / PATH). */
      download: b
        ? { version: b.version, size: b.size, sizeLabel: humanSize(b.size), host: b.source.host ?? new URL(b.url).host, license: b.license, source: b.source, sha256: b.sha256, hashVerifiedByMaintainer: b.verified === true }
        : null,
      bringYourOwn: a.bringYourOwn?.[platform] ?? '',
      canLocate: true,
      state: job && job.phase !== 'error' && job.phase !== 'cancelled' ? 'installing' : inst ? 'installed' : job?.phase === 'error' ? 'error' : 'not-installed',
      installed: inst ? { source: inst.source, version: inst.version, path: inst.path } : null,
    };
    if (job && (job.phase === 'downloading' || job.phase === 'verifying' || job.phase === 'extracting')) out.progress = { phase: job.phase, received: job.received, total: job.total || (b?.size ?? 0) };
    if (job?.phase === 'error') out.error = job.error;
    return out;
  }

  return {
    platformKey,
    jobs,
    state: () => state,
    async list() {
      return { platform: platformKey, addons: await Promise.all(catalogue.map(describe)) };
    },
    async get(id) {
      const a = find(id);
      return a ? describe(a) : null;
    },
    /** Path of a usable binary for an add-on, or null. */
    async binary(id) {
      return (await resolveBinary(id))?.path ?? null;
    },

    /** Starts an install in the background (poll `get`). Returns the promise for tests. */
    install(id) {
      const a = find(id);
      const b = a?.builds[platformKey];
      if (!a || !b) throw new Error('No download is available for this add-on on this platform.');
      const running = jobs.get(id);
      if (running && ['downloading', 'verifying', 'extracting'].includes(running.phase)) return running.done;
      const ac = new AbortController();
      const job = { phase: 'downloading', received: 0, total: b.size, abort: () => ac.abort(), done: null, error: '' };
      jobs.set(id, job);
      const tmp = join(root, '.tmp', `${id}-${process.pid}`);
      job.done = (async () => {
        try {
          rmSync(tmp, { recursive: true, force: true });
          mkdirSync(tmp, { recursive: true });
          const archive = join(tmp, 'archive.' + b.format);
          const got = await download(b.url, archive, { allowLocalHttp, signal: ac.signal, maxBytes: b.size + 1_000_000, onProgress: (r, t) => ((job.received = r), (job.total = t || b.size)) });
          job.phase = 'verifying';
          if (got.sha256 !== b.sha256) throw new Error('The downloaded file does not match the expected checksum and was deleted. Nothing was installed.');
          job.phase = 'extracting';
          const dest = join(root, id, b.version);
          const partial = dest + '.partial';
          rmSync(partial, { recursive: true, force: true });
          mkdirSync(partial, { recursive: true });
          const binName = basename(b.extract.binary);
          if (b.format === 'zip') {
            const wanted = new Set([b.extract.binary, ...(b.extract.extra ?? [])]);
            const files = unzipSync(new Uint8Array(readFileSync(archive)), { filter: (f) => wanted.has(f.name) });
            if (!files[b.extract.binary]) throw new Error('The archive does not contain the expected program.');
            for (const [name, data] of Object.entries(files)) {
              const target = resolve(partial, basename(name));
              if (!target.startsWith(resolve(partial) + sep)) throw new Error('Unsafe path in archive.');
              writeFileSync(target, data, { mode: 0o755 });
            }
          } else {
            await extractTar(archive, partial);
            const nested = join(partial, b.extract.binary);
            if (!existsSync(nested)) throw new Error('The archive does not contain the expected program.');
            renameSync(nested, join(partial, binName));
          }
          const bin = join(partial, binName);
          const run = await probe(bin);
          if (!run.ok) throw new Error('The unpacked program did not start.');
          rmSync(dest, { recursive: true, force: true });
          renameSync(partial, dest);
          const final = join(dest, binName);
          state[id] = { source: 'download', version: run.version, path: final, binarySha256: await sha256File(final) };
          verifiedPaths.add(final);
          save();
          job.phase = 'installed';
          jobs.delete(id);
        } catch (err) {
          job.phase = ac.signal.aborted ? 'cancelled' : 'error';
          job.error = String(err?.message ?? err);
          if (job.phase === 'cancelled') jobs.delete(id);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      })();
      return job.done;
    },

    cancel(id) {
      jobs.get(id)?.abort();
    },

    /** Removes a downloaded add-on (deletes its folder) or forgets a located one. */
    remove(id) {
      const s = state[id];
      if (s?.source === 'download') rmSync(join(root, id), { recursive: true, force: true });
      verifiedPaths.delete(s?.path);
      delete state[id];
      jobs.delete(id);
      save();
    },

    /** Use an FFmpeg that is already on this computer. Only accepted when `-version` really answers as ffmpeg. */
    async locate(id, file) {
      if (id !== 'ffmpeg') throw new Error('This add-on cannot be located.');
      if (typeof file !== 'string' || !existsSync(file) || !statSync(file).isFile()) throw new Error('That file does not exist.');
      const r = await probe(file);
      if (!r.ok) throw new Error('That file did not answer like FFmpeg ("-version" failed).');
      if (state[id]?.source === 'download') rmSync(join(root, id), { recursive: true, force: true });
      state[id] = { source: 'custom', version: r.version, path: file };
      save();
      return r;
    },
  };
}
