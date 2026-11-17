// Regenerates the UI screenshots in docs/screenshots/.
//
//   VITE_RSMPS_QA=1 npx vite build --outDir <dir> --emptyOutDir      (a build that exposes window.__rsmpsIo / window.__rsmps: no dev server needed)
//   npx electron scripts/screenshots/capture.mjs --dist <dir>        (all scenes)
//   npx electron scripts/screenshots/capture.mjs --dist <dir> --only hero,audio
//   npx electron scripts/screenshots/capture.mjs --url http://localhost:5173 --out docs/screenshots     (a running dev server instead of --dist)
//
// With --dist the built folder is served from a throw-away static server on a random port. It opens the app in a hidden Electron window (1600x1000, scale factor 1) that uses its own in-memory session
// partition, so your browser's saved projects and library are never touched and nothing built here leaks into your app.
// Every scene builds a demo graph with the engine's own helpers (src/engine/graph.ts), stores it as a project, reloads
// the page so the real UI shows it, and saves the window as a PNG. Test media comes from test-assets/ (read in this
// process and handed to the page as bytes), plus generated content. Nothing under tmp/ is ever used.
//
// SCENES (id -> file). Their definitions are in scenes.mjs.
//   hero       01-hero.png       pixel-art pipeline: Media In > Pixelate > Dither (Palette) > CRT Display > Output
//   generate   02-generate.png   two 3D objects with their own cameras over a gradient, keyframes + curve editor
//   audio      03-audio.png      synth chain, Timeline panel, Sound to Numbers driving a picture
//   track      04-track.png      detect blobs > track > regions to mask feeding an effect, region overlay
//   addmenu    05-add-menu.png   the add-node menu with its categories
//   palette    06-palette.png    Palette Studio
//   scan       07-scan.png       Scan tab, stage 2, from pages exported by the app's own exporter
import electron from 'electron';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ELECTRON_RUN_AS_NODE (set by some shells and agent hosts) makes Electron behave as plain node: 'electron' is then just a path and
// nothing opens, so the script silently does nothing. Start the real Electron again without it.
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
const DIST = arg('dist', '') ? resolve(root, arg('dist', '')) : null;
let URL_ = arg('url', 'http://localhost:5173');
const OUT = resolve(root, arg('out', 'docs/screenshots'));
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const W = 1600, H = 1000;

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.map': 'application/json', '.onnx': 'application/octet-stream' };
function serve(dist) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(dist, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file)); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PARTITION = 'rsmps-screenshots'; // no "persist:" prefix: memory only

let win;
const js = (code) => win.webContents.executeJavaScript(code, true);

