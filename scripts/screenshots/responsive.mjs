// Responsive layout check: serves the BUILT app (dist/ or --dist <dir>) from a throw-away static server on a random port,
// opens it in hidden Electron windows at phone / landscape / tablet / desktop sizes (CDP device emulation: device scale factor,
// touch events, coarse pointer), walks through the main states, saves PNGs and prints layout measurements for every state:
// horizontal overflow, tap targets under 40 px, text under 12 px.
//
//   npm run build            (or: npx vite build --outDir <dir> --emptyOutDir  and pass --dist <dir>)
//   npx electron scripts/screenshots/responsive.mjs [--dist dist] [--label after] [--only phone,desktop] [--out <dir>] [--scenes <file.mjs>]
//   (--scenes runs another scene file, for example qa-scenes.mjs; its PNGs then default to <preview dir>/qa/)
//
// Nothing is kept: the server is closed and the windows use an in-memory session. Screenshots go to
// <RSMPS_PREVIEW_DIR or the OS temp folder>/rsmps-previews/responsive/<label>/ (same place as the other preview PNGs).
// ELECTRON_RUN_AS_NODE must not be set in the shell.
import electron from 'electron';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ELECTRON_RUN_AS_NODE makes Electron behave as plain node ('electron' is then just a path): start the real Electron again without it.
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const { app, BrowserWindow, session } = electron;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(1);
const arg = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const DIST = resolve(root, arg('dist', 'dist'));
const LABEL = arg('label', 'after');
const SCENES_FILE = arg('scenes', process.env.RESP_SCENES ?? ''); // --scenes <file.mjs>: another scene file (for example qa-scenes.mjs); it must export `scenes`
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const PNG_DIR = (process.env.RSMPS_PREVIEW_DIR ?? join(tmpdir(), 'rsmps-previews')).split('\\').join('/');
const OUT = resolve(arg('out', SCENES_FILE ? join(PNG_DIR, 'qa') : join(PNG_DIR, 'responsive', LABEL)));

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.map': 'application/json', '.onnx': 'application/octet-stream' };

function serve() {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(DIST, path === '/' ? 'index.html' : path);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); const buf = readFileSync(file); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(buf); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

