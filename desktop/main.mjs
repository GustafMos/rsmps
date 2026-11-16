// RSMPS desktop shell (Electron main process).
//
// Loads the production web build from the app bundle through a private `app://rsmps/` protocol, so the existing
// `base: './'` build, ES module workers, AudioWorklets and `import.meta` URLs behave exactly as on the web.
// Everything runs offline; there is no server. Security: sandboxed renderer, context isolation, no Node in the page,
// no preload script, strict navigation and permission policies. See docs/STORE.md and docs/RELEASING.md.
import { app, BrowserWindow, Menu, net, protocol, screen, session, shell, dialog, clipboard } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBackupMirror, MAX_BODY as BACKUP_MAX_BODY } from './backups.mjs';
import { UNRESPONSIVE_DIALOG, onChildGone, onRendererGone, withSafeParam } from './crash.mjs';

const SCHEME = 'app';
const HOST = 'rsmps';
const ORIGIN = `${SCHEME}://${HOST}`;
// Same paragraph as the README and the in-app About box (src/ui/aboutCopy.ts; a test keeps them equal).
const NOT_AFFILIATED = "RSMPS is an independent project. It is not affiliated with, sponsored by or endorsed by Blackmagic Design, the Blender Foundation, Adobe, Ableton, Apple, or any other company, product or creator mentioned here. DaVinci Resolve, Fusion, Blender, Adobe Color, Ableton Live and ProRes are trademarks of their respective owners. They are named only to describe what inspired this tool or what it works with. Adobe Color inspired Palette Studio; Blender's shader nodes and DaVinci Resolve's Fusion page inspired the node workflow.";
const HOMEPAGE = 'https://github.com/GustafMos/rsmps';
const KOFI = 'https://ko-fi.com/ripscorpy';

const argv = process.argv.slice(1);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const smokePhone = flag('smoke-phone');
const smokeAddons = flag('smoke-addons');
const smoke = flag('smoke-test') || smokePhone || smokeAddons;
// A dev server URL is honoured only when running unpackaged (npm run desktop:dev).
const devUrl = !app.isPackaged ? (option('dev-url') ?? process.env.RSMPS_DEV_URL) : undefined;
const appOrigin = devUrl ? new URL(devUrl).origin : ORIGIN;

// Chromium switches. Windows (D3D12) and macOS (Metal) need none: WebGPU ships enabled in Chromium.
// Linux: WebGPU runs on Vulkan, which Chromium keeps behind flags on many setups, so enable it explicitly.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
}

if (smoke) app.setPath('userData', join(tmpdir(), `rsmps-smoke-${process.pid}`)); // never touch real user data

// The scheme must be registered before `ready`. Standard + secure gives a real origin: IndexedDB, localStorage,
// workers/worklets, camera and MIDI (secure context only) all work like on https.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const gotLock = smoke || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/** @type {BrowserWindow | null} */
let win = null;

// ---- serving the bundle ------------------------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

// Plugins are user-supplied single-file node definitions loaded from blob: URLs, hence blob: in script-src.
// connect/img/media allow http(s) because live-input nodes can read IP-camera snapshots and streams.
const csp = () => [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: http: https:",
  "media-src 'self' blob: data: http: https:",
  "font-src 'self' data:",
  `connect-src 'self' blob: data: http: https:${phone ? ` wss://127.0.0.1:${phone.port} wss://localhost:${phone.port}` : ''}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

function registerAppProtocol() {
  const root = resolve(join(app.getAppPath(), 'web'));
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (rel.startsWith('/__rsmps/')) return handleInternal(request, rel, url);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = resolve(root, '.' + rel);
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
    } catch {
      return new Response('Not found', { status: 404 }); // also what the /__rsmps/lan-info probe gets: phone link stays off
    }
    const res = await net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
    const headers = new Headers(res.headers);
    headers.set('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    headers.set('Content-Security-Policy', csp());
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
}

// ---- phone link (on demand, in this process; see desktop/phone/service.mjs) --------------------------------------------

/** @type {null | ReturnType<typeof import('./phone/service.mjs').createPhoneService>} */
let phone = null;
let phoneAsk = null;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp() } });

const unavailableInfo = () => ({ lan: false, desktop: true, state: 'off', origins: [], candidates: [], ws: '' });