/** What scene files get: helpers to drive the page. */
const kit = {
  get win() { return win; },
  js,
  sleep,
  out: OUT,
  root,
  async waitFor(expr, timeout = 30000, what = expr) {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await js(expr); } catch { /* page reloading */ }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + what);
      await sleep(150);
    }
  },
  async load() {
    await win.loadURL(URL_ + '/');
    await kit.waitFor('!!window.__rsmpsIo && !!window.__rsmps', 60000, '__rsmpsIo (build with VITE_RSMPS_QA=1 or use the dev server)');
  },
  /** Add a file from test-assets/ (or generated bytes) to the page's library; returns the asset id. */
  async importFile(rel, mime) {
    return kit.importBytes(rel.split('/').pop(), mime, readFileSync(join(root, rel)));
  },
  async importBytes(name, mime, buf) {
    const b64 = Buffer.from(buf).toString('base64');
    return js(`(async()=>{const b=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
      const f=new File([b],${JSON.stringify(name)},{type:${JSON.stringify(mime)}});
      const a=await window.__rsmpsIo.library.add([f]);return a[0].id;})()`);
  },
  /** Build a graph from a spec in the page, store it as the one open project and reload so the UI shows it. */
  async openGraph(spec, assetIds = {}) {
    await js(`(async()=>{
      const io=window.__rsmpsIo;
      const G=window.__rsmps.graph;
      const spec=${JSON.stringify(spec)}; const assets=${JSON.stringify(assetIds)};
      let g=G.createGraph(spec.name);
      if(spec.project) g={...g,project:{...g.project,...spec.project}};
      const ids={};
      for(const [key,n] of Object.entries(spec.nodes)){
        const params={...(n.params||{})};
        for(const [k,v] of Object.entries(params)) if(typeof v==='string'&&v.startsWith('@asset:')) params[k]=[assets[v.slice(7)]];
        const r=G.addNode(g,io.registry,n.type,{x:n.at[0],y:n.at[1]},params); g=r.graph; ids[key]=r.node.id;
        if(n.label) g={...g,nodes:g.nodes.map(x=>x.id===r.node.id?{...x,label:n.label}:x)};
        if(n.collapsed) g={...g,nodes:g.nodes.map(x=>x.id===r.node.id?{...x,collapsed:true}:x)};
      }
      for(const [a,b] of spec.edges){
        const [fa,fp]=a.split('.'); const [ta,tp]=b.split('.');
        g=G.connect(g,io.registry,{node:ids[fa],port:fp},{node:ids[ta],port:tp});
      }
      const bad=G.validateGraph(g,io.registry); if(bad.length) throw new Error(JSON.stringify(bad));
      const open=await io.projects.listOpen();
      const p=await io.projects.createProject(g,spec.name);
      for(const o of open) await io.projects.closeProject(o.id);
      await io.projects.setActive(p.id);
      await io.projects.saveProject(p.id,g); await io.projects.flush();
      try{localStorage.setItem('rsmps.ui.zoomHint','9');localStorage.setItem('rsmps.ui.prefs',JSON.stringify({leftOpen:true,rightOpen:true,split:0.46,debug:false,...(spec.ui||{})}))}catch{}; window.__shotIds=ids; localStorage.setItem('shotIds',JSON.stringify(ids));
    })()`);
    await win.webContents.reload();
    await kit.waitFor('!!window.__rsmpsIo', 60000, '__rsmpsIo after reload');
    await kit.waitFor(`document.querySelectorAll('[data-node-id]').length>=${Object.keys(spec.nodes).length}`, 30000, 'nodes drawn');
    const ids = await js(`JSON.parse(localStorage.getItem('shotIds'))`);
    return ids;
  },
  /** Real input events: mouse and keys reach the page like a user's. */
  move(x, y) { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); },
  async click(x, y, opts = {}) {
    kit.move(x, y); await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: opts.count ?? 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: opts.count ?? 1 });
    await sleep(120);
  },
  async key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(150);
  },
  /** Centre of a DOM element (CSS px = window px here). */
  async centerOf(selector) {
    const r = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
    if (!r) throw new Error('no element ' + selector);
    return r;
  },
  async clickSel(selector, opts) { const [x, y] = await kit.centerOf(selector); await kit.click(Math.round(x), Math.round(y), opts); },
  /** Click a button/menu item by its visible text. */
  async clickText(text, scope = 'button,[role=menuitem],[role=tab],a', opts) {
    const p = await js(`(()=>{const q=${JSON.stringify(text)};const e=[...document.querySelectorAll(${JSON.stringify(scope)})].find(x=>x.textContent.trim()===q||(${JSON.stringify(!!(opts&&opts.includes))}&&x.textContent.includes(q))||x.getAttribute('aria-label')===q||x.title===q);if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
    if (!p) throw new Error('no control "' + text + '"');
    await kit.click(Math.round(p[0]), Math.round(p[1]));
  },
  /** Select a node by clicking its header. */
  async selectNode(id) {
    const [x, y] = await kit.centerOf(`[data-node-id="${id}"] [data-node-head]`);
    await kit.click(Math.round(x - 20), Math.round(y));
  },
  /** Frame the whole graph (the F shortcut with the pointer over the graph). */
  async frameAll() {
    const [x, y] = await kit.graphPoint();
    kit.move(x, y); await sleep(80);
    await kit.key('F');
    await sleep(500);
  },
  async graphPoint() {
    const r = await js(`(()=>{const e=document.querySelector('.rs-graph')||document.querySelector('[data-graph]');if(!e)return null;const b=e.getBoundingClientRect();return [b.x+b.width-60,b.y+b.height-40]})()`);
    return r ?? [800, 800];
  },
  /** Wait until the player has drawn without errors and nothing changed for a while. */
  async settle(ms = 1200) {
    try {
      await kit.waitFor(`(()=>{const s=window.__rsmpsIo.player.getState();return s.imageSize&&s.errors.size===0})()`, 40000, 'player image');
    } catch (e) {
      throw new Error(e.message + ' errors=' + JSON.stringify(await kit.errors()));
    }
    await sleep(ms);
  },
  async errors() {
    return js(`[...window.__rsmpsIo.player.getState().errors.entries()]`);
  },
  /** Type text into the focused field. */
  async type(text) { win.webContents.insertText(text); await sleep(150); },
  /** The window as a PNG buffer (what shot() writes), without writing a file. */
  async capture() {
    win.webContents.invalidate();
    await sleep(900);
    win.webContents.invalidate();
    await sleep(400);
    return (await win.webContents.capturePage()).toPNG();
  },
  /**
   * The app in a second, phone-sized window (touch emulation, 390x844 at 2x, Android Chrome user agent) that shares the session of the main
   * window, so it opens the project the scene stored. `tab` = 1 View, 2 Graph, 3 Inspector, 4 Media. Returns a PNG buffer.
   */
  async phone(tab = 1) {
    // The main window itself is switched to a phone (a second window would start in safe mode: the first one has not shut down cleanly).
    const w = win;
    const dbg = w.webContents.debugger;
    dbg.attach('1.3');
    const cdp = (m, prm = {}) => dbg.sendCommand(m, prm);
    const wjs = (code) => w.webContents.executeJavaScript(code, true);
    try {
      await js('window.__rsmpsIo.projects.flush && window.__rsmpsIo.projects.flush()').catch(() => undefined);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
      await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5, configuration: 'mobile' });
      await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Android' });
      await w.webContents.reload();
      await kit.waitFor("!!document.querySelector('.rs-pshell') && !!window.__rsmpsIo", 60000, 'phone shell');
      await sleep(1500);
      await kit.waitFor("document.querySelectorAll('[data-node-id]').length > 0 || true", 5000).catch(() => undefined);
      await wjs(`(() => { const ed = window.__rsmps?.ed; if (!ed) return; const o = ed.state.graph.nodes.find((n) => n.type === 'image-out'); if (o) ed.setViewed(o.id); })()`).catch(() => undefined);
      w.webContents.invalidate();
      await w.webContents.capturePage();
      await wjs(`document.querySelector('.rs-tabbar__btn:nth-child(${tab})')?.click()`);
      await wjs('window.__rsmpsIo.player.seek(0.5)').catch(() => undefined);
      await sleep(4000);
      if (process.env.SHOT_LOG) console.log('  [phone]', await wjs(`JSON.stringify({ viewed: window.__rsmps?.ed.state.viewedNodeId, size: window.__rsmpsIo?.player.getState().imageSize, err: [...(window.__rsmpsIo?.player.getState().errors ?? [])], banner: document.body.innerText.slice(0, 200) })`));
      w.webContents.invalidate();
      await sleep(500);
      w.webContents.invalidate();
      return (await w.webContents.capturePage()).toPNG();
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => undefined);
      await cdp('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => undefined);
      dbg.detach();
    }
  },
  async shot(file) {
    mkdirSync(OUT, { recursive: true });
    win.webContents.invalidate();
    await sleep(900);
    win.webContents.invalidate();
    await sleep(400);
    const bad = await js(`(()=>{const o=[];for(const e of document.querySelectorAll('.rs-toast, [role=alert], .rs-node__err'))o.push(e.textContent.trim().slice(0,120)||e.getAttribute('title')||e.className);for(const [id,m] of window.__rsmpsIo.player.getState().errors)o.push(id+': '+m);return o})()`);
    if (bad.length) console.warn('  WARNING: problems on screen: ' + JSON.stringify(bad));
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    if (size.width !== W || size.height !== H) console.warn(`  note: captured ${size.width}x${size.height}`);
    const png = img.toPNG();
    writeFileSync(join(OUT, file), png);
    console.log(`  wrote ${file} (${Math.round(png.length / 1024)} KB)`);
  },
};

async function main() {
  let staticServer = null;
  if (DIST) { const { server, port } = await serve(DIST); staticServer = server; URL_ = 'http://127.0.0.1:' + port; }
  const { scenes } = await import(pathToFileURL(join(here, 'scenes.mjs')).href);
  const ses = session.fromPartition(PARTITION);
  win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    resizable: false,
    backgroundColor: '#101114',
    webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.setContentSize(W, H);
  win.webContents.on('console-message', (e) => { if (process.env.SHOT_LOG) console.log('  [page]', e.message ?? e); });
  let failed = 0;
  for (const s of scenes) {
    if (ONLY && !ONLY.includes(s.id)) continue;
    console.log(`scene ${s.id}`);
    try {
      await ses.clearStorageData();
      await kit.load();
      await s.run(kit);
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${err.stack || err}`);
    }
  }
  await ses.clearStorageData();
  await ses.clearCache();
  win.destroy();
  staticServer?.close();
  app.exit(failed ? 1 : 0);
}

app.on('window-all-closed', () => undefined);
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