/** Measurements run inside the page. Returns a plain object. */
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && !e.closest('[aria-hidden="true"]') && !e.closest('[inert]'); };
  const label = (e) => (e.getAttribute('aria-label') || e.title || e.textContent || e.className || e.tagName).toString().trim().replace(/\\s+/g, ' ').slice(0, 40);
  const small = [];
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, [role=switch], [role=spinbutton], summary')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) small.push({ w: Math.round(r.width), h: Math.round(r.height), at: Math.round(r.left) + ',' + Math.round(r.top), what: e.tagName.toLowerCase() + ' ' + label(e) });
  }
  const tiny = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const p = n.parentElement; if (!p || !vis(p)) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    if (fs > 0 && fs < 12) { const k = fs + 'px ' + p.className.toString().slice(0, 40); tiny.set(k, (tiny.get(k) || 0) + 1); }
  }
  return { sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth, ih: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, small, tiny: [...tiny].map(([k, v]) => k + ' x' + v) };
})()`;

async function main() {
  console.log('main start', OUT);
  mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const scenes = (await import(SCENES_FILE ? pathToFileURL(resolve(root, SCENES_FILE)).href : new URL('./responsive-scenes.mjs', import.meta.url).href)).scenes;
  const report = [];
  try {
    for (const scene of scenes) {
      if (ONLY && !ONLY.includes(scene.id)) continue;
      const win = new BrowserWindow({ show: false, width: scene.w, height: scene.h, useContentSize: true, backgroundColor: '#101114', webPreferences: { partition: `rsmps-resp-${scene.id}-${Date.now()}`, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
      win.setContentSize(scene.w, scene.h);
      console.log('window', scene.id);
      for (let attempt = 0; ; attempt++) {
        try { await win.loadURL('about:blank'); break; } catch (e) { if (attempt > 4) throw e; await sleep(400); }
      }
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      const cdp = (m, p = {}) => { if (process.env.RESP_LOG) console.log('cdp', m); return dbg.sendCommand(m, p); };
      if (scene.touch || scene.dsf) {
        await cdp('Emulation.setDeviceMetricsOverride', { width: scene.w, height: scene.h, deviceScaleFactor: scene.dsf ?? 1, mobile: !!scene.touch, screenOrientation: scene.w > scene.h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
      }
      if (scene.touch) await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5, configuration: 'mobile' });
      if (scene.ua) await cdp('Emulation.setUserAgentOverride', { userAgent: scene.ua, platform: scene.platform ?? '' });
      if (scene.initScript) await cdp('Page.enable');
      if (scene.initScript) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: scene.initScript });
      const logs = [];
      win.webContents.on('console-message', (e) => { const m = e.message ?? ''; if ((e.level === 'error' || e.level === 3) && logs.length < 8) logs.push(m.slice(0, 200)); });
      const k = {
        win, cdp, base, sleep,
        js: (code) => win.webContents.executeJavaScript(code, true),
        // A hidden window only routes real touch taps once something has been captured from it: warm it up after every load.
        async load(path = '/index.html') { await win.loadURL(base + path); await sleep(300); win.webContents.invalidate(); await win.webContents.capturePage(); },
        async waitFor(expr, timeout = 30000, what = expr) {
          const t0 = Date.now();
          for (;;) { let v = false; try { v = await k.js(expr); } catch { /* reloading */ } if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + what); await sleep(150); }
        },
        /** Real touch tap at CSS px. */
        async frame() { win.webContents.invalidate(); await win.webContents.capturePage(); },
        async tap(x, y, hold = 40) {
          await k.frame(); // a hidden window commits no frames by itself: without one the touch-action regions are stale and taps are dropped
          await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
          await sleep(hold);
          await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(180);
        },
        async doubleTap(x, y) {
          await k.frame();
          for (let i = 0; i < 2; i++) {
            await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
            await sleep(30);
            await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(70);
          }
          await sleep(200);
        },
        async drag(x0, y0, x1, y1, steps = 8) {
          await k.frame();
          await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
          for (let i = 1; i <= steps; i++) { await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 1 }] }); await sleep(16); }
          await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(200);
        },
        async centerOf(sel) { const r = await k.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`); if (!r) throw new Error('no element ' + sel); return r; },
        async tapSel(sel, hold) { const [x, y] = await k.centerOf(sel); await k.tap(Math.round(x), Math.round(y), hold); },
        async clickSel(sel) { await k.js(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(250); },
        async exists(sel) { return k.js(`!!document.querySelector(${JSON.stringify(sel)})`); },
        async shot(name) {
          await sleep(500);
          win.webContents.invalidate(); await sleep(300);
          const img = await win.webContents.capturePage();
          const sz = img.getSize();
          const file = `${scene.id}-${name}.png`;
          writeFileSync(join(OUT, file), img.toPNG());
          const m = await k.js(MEASURE);
          report.push({ scene: scene.id, state: name, file, shot: sz.width + 'x' + sz.height, ...m });
          console.log(`${scene.id}/${name}: ${file}  scroll ${m.sw}/${m.iw}${m.overflowX ? '  OVERFLOW-X' : ''}  small-targets ${m.small.length}  tiny-text ${m.tiny.length}`);
        },
        async text() { return k.js('document.body.innerText'); },
      };
      try { await scene.run(k); }
      catch (e) { console.log(`${scene.id}: FAILED ${e.message}`); report.push({ scene: scene.id, state: 'FAILED', error: e.message }); try { await k.shot('failed'); } catch { /* ignore */ } }
      if (logs.length) console.log(`${scene.id}: console errors:`, logs);
      dbg.detach();
      win.destroy();
      await sleep(600);
    }
  } finally {
    server.close();
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  }
  console.log('report: ' + join(OUT, 'report.json'));
  app.quit();
}

app.on('window-all-closed', () => undefined); // the scenes close their window one after the other: do not quit in between
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
void session;
