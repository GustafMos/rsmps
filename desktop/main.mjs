// RSMPS desktop shell (Electron main process).
//
// Loads the production web build from the app bundle through a private `app://rsmps/` protocol, so the existing
// `base: './'` build, ES module workers, AudioWorklets and `import.meta` URLs behave exactly as on the web.
// Everything runs offline; there is no server. Security: sandboxed renderer, context isolation, no Node in the page,
// no preload script, strict navigation and permission policies. See docs/STORE.md and docs/RELEASING.md.
import { app, BrowserWindow, Menu, net, protocol, screen, session, shell, dialog } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEME = 'app';
const HOST = 'rsmps';
const ORIGIN = `${SCHEME}://${HOST}`;
const HOMEPAGE = 'https://github.com/GustafMos/rsmps';
const KOFI = 'https://ko-fi.com/ripscorpy';

const argv = process.argv.slice(1);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const smoke = flag('smoke-test');
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
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: http: https:",
  "media-src 'self' blob: data: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: http: https:",
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
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
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
  return win;
}

// ---- menu and About ------------------------------------------------------------------------------------------------

function showAbout() {
  const detail = [
    `Version ${app.getVersion()}`,
    'Licence: MIT. The source is free; this build is a convenience package of it.',
    `Source: ${HOMEPAGE}`,
    '',
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
    'Third-party licences: THIRD_PARTY_LICENSES.txt in the application resources folder.',
  ].join('\n');
  const opts = { type: 'info', title: 'About RSMPS', message: 'RipScorpy Media Processing Suite (RSMPS)', detail, buttons: ['OK', 'Source code', 'Support on Ko-fi'], defaultId: 0, cancelId: 0, noLink: true };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => {
    if (r.response === 1) openExternalSafe(HOMEPAGE);
    if (r.response === 2) openExternalSafe(KOFI);
  });
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
async function runSmokeTest(w) {
  const timeoutMs = Number(option('smoke-timeout')) || 60000;
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
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // No top-level await on whenReady(): in an ES module main, Electron emits `ready` only after the module has loaded.
  void app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: 'RSMPS', applicationVersion: app.getVersion(), copyright: 'MIT licence', website: HOMEPAGE });
    if (!devUrl) registerAppProtocol();
    installSessionPolicies(session.defaultSession);
    buildMenu();
    const w = createWindow();
    if (smoke) void runSmokeTest(w);
  });
}
