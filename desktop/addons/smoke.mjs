// --smoke-addons: installs an add-on (from a LOCAL test server, never from the internet) into a throw-away profile, runs it,
// exports 12 RGBA frames with alpha to ProRes 4444 through the renderer-facing endpoints, checks the file, removes the add-on.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A zip holding a copy of `ffmpegPath` served on 127.0.0.1, and a catalogue entry pointing at it. */
export async function prepareAddonSmoke(ffmpegPath, platformKey, { corrupt = false } = {}) {
  const bin = basename(ffmpegPath);
  const inner = `fake-ffmpeg/bin/${bin}`;
  const zip = Buffer.from(zipSync({ [inner]: new Uint8Array(readFileSync(ffmpegPath)), 'fake-ffmpeg/LICENSE': new TextEncoder().encode('test') }, { level: 0 }));
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const server = createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
    r.end(zip);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/ffmpeg-test.zip`;
  const catalogue = {
    schema: 1,
    addons: [
      {
        id: 'ffmpeg', name: 'FFmpeg', title: 'ProRes-compatible export (via FFmpeg)', description: 'test', homepage: 'https://ffmpeg.org',
        builds: {
          [platformKey]: {
            version: 'test', format: 'zip', url, sha256: corrupt ? '0'.repeat(64) : sha256, size: zip.length,
            extract: { binary: inner, extra: ['fake-ffmpeg/LICENSE'] },
            license: { name: 'test', url: 'https://example.com/license' }, source: { name: 'local test server', url, host: '127.0.0.1' },
          },
        },
      },
    ],
  };
  return { catalogue, close: () => server.close(), bytes: zip.length };
}

/**
 * @param {ReturnType<import('./manager.mjs').createAddonManager>} mgr manager over the prepared catalogue (fresh profile, no add-on installed)
 * @param {{ sink: any[], evalInPage: (js: string) => Promise<any>, ffmpegPath: string, makeBadManager: () => ReturnType<import('./manager.mjs').createAddonManager>, outFile: string }} ctx
 */
export async function runAddonSmoke(mgr, ctx) {
  const checks = ctx.sink;
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const page = (js) => ctx.evalInPage(js);
  const api = (path, method = 'GET', body) =>
    page(`fetch('app://rsmps/__rsmps/${path}', { method: '${method}'${body ? `, headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)})` : ''} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

  // 1. catalogue and states
  let r = await api('addons');
  const ff0 = r.body?.addons?.find((a) => a.id === 'ffmpeg');
  check('GET addons lists ffmpeg, not installed', r.status === 200 && ff0?.state === 'not-installed' && ff0.download && ff0.download.license.name && ff0.download.sizeLabel, ff0 && { state: ff0.state, size: ff0.download?.sizeLabel });
  r = await api('export/ffmpeg/start', 'POST', { width: 64, height: 48, fps: 24, codec: 'prores4444' });
  check('export refused (409) while no ffmpeg is set up', r.status === 409, r.body?.error);

  // 2. a file that does not match the pin is never installed or run
  const bad = ctx.makeBadManager();
  await bad.install('ffmpeg');
  const bs = await bad.get('ffmpeg');
  check('bad checksum: refused, nothing installed', bs.state === 'error' && /checksum/i.test(bs.error ?? '') && !bs.installed, bs.error);

  // 3. install through the renderer endpoints
  r = await api('addons/ffmpeg/install', 'POST');
  check('POST install starts', r.status === 200 && ['installing', 'installed'].includes(r.body?.state), r.body?.state);
  let st = r.body;
  for (let i = 0; i < 100 && st?.state === 'installing'; i++) {
    await sleep(100);
    st = (await api('addons/ffmpeg')).body;
  }
  check('installed (download, version, path)', st?.state === 'installed' && st.installed?.source === 'download', st?.installed && { source: st.installed.source, version: st.installed.version });
  const ver = st?.installed?.path ? execFileSync(st.installed.path, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0] : '';
  check('installed ffmpeg runs -version', /^ffmpeg version/.test(ver), ver);

  // 4. export: 12 frames with a horizontal alpha ramp to ProRes 4444
  const W = 64, H = 48, N = 12;
  r = await api('export/ffmpeg');
  check('GET export/ffmpeg available with codecs', r.body?.available === true && r.body.codecs.some((c) => c.id === 'prores4444' && c.alpha), r.body?.codecs?.length);
  r = await api('export/ffmpeg/start', 'POST', { width: 63, height: 48, fps: 24, codec: 'h264' });
  check('odd size for h264 rejected (400)', r.status === 400, r.body?.error);
  r = await api('export/ffmpeg/start', 'POST', { width: W, height: H, fps: 24, codec: 'nope' });
  check('unknown codec rejected (400)', r.status === 400);
  r = await api('export/ffmpeg/start', 'POST', { width: W, height: H, fps: 24, codec: 'prores4444' });
  const id = r.body?.id;
  check('start prores4444', r.status === 200 && id && r.body.alpha === true && r.body.frameBytes === W * H * 4, r.body);
  const second = await api('export/ffmpeg/start', 'POST', { width: W, height: H, fps: 24, codec: 'prores' });
  check('second concurrent export rejected (409)', second.status === 409);
  const badFrame = await page(`fetch('app://rsmps/__rsmps/export/ffmpeg/${id}/frame', { method: 'POST', body: new Uint8Array(10) }).then((x) => x.status)`);
  check('wrong frame size rejected (400)', badFrame === 400);
  const posted = await page(`(async () => {
    const W = ${W}, H = ${H};
    let last = 0;
    for (let f = 0; f < ${N}; f++) {
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; px[i] = 255; px[i + 1] = (f * 20) & 255; px[i + 2] = 40; px[i + 3] = Math.round((x / (W - 1)) * 255); }
      const res = await fetch('app://rsmps/__rsmps/export/ffmpeg/${id}/frame', { method: 'POST', body: px });
      const j = await res.json();
      if (res.status !== 200) return { error: j.error, status: res.status };
      last = j.frames;
    }
    return { frames: last };
  })()`);
  check('12 frames accepted', posted.frames === N, posted);
  r = await api(`export/ffmpeg/${id}/finish`, 'POST');
  check('finish saves a file', r.status === 200 && r.body?.saved === true && r.body.bytes > 1000 && existsSync(r.body.path), r.body && { bytes: r.body.bytes, frames: r.body.frames });
  if (r.body?.path) {
    // Decode it back with the same ffmpeg: frame count, size, codec and the alpha ramp must survive.
    const info = (() => {
      try {
        return execFileSync(st.installed.path, ['-hide_banner', '-i', r.body.path], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return String(e.stderr ?? '');
      }
    })();
    check('output is ProRes 4444, 64x48', /Video: prores/.test(info) && /4444/.test(info) && /64x48/.test(info), (/Video: [^\n]+/.exec(info) ?? [''])[0].slice(0, 100));
    const raw = execFileSync(st.installed.path, ['-v', 'error', '-i', r.body.path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 26 });
    check('decodes to 12 frames', raw.length === W * H * 4 * N, raw.length / (W * H * 4));
    const a = (frame, x, y) => raw[(frame * W * H + y * W + x) * 4 + 3];
    check('alpha preserved (ramp 0 -> 255)', a(0, 0, 10) <= 3 && a(0, W - 1, 10) >= 252 && Math.abs(a(5, 32, 20) - Math.round((32 / 63) * 255)) <= 3, { left: a(0, 0, 10), mid: a(5, 32, 20), right: a(0, W - 1, 10) });
    rmSync(r.body.path, { force: true });
  }
  const left = (await api('export/ffmpeg')).body?.active;
  check('no export session left behind', !left);

  // 5. cancel cleans up
  r = await api('export/ffmpeg/start', 'POST', { width: W, height: H, fps: 24, codec: 'png' });
  await page(`fetch('app://rsmps/__rsmps/export/ffmpeg/${r.body.id}/frame', { method: 'POST', body: new Uint8Array(${W * H * 4}) })`);
  const c = await api(`export/ffmpeg/${r.body.id}/cancel`, 'POST');
  check('cancel ok and session gone', c.status === 200 && (await api(`export/ffmpeg/${r.body.id}/frame`, 'POST')).status === 404);

  // 6. remove deletes the folder
  const dir = join(ctx.userData, 'addons', 'ffmpeg');
  r = await api('addons/ffmpeg/remove', 'POST');
  check('remove deletes files, state not-installed', r.status === 200 && r.body?.state === 'not-installed' && !existsSync(dir), r.body?.state);
  const failed = checks.filter((x) => !x.ok).map((x) => x.name);
  return { ok: failed.length === 0, failed, checks };
}