/** The native confirmation before the first time a port is opened (unless the user chose "Don't ask again"). */
async function confirmPhoneLink() {
  if (!phone) return false;
  if (phone.settings.consent === 'allow' || smoke) return true;
  phoneAsk ??= (async () => {
    const opts = {
      type: 'question',
      title: 'RSMPS phone link',
      message: 'Allow phones on your network to connect to RSMPS?',
      detail: 'This opens a port on this computer while the phone link is in use. It closes by itself when you close the link, and after 10 minutes without use. Windows may ask you to allow RSMPS through the firewall: allow it on private networks only.',
      buttons: ['Allow', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't ask again (always allow)",
      noLink: true,
    };
    const r = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    if (r.response !== 0) return false;
    if (r.checkboxChecked) phone.setSettings({ consent: 'allow' });
    return true;
  })().finally(() => (phoneAsk = null));
  return phoneAsk;
}

async function phoneStart() {
  if (!phone) return { ...unavailableInfo(), state: 'error', error: 'The phone link is not available in this build.' };
  if (phone.state === 'on') return phone.info();
  if (!(await confirmPhoneLink())) return { ...phone.info(), declined: true };
  return phone.start();
}

/** app://rsmps/__rsmps/*: the only way the (sandboxed, preload-less) renderer talks to the main process. */
async function handleInternal(request, rel, url) {
  const ownPage = (request.headers.get('origin') ?? ORIGIN) === ORIGIN && request.headers.get('sec-fetch-site') !== 'cross-site';
  if (!ownPage) return new Response('Forbidden', { status: 403 });
  if (rel === '/__rsmps/lan-info') return request.method === 'GET' ? json(phone ? phone.info() : unavailableInfo()) : new Response('Method not allowed', { status: 405 });
  if (rel === '/__rsmps/lan-start' || rel === '/__rsmps/lan-stop') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!phone) return json(unavailableInfo());
    return json(rel.endsWith('start') ? await phoneStart() : await phone.stop());
  }
  if (rel === '/__rsmps/backups' || rel.startsWith('/__rsmps/backups/')) return handleBackups(request, rel, url);
  if (rel === '/__rsmps/addons' || rel.startsWith('/__rsmps/addons/')) return handleAddons(request, rel);
  if (rel === '/__rsmps/export/ffmpeg' || rel.startsWith('/__rsmps/export/ffmpeg/')) return handleExport(request, rel);
  return new Response('Not found', { status: 404 });
}

// ---- autosave backups (desktop/backups.mjs) ---------------------------------------------------------------------------------

let backupMirror = null;
const backups = () => (backupMirror ??= createBackupMirror(join(app.getPath('userData'), 'backups')));

async function handleBackups(request, rel, url) {
  try {
    if (rel === '/__rsmps/backups') {
      if (request.method === 'GET') return json({ backups: backups().list() });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (Number(request.headers.get('content-length') ?? 0) > BACKUP_MAX_BODY) return new Response('Too large', { status: 413 });
      backups().write(await request.json());
      return json({ ok: true });
    }
    if (rel === '/__rsmps/backups/file' && request.method === 'GET') {
      return new Response(backups().read(url.searchParams.get('name') ?? ''), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    if (rel === '/__rsmps/backups/reveal' && request.method === 'POST') {
      const dir = backups().dir;
      mkdirSync(dir, { recursive: true });
      void shell.openPath(dir);
      return json({ path: dir });
    }
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 400);
  }
  return new Response('Not found', { status: 404 });
}

async function loadPhone() {
  const file = app.isPackaged ? join(app.getAppPath(), 'phone-server.mjs') : join(dirname(fileURLToPath(import.meta.url)), 'build', 'phone-server.mjs');
  try {
    const mod = await import(pathToFileURL(file).toString());
    phone = mod.createPhoneService({ userData: app.getPath('userData'), webRoot: join(app.getAppPath(), 'web'), appOrigin: ORIGIN });
    await phone.reservePort();
    phone.onChange(() => buildMenu());
    return mod;
  } catch (err) {
    phone = null; // the app still works; only the phone link is off
    console.warn('Phone link unavailable:', err?.message ?? err);
    return null;
  }
}

// ---- official add-ons and ffmpeg export (desktop/addons/) ---------------------------------------------------------------------

/** @type {null | { mgr: any, exporter: any, mod: any, prep?: any, bad?: any }} */
let addons = null;
const smokeFfmpeg = option('smoke-ffmpeg');
const smokeExportOut = join(tmpdir(), 'rsmps-smoke-export.mov');

async function loadAddons() {
  const file = app.isPackaged ? join(app.getAppPath(), 'addons.mjs') : join(dirname(fileURLToPath(import.meta.url)), 'build', 'addons.mjs');
  try {
    const mod = await import(pathToFileURL(file).toString());
    const platformKey = `${process.platform}-${process.arch}`;
    let catalogue;
    let prep;
    let bad;
    if (smokeAddons) {
      if (!smokeFfmpeg) throw new Error('--smoke-addons needs --smoke-ffmpeg=<path to an ffmpeg binary>');
      prep = await mod.prepareAddonSmoke(smokeFfmpeg, platformKey);
      bad = await mod.prepareAddonSmoke(smokeFfmpeg, platformKey, { corrupt: true });
      catalogue = mod.parseCatalogue(prep.catalogue, { allowLocalHttp: true });
    } else catalogue = mod.parseCatalogue(mod.catalogueRaw);
    const mgr = mod.createAddonManager({ userData: app.getPath('userData'), catalogue, platformKey, allowLocalHttp: smokeAddons, detectSystem: !smokeAddons });
    const exporter = mod.createExportService({
      tmpRoot: join(tmpdir(), 'rsmps-export'),
      binary: () => mgr.binary('ffmpeg'),
      pickSavePath: async (name, ext) => {
        if (smokeAddons) return smokeExportOut;
        const r = await dialog.showSaveDialog(win ?? undefined, { title: 'Save video', defaultPath: `${name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        return r.canceled ? null : r.filePath;
      },
    });
    addons = { mgr, exporter, mod, prep, bad, badCatalogue: bad && mod.parseCatalogue(bad.catalogue, { allowLocalHttp: true }), platformKey };
    return addons;
  } catch (err) {
    addons = null;
    console.warn('Add-ons unavailable:', err?.message ?? err);
    return null;
  }
}

const readBody = async (request) => Buffer.from(await request.arrayBuffer());
const readJson = async (request) => {
  try {
    return JSON.parse((await readBody(request)).toString('utf8') || '{}');
  } catch {
    return {};
  }
};

async function confirmInstall(info) {
  if (smoke) return true;
  const d = info.download;
  const r = await dialog.showMessageBox(win ?? undefined, {
    type: 'question',
    title: 'Install add-on',
    message: `Download ${info.name} ${d.version}?`,
    detail: [info.title, '', `Licence: ${d.license.name}`, `Source: ${d.source.name}`, `Downloaded from: ${d.host}`, `Size: about ${d.sizeLabel}`, '', 'RSMPS does not include or host this program. The file is checked against a known checksum before it is used. You can remove it again at any time.'].join('\n'),
    buttons: ['Download and install', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return r.response === 0;
}

async function handleAddons(request, rel) {
  if (!addons) return json({ error: 'Add-ons are not available in this build.' }, 503);
  const { mgr } = addons;
  const parts = rel.split('/').slice(3); // after /__rsmps/addons
  if (parts.length === 0) return request.method === 'GET' ? json(await mgr.list()) : new Response('Method not allowed', { status: 405 });
  const [id, action] = parts;
  const info = await mgr.get(id);
  if (!info) return json({ error: 'Unknown add-on.' }, 404);
  if (!action) return request.method === 'GET' ? json(info) : new Response('Method not allowed', { status: 405 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (action === 'install') {
    if (!info.download) return json({ ...info, error: 'No download is offered for this platform. Use Locate to pick an FFmpeg you already have.' }, 400);
    if (info.state === 'installing') return json(info);
    if (!(await confirmInstall(info))) return json({ ...info, declined: true });
    void mgr.install(id);
    return json(await mgr.get(id));
  }
  if (action === 'cancel') {
    mgr.cancel(id);
    return json(await mgr.get(id));
  }
  if (action === 'remove') {
    mgr.remove(id);
    return json(await mgr.get(id));
  }
  if (action === 'locate') {
    // Only a native file dialog can name the program to run; the renderer never supplies a path.
    const r = await dialog.showOpenDialog(win ?? undefined, { title: 'Choose your FFmpeg program', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return json({ ...(await mgr.get(id)), canceled: true });
    try {
      await mgr.locate(id, r.filePaths[0]);
    } catch (err) {
      return json({ ...(await mgr.get(id)), error: String(err?.message ?? err) }, 400);
    }
    return json(await mgr.get(id));
  }
  return new Response('Not found', { status: 404 });
}

async function handleExport(request, rel) {
  if (!addons) return json({ error: 'Add-ons are not available in this build.' }, 503);
  const { mgr, exporter, mod } = addons;
  const parts = rel.split('/').slice(4); // after /__rsmps/export/ffmpeg
  try {
    if (parts.length === 0) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const b = await mgr.get('ffmpeg');
      return json({ available: !!b?.installed, source: b?.installed?.source ?? null, version: b?.installed?.version ?? null, codecs: exporter.codecs(), active: exporter.sessions.size > 0 });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (parts[0] === 'start') return json(await exporter.start(await readJson(request)));
    const [id, action] = parts;
    if (action === 'audio') return json(await exporter.audio(id, await readBody(request)));
    if (action === 'frame') return json(await exporter.frame(id, await readBody(request)));
    if (action === 'finish') return json(await exporter.finish(id));
    if (action === 'cancel') return json(await exporter.cancel(id));
    return new Response('Not found', { status: 404 });
  } catch (err) {
    if (err instanceof mod.ExportError) return json({ error: err.message }, err.status);
    return json({ error: String(err?.message ?? err) }, 500);
  }
}

/** The Windows installer's optional "download FFmpeg" tick leaves a request file; the SAME in-app install flow runs, nothing else downloads. */
async function processAddonRequests() {
  const file = join(app.getPath('userData'), 'addon-requests.json');
  let req;
  try {
    req = JSON.parse(readFileSync(file, 'utf8'));
    rmSync(file, { force: true });
  } catch {
    return;
  }
  for (const id of Object.keys(req ?? {})) {
    if (req[id] !== true || !addons) continue;
    const info = await addons.mgr.get(id);
    if (!info?.download || info.installed) continue;
    await addons.mgr.install(id);
    const after = await addons.mgr.get(id);
    if (after.state === 'error' && win) dialog.showMessageBox(win, { type: 'error', title: 'Add-on', message: `${info.name} could not be installed.`, detail: `${after.error}\n\nYou can try again from the Plugins dialog (Official add-ons).` });
  }
}

// ---- policies ----------------------------------------------------------------------------------------------------

/** Open only well-formed https links in the system browser. Everything else is dropped. */
function openExternalSafe(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.username && !u.password) void shell.openExternal(u.toString());
  } catch {
    /* ignore malformed URLs */
  }
}

function installSessionPolicies(ses) {
  // Camera + microphone ("media") and MIDI for the app's own origin only. Everything else is denied.
  const allowed = new Set(['media', 'midi']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    let origin = '';
    try {
      origin = new URL(details.requestingUrl).origin;
    } catch {
      /* leave empty */
    }
    callback(allowed.has(permission) && origin === appOrigin && wc === win?.webContents);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && requestingOrigin === appOrigin);
  ses.setDevicePermissionHandler(() => false);
}

// The renderer's own WebSocket to the phone server (wss://127.0.0.1:<port>) uses a self-signed certificate. Trust exactly
// that certificate (matched by fingerprint) for this app's window, our own host names and our port. Certificate checking
// is not disabled anywhere else: every other certificate error keeps failing.
app.on('certificate-error', (event, wc, url, _error, certificate, callback) => {
  let ok = false;
  try {
    const u = new URL(url);
    ok = !!phone && phone.state === 'on' && wc === win?.webContents && (u.protocol === 'wss:' || u.protocol === 'https:') && Number(u.port) === phone.port && phone.hosts().includes(u.hostname) && phone.isOurCertificate(certificate.fingerprint);
  } catch {
    /* untrusted */
  }
  if (ok) event.preventDefault();
  callback(ok);
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      /* fall through: blocked */
    }
    if (origin === appOrigin) return; // reloads
    e.preventDefault();
    openExternalSafe(url);
  });
});

// ---- window ------------------------------------------------------------------------------------------------------

const statePath = () => join(app.getPath('userData'), 'window-state.json');

function loadState() {
  const fallback = { width: 1440, height: 900, maximized: false };
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return fallback;
    const out = { width: Math.max(800, s.width), height: Math.max(560, s.height), maximized: s.maximized === true };
    // Restore the position only if it is still on a connected display.
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const visible = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return s.x >= b.x - 20 && s.y >= b.y - 20 && s.x < b.x + b.width - 100 && s.y < b.y + b.height - 100;
      });
      if (visible) Object.assign(out, { x: s.x, y: s.y });
    }
    return out;
  } catch {
    return fallback;
  }
}

function trackState(w) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = null;
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    const maximized = w.isMaximized();
    const b = maximized ? w.getNormalBounds() : w.getBounds();
    try {
      mkdirSync(dirname(statePath()), { recursive: true });
      writeFileSync(statePath(), JSON.stringify({ ...b, maximized }));
    } catch {
      /* state is a convenience only */
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) w.on(ev, later);
  w.on('close', save);
}

const windowIcon = join(app.getAppPath(), 'icon.png');

function createWindow() {
  const st = smoke ? { width: 1280, height: 800, maximized: false } : loadState();
  const { maximized, ...bounds } = st;
  win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0f14',
    title: 'RSMPS',
    ...(process.platform !== 'darwin' && existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    if (smoke) return;
    if (maximized) win.maximize();
    win.show();
  });
  win.on('closed', () => {
    win = null;
  });
  if (!smoke) trackState(win);
  void win.loadURL(devUrl ?? `${ORIGIN}/index.html`);
  if (!smoke) watchHealth(win);
  return win;
}

// ---- crash and hang recovery (policy in crash.mjs) ----------------------------------------------------------------------------

/** Reload the page with rendering paused (?safe=1): the project opens, nothing is evaluated. */
function reloadSafe(w) {
  if (!w || w.isDestroyed()) return;
  const wc = w.webContents;
  const current = wc.getURL();
  const target = !current || current.startsWith('chrome-error') ? (devUrl ?? `${ORIGIN}/index.html`) : current;
  void w.loadURL(withSafeParam(target));
}

let reloads = [];
let askingHang = false;

function watchHealth(w) {
  const wc = w.webContents;
  wc.on('unresponsive', async () => {
    if (askingHang || w.isDestroyed()) return;
    askingHang = true;
    try {
      const r = await dialog.showMessageBox(w, { type: 'warning', title: UNRESPONSIVE_DIALOG.title, message: UNRESPONSIVE_DIALOG.message, detail: UNRESPONSIVE_DIALOG.detail, buttons: UNRESPONSIVE_DIALOG.buttons, defaultId: 0, cancelId: 0, noLink: true });
      if (r.response === 1) reloadSafe(w);
    } finally {
      askingHang = false;
    }
  });
  wc.on('render-process-gone', (_e, d) => {
    const plan = onRendererGone(d.reason, reloads, Date.now());
    reloads = plan.recentReloads;
    if (plan.action === 'reload-safe') reloadSafe(w);
    else if (plan.action === 'ask') {
      void dialog.showMessageBox(w, { type: 'error', title: 'RSMPS keeps crashing', message: 'RSMPS crashed several times in a row.', detail: 'Reload in safe mode to open the project with rendering paused, or close the app. Your project is saved automatically and backups are in the app data folder (Project > Backups).', buttons: ['Reload in safe mode', 'Close'], defaultId: 0, cancelId: 1, noLink: true }).then((r) => (r.response === 0 ? reloadSafe(w) : w.close()));
    }
  });
}

app.on('child-process-gone', (_e, details) => {
  if (smoke || !win || !onChildGone(details.type, details.reason)) return;
  reloadSafe(win); // the GPU process died: the page's WebGPU device is gone with it
});

// ---- menu and About ------------------------------------------------------------------------------------------------

function showAbout() {
  const detail = [
    `Version ${app.getVersion()}`,
    'Licence: MIT. The source is free; this build is a convenience package of it.',
    `Source: ${HOMEPAGE}`,
    '',
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
    'Third-party licences: THIRD_PARTY_LICENSES.txt in the application resources folder.',
    '',
    'The app asks GitHub once a day whether a newer version exists and sends nothing else. Turn it off in the About dialog inside the app.',
    '',
    NOT_AFFILIATED,
  ].join('\n');
  const opts = { type: 'info', title: 'About RSMPS', message: 'RipScorpy Media Processing Suite (RSMPS)', detail, buttons: ['OK', 'Source code', 'Support on Ko-fi'], defaultId: 0, cancelId: 0, noLink: true };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => {
    if (r.response === 1) openExternalSafe(HOMEPAGE);
    if (r.response === 2) openExternalSafe(KOFI);
  });
}

function phoneMenu() {
  const st = phone?.state ?? 'off';
  const names = { off: 'Off', starting: 'Starting...', on: 'On', error: 'Error' };
  const items = [
    {
      label: `Phone link: ${names[st]}${st === 'off' ? ' (click to turn on)' : st === 'on' ? ' (click to turn off)' : ''}`,
      enabled: !!phone && st !== 'starting',
      click: async () => {
        if (!phone) return;
        if (phone.state === 'on') await phone.stop();
        else {
          const r = await phoneStart();
          if (r.state === 'error' && win) dialog.showMessageBox(win, { type: 'error', title: 'Phone link', message: 'The phone link could not start.', detail: r.error ?? '' });
        }
      },
    },
  ];
  if (phone && st === 'on') {
    items.push({ type: 'separator' }, { label: 'Addresses a phone can use (click to copy):', enabled: false });
    for (const c of phone.info().candidates) items.push({ label: `  ${c.url}  ${c.label}`, click: () => clipboard.writeText(c.url) });
  }
  if (phone) {
    items.push(
      { type: 'separator' },
      { label: 'Use Tailscale certificate when available', type: 'checkbox', checked: phone.settings.tailscale, click: (i) => phone.setSettings({ tailscale: i.checked }) },
      { label: 'Ask before opening the port', type: 'checkbox', checked: phone.settings.consent !== 'allow', click: (i) => phone.setSettings({ consent: i.checked ? 'ask' : 'allow' }) },
    );
  }
  return { label: 'Phone', submenu: items };
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const link = (label, url) => ({ label, click: () => openExternalSafe(url) });
  const template = [
    ...(mac ? [{ label: app.name, submenu: [{ label: 'About RSMPS', click: showAbout }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [mac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { label: 'Reload in safe mode (rendering paused)', click: () => reloadSafe(win) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    phoneMenu(),
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(mac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
    {
      role: 'help',
      submenu: [
        link('Documentation', `${HOMEPAGE}#readme`),
        link('Report an issue', `${HOMEPAGE}/issues`),
        link('Source code (MIT)', HOMEPAGE),
        link('Support on Ko-fi', KOFI),
        ...(mac ? [] : [{ type: 'separator' }, { label: 'About RSMPS', click: showAbout }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- smoke test ----------------------------------------------------------------------------------------------------

/** Loads the app, waits for the UI to leave the boot screen, checks WebGPU, prints a JSON result, exits 0 or 1. */
async function runSmokeTest(w, phoneMod) {
  const timeoutMs = Number(option('smoke-timeout')) || (smokePhone ? 120000 : 60000);
  const out = option('smoke-out') ?? join(tmpdir(), 'rsmps-smoke.json');
  const started = Date.now();
  const result = { ok: false, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch, packaged: app.isPackaged, origin: appOrigin, consoleErrors: [] };
  w.webContents.on('console-message', (e) => {
    if ((e.level === 'error' || e.level === 3) && result.consoleErrors.length < 10) result.consoleErrors.push(String(e.message).slice(0, 300));
  });
  w.webContents.on('render-process-gone', (_e, d) => {
    result.error = `renderer gone: ${d.reason}`;
  });
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    result.ok = code === 0;
    result.ms = Date.now() - started;
    const json = JSON.stringify(result, null, 2);
    try {
      writeFileSync(out, json);
    } catch {
      /* stdout still has it */
    }
    process.stdout.write(json + '\n', () => app.exit(code));
  };
  const timer = setTimeout(() => {
    result.error ??= `timeout after ${timeoutMs} ms`;
    finish(1);
  }, timeoutMs);
  try {
    // Ready = React rendered something other than the boot screen. Error = the boot screen's error state.
    const probe = `(() => { const r = document.getElementById('root'); if (!r || !r.firstElementChild) return 'loading';
      if (r.querySelector('.rs-boot--error')) return 'error:' + (r.querySelector('.rs-boot__msg')?.textContent || '');
      return r.querySelector('.rs-boot') ? 'booting' : 'ready'; })()`;
    let state = 'loading';
    while (Date.now() - started < timeoutMs) {
      if (w.isDestroyed() || result.error) break;
      state = await w.webContents.executeJavaScript(probe).catch(() => 'loading');
      if (state === 'ready' || state.startsWith('error:')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    result.uiState = state;
    result.webgpu = await w.webContents.executeJavaScript(`(async () => {
      if (!navigator.gpu) return { available: false };
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { available: true, adapter: false };
      const i = a.info || {};
      return { available: true, adapter: true, vendor: i.vendor, architecture: i.architecture, description: i.description, features: a.features.size };
    })()`);
    if (smokePhone && state === 'ready' && result.webgpu.adapter) {
      if (!phone || !phoneMod) result.error ??= 'phone service not loaded';
      else {
        const evalInPage = (js) => w.webContents.executeJavaScript(js);
        const pre = await evalInPage("fetch('app://rsmps/__rsmps/lan-info').then((r) => r.json())");
        const get405 = await evalInPage("fetch('app://rsmps/__rsmps/lan-start').then((r) => r.status)");
        result.phoneChecks = []; result.phone = await phoneMod.runPhoneSmoke(phone, { sink: result.phoneChecks, userData: app.getPath('userData'), appOrigin: ORIGIN, evalInPage });
        result.phone.checks.unshift(
          { name: 'renderer lan-info says off + desktop', ok: pre.desktop === true && pre.state === 'off' && pre.lan === false && /^wss:\/\/127\.0\.0\.1:\d+$/.test(pre.ws), detail: { state: pre.state, ws: pre.ws, origins: pre.origins.length } },
          { name: 'GET lan-start is refused (405)', ok: get405 === 405 },
        );
        const started = await evalInPage("fetch('app://rsmps/__rsmps/lan-start', { method: 'POST' }).then((r) => r.json())");
        const on = await evalInPage("fetch('app://rsmps/__rsmps/lan-info').then((r) => r.json())");
        const stopped = await evalInPage("fetch('app://rsmps/__rsmps/lan-stop', { method: 'POST' }).then((r) => r.json())");
        result.phone.checks.push(
          { name: 'renderer POST lan-start turns it on', ok: started.state === 'on' && on.state === 'on' && on.lan === true && on.origins.every((o) => o.startsWith('https://')), detail: { origins: on.origins.length } },
          { name: 'renderer POST lan-stop turns it off', ok: stopped.state === 'off' },
        );
        result.phone.failed = result.phone.checks.filter((c) => !c.ok).map((c) => c.name);
        result.phone.ok = result.phone.failed.length === 0;
        if (!result.phone.ok) result.error ??= 'phone smoke failed: ' + result.phone.failed.join(', ');
      }
    }
    if (smokeAddons && state === 'ready') {
      if (!addons) result.error ??= 'add-ons not loaded';
      else {
        result.addonChecks = [];
        const badDir = join(app.getPath('userData'), 'bad');
        result.addons = await addons.mod.runAddonSmoke(addons.mgr, {
          sink: result.addonChecks,
          evalInPage: (js) => w.webContents.executeJavaScript(js),
          ffmpegPath: smokeFfmpeg,
          userData: app.getPath('userData'),
          makeBadManager: () => addons.mod.createAddonManager({ userData: badDir, catalogue: addons.badCatalogue, platformKey: addons.platformKey, allowLocalHttp: true, detectSystem: false }),
        });
        addons.prep?.close();
        addons.bad?.close();
        if (!result.addons.ok) result.error ??= 'addon smoke failed: ' + result.addons.failed.join(', ');
      }
    }
    if (state !== 'ready') result.error ??= `UI did not become ready (${state})`;
    else if (!result.webgpu.adapter) result.error ??= 'navigator.gpu returned no adapter';
  } catch (err) {
    result.error ??= String(err);
  }
  clearTimeout(timer);
  finish(result.error ? 1 : 0);
}

// ---- lifecycle ------------------------------------------------------------------------------------------------------

if (gotLock) {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', () => {
    void phone?.stop();
    void addons?.exporter.disposeAll();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // No top-level await on whenReady(): in an ES module main, Electron emits `ready` only after the module has loaded.
  void app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'RSMPS', applicationVersion: app.getVersion(), copyright: 'MIT licence', website: HOMEPAGE });
    const phoneMod = devUrl ? null : await loadPhone();
    if (smokePhone && phone) phone.setSettings({ consent: 'allow' });
    if (!devUrl) await loadAddons();
    if (!devUrl) registerAppProtocol();
    installSessionPolicies(session.defaultSession);
    buildMenu();
    const w = createWindow();
    if (smoke) void runSmokeTest(w, phoneMod);
    else void processAddonRequests();
  });
}
