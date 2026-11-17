// QA scenes for responsive.mjs: walk through the newer features of the desktop layout, capture every state and measure it.
//
//   VITE_RSMPS_QA=1 npx vite build --outDir <dir> --emptyOutDir          (the build exposes window.__rsmps, the editor handle these scenes use)
//   npx electron scripts/screenshots/responsive.mjs --dist <dir> --scenes scripts/screenshots/qa-scenes.mjs [--only a-start,d-nodes]
//
// PNGs go to <OS temp>/rsmps-previews/qa/ (RSMPS_PREVIEW_DIR overrides the temp folder) next to qa-report.json, which holds for every state:
// console errors, the error boundary, clipped / ellipsised text, overlapping siblings in flex rows, children cut off by a clipping parent,
// controls outside the window and the engine's per-node errors. Graphs are built from generators and scripts/screenshots/assets/base-scene.png.
// Input is mostly DOM clicks and the editor store (a hidden window does not route real mouse events reliably until a frame was captured).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCENE_PNG = resolve(here, 'assets', 'base-scene.png');
const PNG_DIR = (process.env.RSMPS_PREVIEW_DIR ?? join(tmpdir(), 'rsmps-previews')).split('\\').join('/');
const QA_DIR = join(PNG_DIR, 'qa');
const records = [];

/* ----------------------------- generated media (no private files) ----------------------------- */

function drumLoopWav() {
  const sr = 22050, secs = 2, n = sr * secs, pcm = new Int16Array(n);
  for (let beat = 0; beat < 4; beat++) for (let i = 0; i < sr * 0.2; i++) { const t = i / sr; pcm[Math.floor(beat * 0.5 * sr) + i] += Math.sin(2 * Math.PI * (45 + 130 * Math.exp(-t * 14)) * t) * Math.exp(-t * 9) * 20000; }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}
const SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello from RSMPS\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line of subtitles\n';
function cube() {
  const n = 5, rows = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push([r / (n - 1), g / (n - 1) * 0.9, b / (n - 1) * 0.8].map((v) => v.toFixed(4)).join(' '));
  return `TITLE "QA warm"\nLUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}

/* ------------------------------------ page-side helpers ------------------------------------ */

const QA_LIB = `(() => {
  const H = () => window.__rsmps;
  const qa = (window.__qa = {
    assets: {},
    async addFile(key, name, mime, b64) {
      const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const a = await H().io.library.add([new File([b], name, { type: mime })]);
      qa.assets[key] = a[0].id;
      return a[0].id;
    },
    /** spec = { name, project?, nodes: {key: {type, at, params, label, collapsed}}, edges: [['a.port','b.port']], media? } -> ids */
    build(spec) {
      const { io, ed, graph: G } = H();
      let g = G.createGraph(spec.name || 'QA');
      if (spec.project) g = { ...g, project: { ...g.project, ...spec.project } };
      const ids = {};
      const errs = [];
      for (const [key, n] of Object.entries(spec.nodes)) {
        const params = { ...(n.params || {}) };
        for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v.startsWith('@asset:')) params[k] = [qa.assets[v.slice(7)]];
        const r = G.addNode(g, io.registry, n.type, { x: n.at[0], y: n.at[1] }, params);
        g = r.graph; ids[key] = r.node.id;
        if (n.label) g = { ...g, nodes: g.nodes.map((x) => (x.id === r.node.id ? { ...x, label: n.label } : x)) };
        if (n.collapsed) g = { ...g, nodes: g.nodes.map((x) => (x.id === r.node.id ? { ...x, collapsed: true } : x)) };
      }
      for (const [a, b] of spec.edges || []) {
        const [fa, fp] = a.split('.'); const [ta, tp] = b.split('.');
        try { g = G.connect(g, io.registry, { node: ids[fa], port: fp }, { node: ids[ta], port: tp }); } catch (e) { errs.push(a + ' -> ' + b + ': ' + e.message); }
      }
      if (spec.media) g = { ...g, media: spec.media(qa.assets, ids) };
      ed.loadGraph(g);
      qa.ids = ids; qa.buildErrors = errs;
      return { ids, errs };
    },
    /** One node of a type with a source picture and an output, wired where the types fit. */
    single(type, params, extra) {
      const { io } = H();
      const def = io.registry.get(type);
      if (!def) throw new Error('unknown node type ' + type);
      const nodes = { n: { type, at: [330, 60], params: params || {} } };
      const edges = [];
      const imgIn = Object.entries(def.inputs || {}).find(([, v]) => v.type === 'image');
      if (imgIn) { nodes.src = { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }; edges.push(['src.image', 'n.' + imgIn[0]]); }
      const imgOut = Object.entries(def.outputs || {}).find(([, v]) => v.type === 'image');
      if (imgOut) { nodes.out = { type: 'image-out', at: [760, 60] }; edges.push(['n.' + imgOut[0], 'out.image']); }
      const r = qa.build({ name: def.title, nodes, edges, ...(extra || {}) });
      H().ed.select([r.ids.n]);
      return r;
    },
    async settle(ms = 4000) {
      const t0 = Date.now();
      const io = window.__rsmpsIo;
      while (Date.now() - t0 < ms) {
        const s = io.player.getState();
        if (s.imageSize && s.errors.size === 0) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 500));
      return [...io.player.getState().errors.entries()].map(([id, m]) => String(m).slice(0, 160));
    },
    click(sel, text, exact) {
      const els = [...document.querySelectorAll(sel)];
      const t = text.toLowerCase();
      const e = els.find((x) => { const v = (x.textContent || '').trim().replace(/\\s+/g, ' ').toLowerCase(); const l = (x.getAttribute('aria-label') || x.title || '').toLowerCase(); return exact === false ? v.includes(t) || l.includes(t) : v === t || l === t; });
      if (!e) return false;
      e.click();
      return true;
    },
    ctx(el, x, y) { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })); },
    setText(sel, value) {
      const el = document.querySelector(sel);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      el.focus(); set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    esc() { for (const t of [document.activeElement, document]) t && t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); },
  });
})()`;

/** Everything checked for each captured state. Runs in the page. */
const MEASURE_QA = `(() => {
  const out = { boundary: !!document.querySelector('.rs-boot--error'), clipped: [], overlaps: [], cutoff: [], outside: [], engine: [], leaks: [] };
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0 && !e.closest('[aria-hidden="true"]') && !e.closest('[inert]'); };
  const desc = (e) => { const c = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''; return e.tagName.toLowerCase() + (c ? '.' + c : '') + ' "' + ((e.textContent || '') || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40) + '"'; };
  const seen = new Set();
  const add = (list, key, v) => { if (seen.has(key) || list.length >= 30) return; seen.add(key); list.push(v); };
  // 1. clipped / ellipsised text: leaf text elements, buttons, labels
  for (const e of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'OPTION', 'CANVAS', 'IMG', 'INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName.toUpperCase())) continue;
    const leaf = e.children.length === 0 || ['BUTTON', 'LABEL', 'A', 'SUMMARY'].includes(e.tagName) || getComputedStyle(e).textOverflow === 'ellipsis';
    if (!leaf || !(e.textContent || '').trim() || e.scrollWidth <= e.clientWidth + 1 || !vis(e)) continue;
    const s = getComputedStyle(e);
    if (s.overflowX === 'visible' && s.textOverflow !== 'ellipsis') continue;
    if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
    add(out.clipped, 'c' + desc(e), { el: desc(e), sw: e.scrollWidth, cw: e.clientWidth, ellipsis: s.textOverflow === 'ellipsis', title: !!e.closest('[title]') });
  }
  // 2. overlapping siblings inside flex / grid rows
  for (const p of document.querySelectorAll('body *')) {
    if (p.children.length < 2 || p.children.length > 40 || !vis(p)) continue;
    const d = getComputedStyle(p).display;
    if (d !== 'flex' && d !== 'inline-flex' && d !== 'grid') continue;
    const kids = [...p.children].filter((c) => { const s = getComputedStyle(c); return vis(c) && s.position !== 'absolute' && s.position !== 'fixed' && s.position !== 'sticky'; });
    const rs = kids.map((c) => c.getBoundingClientRect());
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const ix = Math.min(rs[i].right, rs[j].right) - Math.max(rs[i].left, rs[j].left);
      const iy = Math.min(rs[i].bottom, rs[j].bottom) - Math.max(rs[i].top, rs[j].top);
      if (ix > 2 && iy > 2) add(out.overlaps, 'o' + desc(kids[i]) + desc(kids[j]), { a: desc(kids[i]), b: desc(kids[j]), in: desc(p).slice(0, 50), px: Math.round(ix) + 'x' + Math.round(iy) });
    }
  }
  // 3. children cut off by a parent that clips horizontally
  for (const e of document.querySelectorAll('body *')) {
    const p = e.parentElement;
    if (!p || p === document.body || !vis(e)) continue;
    const ps = getComputedStyle(p);
    if (ps.overflowX !== 'hidden' && ps.overflowX !== 'clip') continue;
    const s = getComputedStyle(e);
    if (s.position === 'absolute' || s.position === 'fixed') continue;
    const r = e.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if (pr.width > 0 && (r.right > pr.right + 2 || r.left < pr.left - 2) && ['BUTTON', 'INPUT', 'SELECT', 'LABEL', 'SPAN', 'A'].includes(e.tagName)) add(out.cutoff, 'x' + desc(e), { el: desc(e), in: desc(p).slice(0, 50), over: Math.round(Math.max(r.right - pr.right, pr.left - r.left)) });
  }
  // 4. controls outside the window (and not inside a scroller)
  for (const e of document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=button], [role=tab], [role=menuitem]')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1) continue;
    let inScroller = false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if ((s.overflowX !== 'visible' || s.overflowY !== 'visible')) { const ar = a.getBoundingClientRect(); if (ar.right <= innerWidth + 1 && ar.bottom <= innerHeight + 1) { inScroller = true; break; } } }
    if (!inScroller) add(out.outside, 'w' + desc(e), { el: desc(e), at: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) });
  }
  // 5. raw values leaking into the UI as text: null, undefined, NaN, [object Object] or a JSON object / array
  { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = (n.textContent || '').trim(); const p = n.parentElement;
      if (!t || !p || !vis(p) || ['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE'].includes(p.tagName) || p.closest('pre, code, textarea, .rs-mono')) continue;
      if (['null', 'undefined', 'NaN'].includes(t) || t.includes('[object Object]') || ((t[0] === '[' || t[0] === '{') && t.length > 2 && (t.endsWith(']') || t.endsWith('}')) && t.includes('"'))) add(out.leaks, 'l' + t.slice(0, 40), { text: t.slice(0, 60), in: desc(p).slice(0, 60) });
    } }
  for (const e of document.querySelectorAll('input:not([type=hidden]), textarea')) if (vis(e) && ['null', 'undefined', 'NaN', '[object Object]'].includes(e.value)) add(out.leaks, 'i' + desc(e), { text: 'field value: ' + e.value, in: desc(e).slice(0, 60) });
  try { for (const [id, m] of window.__rsmpsIo.player.getState().errors) out.engine.push(String(m).slice(0, 140)); } catch { /* no handle */ }
  out.inspectorScroll = (() => { const e = document.querySelector('.rs-inspector__body, .rs-inspector'); return e ? e.scrollHeight + '/' + e.clientHeight : null; })();
  return out;
})()`;

/* ------------------------------------ node-side helpers ------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeQa(k, sceneId) {
  const consoleErrors = [];
  k.win.webContents.on('console-message', (e) => { const lvl = e.level; const m = e.message ?? ''; if ((lvl === 'error' || lvl === 3) && consoleErrors.length < 12) consoleErrors.push(m.slice(0, 220)); });
  mkdirSync(QA_DIR, { recursive: true });
  const q = {
    consoleErrors,
    /** Capture + measure one state. */
    async shot(name, note) {
      await q.clean().catch(() => undefined);
      const engine = await k.js(`window.__qa ? window.__qa.settle(1500) : []`).catch(() => []);
      await k.shot(name);
      const m = await k.js(MEASURE_QA);
      const rec = { scene: sceneId, state: name, file: `${sceneId}-${name}.png`, note: note ?? null, consoleErrors: consoleErrors.splice(0), settleErrors: engine, ...m };
      records.push(rec);
      writeFileSync(join(QA_DIR, 'qa-report.json'), JSON.stringify(records, null, 1));
      const flags = [rec.boundary && 'BOUNDARY', rec.consoleErrors.length && `console x${rec.consoleErrors.length}`, rec.clipped.length && `clipped ${rec.clipped.length}`, rec.overlaps.length && `overlap ${rec.overlaps.length}`, rec.cutoff.length && `cutoff ${rec.cutoff.length}`, rec.outside.length && `outside ${rec.outside.length}`, rec.engine.length && `engine ${rec.engine.length}`, rec.leaks.length && `LEAK ${rec.leaks.length}`].filter(Boolean);
      console.log(`  QA ${name}${flags.length ? '  ' + flags.join(', ') : '  ok'}`);
      return rec;
    },
    /** A step that must not stop the scene when it fails: the failure is a finding. */
    async step(name, fn) {
      try { await fn(); }
      catch (e) {
        console.log(`  STEP FAILED ${name}: ${e.message}`);
        records.push({ scene: sceneId, state: name, failed: e.message });
        writeFileSync(join(QA_DIR, 'qa-report.json'), JSON.stringify(records, null, 1));
        try { await k.js(`window.__qa.esc()`); } catch { /* ignore */ }
      }
    },
    async boot(path = '/index.html') {
      await k.load(path);
      await k.waitFor(`!!document.querySelector('.rs-app') && !!window.__rsmps`, 60000, 'app shell');
      await k.js(QA_LIB);
      await k.js(`try { localStorage.setItem('rsmps.ui.zoomHint', '9'); } catch {}`);
      await sleep(600);
    },
    async media() {
      const png = readFileSync(SCENE_PNG).toString('base64');
      const add = (key, name, mime, buf) => k.js(`window.__qa.addFile(${JSON.stringify(key)}, ${JSON.stringify(name)}, ${JSON.stringify(mime)}, ${JSON.stringify(Buffer.from(buf).toString('base64'))})`);
      await add('scene', 'base-scene.png', 'image/png', Buffer.from(png, 'base64'));
      await add('scene2', 'room-night.png', 'image/png', Buffer.from(png, 'base64'));
      await add('scene3', 'room-day.png', 'image/png', Buffer.from(png, 'base64'));
      await add('wav', 'drum-loop.wav', 'audio/wav', drumLoopWav());
      await add('srt', 'captions.srt', 'application/x-subrip', Buffer.from(SRT));
      await add('lut', 'warm.cube', 'application/octet-stream', Buffer.from(cube()));
    },
    js: (code) => k.js(code),
    click: (sel, text, exact) => k.js(`window.__qa.click(${JSON.stringify(sel)}, ${JSON.stringify(text)}, ${exact === false ? 'false' : 'true'})`).then((ok) => { if (!ok) throw new Error(`no ${sel} "${text}"`); return ok; }),
    async menu(label, item) {
      await q.click('.rs-top button', label);
      await sleep(250);
      await q.click('.rs-menu__item, [role=menuitem]', item, false);
      await sleep(500);
    },
    esc: () => k.js(`window.__qa.esc()`),
    /** Drop toasts and the support prompt so they do not cover the state. */
    clean: () => k.js(`(() => { const ed = window.__rsmps.ed; ed.dismissSupport(); for (const t of ed.state.toasts) ed.dismissToast(t.id); })()`),
  };
  return q;
}

const W = { w: 1440, h: 900, dsf: 1 };

/* ------------------------------------------ scenes ------------------------------------------ */

export const scenes = [
  /* a. Start screen with templates, File > New from template */
  {
    id: 'a-start', ...W,
    async run(k) {
      const q = makeQa(k, 'a-start');
      await q.boot();
      await q.shot('start-screen');
      await q.step('start-scrolled', async () => {
        await k.js(`(() => { const s = document.querySelector('.rs-start'); const sc = [s, ...(s ? s.querySelectorAll('*') : [])].find((e) => e && e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible'); if (sc) sc.scrollTop = sc.scrollHeight; })()`);
        await sleep(600);
        await q.shot('start-screen-scrolled');
      });
      await q.step('start-empty', async () => { await q.click('button', 'Start empty'); await sleep(500); await q.shot('after-start-empty'); });
      await q.step('new-from-template', async () => { await q.menu('File', 'New from template'); await sleep(800); await q.shot('new-from-template-dialog'); });
      await q.step('template-open', async () => {
        const n = await k.js(`(() => { const b = [...document.querySelectorAll('[role=dialog] button, .rs-dialog button, .rs-tpl button')].filter((e) => /logo fall/i.test(e.textContent)); if (b[0]) { b[0].click(); return 1; } return 0; })()`);
        if (!n) throw new Error('no Logo fall template button');
        await sleep(2500);
        await q.shot('template-logo-fall');
      });
    },
  },

  /* b. Media panel */
  {
    id: 'b-media', ...W,
    async run(k) {
      const q = makeQa(k, 'b-media');
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Media demo', nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, out: { type: 'image-out', at: [320, 0] } }, edges: [['src.image', 'out.image']],
        media: (a) => ({ bins: [{ id: 'b1', name: 'Pictures', color: 1 }, { id: 'b2', name: 'Sound and text', color: 3 }], assign: { [a.scene]: 'b1', [a.scene2]: 'b1', [a.wav]: 'b2', [a.srt]: 'b2' } }) })`);
      await sleep(1200);
      await q.shot('bins');
      await q.step('by-type', async () => { await q.click('.rs-media__seg button', 'By type'); await sleep(500); await q.shot('by-type'); });
      await q.step('flat', async () => { await q.click('.rs-media__seg button', 'Flat'); await sleep(400); await q.shot('flat'); });
      await q.step('list', async () => { await q.click('.rs-media__views button', 'Compact list'); await sleep(500); await q.shot('list'); });
      await q.step('search', async () => { await k.js(`window.__qa.setText('.rs-media__search input', 'room')`); await sleep(500); await q.shot('search'); await k.js(`window.__qa.setText('.rs-media__search input', '')`); });
      await q.step('bins-again', async () => { await q.click('.rs-media__seg button', 'Bins'); await q.click('.rs-media__views button', 'Thumbnail grid'); await sleep(400); });
      await q.step('context-menu', async () => {
        await k.js(`(() => { const e = document.querySelector('.rs-asset, .rs-media__cell, [data-asset-id]'); if (!e) throw new Error('no asset cell'); const r = e.getBoundingClientRect(); window.__qa.ctx(e, r.x + 20, r.y + 20); })()`);
        await sleep(500);
        await q.shot('context-menu');
        await q.esc();
      });
      await q.step('rail', async () => { await q.click('button', 'Collapse media panel'); await sleep(500); await q.shot('collapsed-rail'); });
    },
  },

  /* c. Viewer toolbar at 1440 and 1280x720 */
  ...[{ id: 'c-viewer', w: 1440, h: 900 }, { id: 'c-viewer-1280', w: 1280, h: 720 }].map((v) => ({
    ...v, dsf: 1,
    async run(k) {
      const q = makeQa(k, v.id);
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Viewer', nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, pix: { type: 'pixelate', at: [300, 0] }, out: { type: 'image-out', at: [600, 0] } }, edges: [['src.image', 'pix.image'], ['pix.image', 'out.image']] })`);
      // narrow viewer bars fold Snapshot / A/B / Output into one icon button and the "…" menu
      const has = (text) => k.js(`[...document.querySelectorAll('.rs-viewer__bar button')].some((b) => (b.textContent || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`);
      const openAb = async () => { if (await has('A/B')) await q.click('button', 'A/B', false); else await q.click('button', 'Snapshot and compare'); };
      const openOutput = async () => { if (await has('Output')) await q.click('button', 'Output', true); else { await q.click('button', 'More view controls'); await sleep(250); await q.click('.rs-menu__item, [role=menuitem]', 'Output window', false); } };
      await k.js(`window.__rsmps.ed.select([window.__qa.ids.pix])`);
      await sleep(1500);
      await q.shot('toolbar');
      await q.step('full-res', async () => { await q.click('button', 'Full res', false); await sleep(1500); await q.shot('full-res'); });
      await q.step('keep-look', async () => { await k.js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /keep this look/i.test(x.textContent)); b && b.focus(); })()`); await q.shot('keep-look-focus'); });
      await q.step('output-menu', async () => { await openOutput(); await sleep(500); await q.shot('output-menu'); await q.esc(); });
      await q.step('snapshot', async () => { if (await has('Snapshot')) await q.click('button', 'Snapshot', false); else { await q.click('button', 'Snapshot and compare'); await sleep(250); await q.click('.rs-menu__item, [role=menuitem]', 'Snapshot', true); } await sleep(1200); await q.shot('snapshot-taken'); });
      await q.step('ab-menu', async () => { await openAb(); await sleep(400); await q.shot('ab-menu'); });
      for (const [id, label] of [['wipe', 'Wipe'], ['difference', 'Difference'], ['side', 'Side by side']]) {
        await q.step('ab-' + id, async () => {
          if (!(await k.js(`!!document.querySelector('.rs-menu')`))) await openAb();
          await sleep(250);
          await k.js(`window.__rsmps.ed.setParam(window.__qa.ids.pix, 'value', 90)`);
          await q.click('.rs-menu__item, [role=menuitem]', label, false);
          await sleep(1200);
          await q.shot('ab-' + id);
        });
      }
      await q.step('exit-compare', async () => { await q.click('button', 'Exit compare'); });
      await q.step('compare-node', async () => {
        // "what did this node change": node B is evaluated off screen, the viewer must keep showing the same node the whole time
        await k.js(`window.__qa.viewedLog = []; void window.__rsmps.ed.store.subscribe(() => window.__qa.viewedLog.push(window.__rsmps.ed.state.viewedNodeId))`);
        if (await has('Node…')) await q.click('button', 'Node…', false); else await q.click('button', 'Snapshot and compare');
        await sleep(300);
        await q.click('.rs-menu__item, [role=menuitem]', 'Selected node vs its input', false);
        await sleep(2500);
        const log = await k.js(`[...new Set(window.__qa.viewedLog)]`);
        await q.shot('compare-node', 'viewed node ids seen during compare: ' + JSON.stringify(log));
      });
    },
  })),

  /* d. Nodes: one per state, node body + inspector */
  {
    id: 'd-nodes', ...W,
    async run(k) {
      const q = makeQa(k, 'd-nodes');
      await q.boot();
      await q.media();
      const list = [
        ['subtitles', { file: '@asset:srt' }], ['glitch'], ['analog-video'], ['specks'], ['infinite-zoom'], ['array'], ['array-3d'], ['kaleidoscope'], ['feedback'], ['frame-interleave'], ['render-scale'],
        ['image-to-3d'], ['sdf-3d'], ['material'], ['material-2d'], ['splat-3d'], ['image-to-splats'], ['depth-estimate'], ['depth-ai'], ['splat-train'],
        ['white-balance'], ['saturation'], ['color-wheels'], ['curves'], ['exposure'], ['color-space'], ['lut'], ['hsl-qualifier'], ['scope'],
        ['sprite-sheet-in'], ['pixel-outline'], ['autotile'], ['palette-lock'], ['beat-detect'], ['sampler'], ['phone-motion'], ['custom-shader'], ['recolor'],
        ['media-timeline'], ['cache'], ['merge'], ['stack'], ['depth-convert'], ['tileset-map'], ['sprite-shadow'],
      ];
      for (const [type, params] of list) {
        await q.step('node-' + type, async () => {
          await k.js(`window.__qa.single(${JSON.stringify(type)}, ${JSON.stringify(params ?? {})})`);
          await sleep(900);
          await q.shot('node-' + type);
        });
      }
      await q.step('curves-editor', async () => {
        await k.js(`window.__qa.single('curves', {})`);
        await sleep(800);
        const n = await k.js(`(() => { const c = document.querySelector('[data-param-key="hueVsSat"] .rs-curve'); if (!c) return 0; c.scrollIntoView({ block: 'center' }); c.click(); return 1; })()`);
        await sleep(600);
        await q.shot('curves-hue-vs-sat', n ? null : 'no Hue vs Sat curve control found');
      });
      await q.step('timeline-open', async () => {
        const clips = [0, 1, 2].map((i) => ({ id: 'c' + i, kind: 'video', source: i, track: 0, start: i * 1.5, in: 0, duration: 2, fadeIn: 0, fadeOut: 0, level: 1, name: ['Room night', 'Room day', 'Base scene'][i] }));
        await k.js(`window.__qa.build({ name: 'Media Timeline', nodes: { a: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, b: { type: 'media-in', at: [0, 160], params: { assets: '@asset:scene' } }, c: { type: 'media-in', at: [0, 320], params: { assets: '@asset:scene' } }, tl: { type: 'media-timeline', at: [330, 60], params: { edit: { clips: ${JSON.stringify(clips)} } } }, out: { type: 'image-out', at: [700, 60] } }, edges: [['a.image', 'tl.clips'], ['b.image', 'tl.clips'], ['c.image', 'tl.clips'], ['tl.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.tl]); window.__rsmps.ed.openTimeline(window.__qa.ids.tl)`);
        await sleep(1500);
        await q.shot('media-timeline-strip');
      });
      await q.step('bake-running', async () => {
        await k.js(`window.__qa.build({ name: 'Cache', project: { duration: 12, fps: 30 }, nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, blur: { type: 'lens-blur', at: [300, 0] }, c: { type: 'cache', at: [600, 0] }, out: { type: 'image-out', at: [900, 0] } }, edges: [['src.image', 'blur.image'], ['blur.image', 'c.image'], ['c.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.c])`);
        await sleep(1200);
        await q.shot('cache-bake-panel');
        await q.click('.rs-insp button, .rs-insp__actions button', 'Bake', false);
        await sleep(1500);
        await q.shot('cache-baking');
        await k.js(`window.__rsmps.io.processes.cancelAll && window.__rsmps.io.processes.cancelAll()`);
      });
    },
  },

  /* d (continued). Groups: collapsed with exposed params, entered, repeat group, context menu items */
  {
    id: 'd-groups', ...W,
    async run(k) {
      const q = makeQa(k, 'd-groups');
      await q.boot();
      await q.media();
      const chain = `window.__qa.build({ name: 'Groups', nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, pix: { type: 'pixelate', at: [320, 0] }, bl: { type: 'blur', at: [620, 0] }, out: { type: 'image-out', at: [920, 0] } }, edges: [['src.image', 'pix.image'], ['pix.image', 'bl.image'], ['bl.image', 'out.image']] });`;
      await k.js(chain);
      await sleep(1200);
      await q.step('group-make', async () => {
        const gid = await k.js(`(() => { const { ed } = window.__rsmps; const q = window.__qa; ed.select([q.ids.pix, q.ids.bl]); const gid = ed.groupNodes('group'); window.__qa.gid = gid; return gid; })()`);
        if (!gid) throw new Error('groupNodes returned null');
        await sleep(800);
        await k.js(`window.__rsmps.ed.enterGroup(window.__qa.gid)`);
        await sleep(800);
        await k.js(`(() => { const { ed } = window.__rsmps; const inner = ed.state.level.nodes.filter((n) => !n.type.startsWith('group-')); const pix = inner.find((n) => n.type === 'pixelate'); const bl = inner.find((n) => n.type === 'blur'); window.__qa.inner = { pix: pix.id, bl: bl.id }; ed.exposeParam(pix.id, 'value', 'Pixel size'); ed.exposeParam(bl.id, 'radius', 'Softness'); })()`);
        await sleep(800);
        await q.shot('group-entered');
      });
      await q.step('group-context-expose', async () => {
        await k.js(`(() => { const { ed } = window.__rsmps; ed.select([window.__qa.inner.pix]); })()`);
        await sleep(600);
        await k.js(`(() => { const row = document.querySelector('.rs-insp [data-param-key="value"]'); if (!row) throw new Error('no inspector row'); const r = row.getBoundingClientRect(); window.__qa.ctx(row, r.x + 40, r.y + 10); })()`);
        await sleep(500);
        await q.shot('param-context-menu-in-group');
        await q.esc();
      });
      await q.step('group-collapsed', async () => {
        await k.js(`(() => { const { ed } = window.__rsmps; ed.exitGroup(0); ed.select([window.__qa.gid]); })()`);
        await sleep(900);
        await q.shot('group-selected-exposed-inspector');
      });
      await q.step('repeat-group', async () => {
        await k.js(chain + ` const { ed } = window.__rsmps; ed.select([window.__qa.ids.bl]); window.__qa.gid = ed.groupNodes('repeat'); ed.select([window.__qa.gid]);`);
        await sleep(1200);
        await q.shot('repeat-group');
        await k.js(`window.__rsmps.ed.enterGroup(window.__qa.gid)`);
        await sleep(800);
        await q.shot('repeat-group-entered');
      });
      await q.step('add-menu', async () => {
        await k.js(`(() => { const ed = window.__rsmps.ed; ed.exitGroup(0); ed.select([]); ed.openAddMenu({ clientX: 720, clientY: 470, world: { x: 100, y: 100 } }); })()`);
        await sleep(600);
        await q.shot('add-menu-categories');
        await k.js(`window.__qa.setText('.rs-add input', 'color')`);
        await sleep(500);
        await q.shot('add-menu-search-color');
        await k.js(`window.__rsmps.ed.openAddMenu(null)`);
      });
      await q.step('node-context', async () => {
        await k.js(`(() => { const ed = window.__rsmps.ed; const g = window.__qa.build({ name: 'Ctx node', nodes: { a: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, m: { type: 'merge', at: [320, 0] }, out: { type: 'image-out', at: [640, 0] } }, edges: [['a.image', 'm.background'], ['m.image', 'out.image']] }); ed.select([g.ids.m]); ed.openContextMenu({ clientX: 640, clientY: 480, nodeId: g.ids.m }); })()`);
        await sleep(500);
        await q.shot('node-context-menu');
        await k.js(`window.__rsmps.ed.openContextMenu(null)`);
      });
      await q.step('param-context-top', async () => {
        await k.js(chain + ` window.__rsmps.ed.select([window.__qa.ids.pix]);`);
        await sleep(900);
        await k.js(`(() => { const row = document.querySelector('.rs-insp [data-param-key="value"]'); if (!row) throw new Error('no inspector row'); const r = row.getBoundingClientRect(); window.__qa.ctx(row, r.x + 40, r.y + 10); })()`);
        await sleep(600);
        await q.shot('param-context-menu-top');
        await q.esc();
      });
    },
  },

  /* e. Dialogs and menus */
  {
    id: 'e-dialogs', ...W,
    async run(k) {
      const q = makeQa(k, 'e-dialogs');
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Dialogs', nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, pix: { type: 'pixelate', at: [320, 0] }, out: { type: 'image-out', at: [620, 0] } }, edges: [['src.image', 'pix.image'], ['pix.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.pix]);`);
      await sleep(1200);
      const dialog = (id, name) => q.step(name, async () => { await k.js(`window.__rsmps.ed.openDialog(${JSON.stringify(id)})`); await sleep(900); await q.shot(name); await k.js(`window.__rsmps.ed.openDialog(null)`); await sleep(300); });
      await dialog('plugins', 'plugins-addons');
      await q.step('plugins-addons-desktop', async () => {
        await k.js(`(() => {
          const io = window.__rsmpsIo;
          const dl = (size) => ({ version: '1.0', size: size * 1e6, sizeLabel: size + ' MB', host: 'github.com', license: { name: 'BSD-3-Clause', url: 'https://example.invalid/license' }, source: { name: 'Release page', url: 'https://example.invalid/release' }, sha256: '0'.repeat(64), hashVerifiedByMaintainer: true });
          const mk = (id, name, description, group, size, state) => ({ id, name, title: name, description, homepage: 'https://example.invalid', state, download: dl(size), bringYourOwn: 'Install it yourself, then press Locate.', canLocate: true, group, installed: null });
          const list = [mk('ffmpeg', 'FFmpeg', 'Needed for ProRes-compatible and transparent video.', undefined, 80, 'not-installed'), mk('colmap', 'COLMAP', 'Solves the camera positions.', 'splat-train', 120, 'not-installed'), mk('brush', 'Brush', 'Trains the splats.', 'splat-train', 60, 'installed')];
          list[2].installed = { source: 'download', version: '0.2', path: 'add-ons/brush' };
          Object.defineProperty(io.addons, 'supported', { get: () => true, configurable: true });
          io.addons.list = async () => list;
          io.addons.onChange = (fn) => { setTimeout(() => fn(list), 0); return () => {}; };
        })()`);
        await k.js(`window.__rsmps.ed.openDialog('plugins')`);
        await sleep(1000);
        await q.shot('plugins-addons-desktop-mock', 'the desktop-only cards (FFmpeg, COLMAP, Brush) are shown with a faked add-on list: not the real desktop client');
        await k.js(`window.__rsmps.ed.openDialog(null)`);
      });
      await dialog('about', 'about');
      await dialog('shortcuts', 'shortcuts');
      await dialog('keymap', 'keymap');
      await dialog('backups', 'backups');
      await dialog('blankSheets', 'print-blank-sheets');
      await dialog('presets', 'presets');
      await dialog('palette', 'palette-studio');
      await q.step('export-image', async () => { await k.js(`window.__rsmps.ed.openDialog('export')`); await sleep(900); await q.shot('export-dialog'); await k.js(`window.__rsmps.ed.openDialog(null)`); });
      await q.step('output-sheet', async () => {
        await k.js(`(() => { const { ed } = window.__rsmps; const out = ed.state.graph.nodes.find((n) => n.type === 'image-out'); ed.select([out.id]); ed.setParam(out.id, 'kind', 'sheet'); window.__qa.out = out.id; })()`);
        await sleep(900);
        await q.shot('output-node-spritesheet-options');
        await k.js(`(() => { const e = document.querySelector('.rs-insp__scroll'); if (e) e.scrollTop = 400; })()`);
        await sleep(300);
        await q.shot('output-node-spritesheet-options-scrolled');
      });
      await q.step('output-video', async () => {
        await k.js(`window.__rsmps.ed.setParam(window.__qa.out, 'kind', 'video')`);
        await sleep(900);
        await q.shot('output-node-video-codecs');
        console.log('  codec options:', JSON.stringify(await k.js(`[...document.querySelectorAll('.rs-insp select')].map((s) => [...s.options].map((o) => o.textContent.trim()))`)).slice(0, 700));
      });
      await q.step('midi-mappings', async () => {
        await q.click('button', 'Output', true);
        await sleep(400);
        await q.shot('output-menu-live');
        await q.click('.rs-menu__item, [role=menuitem]', 'MIDI mappings', false);
        await sleep(700);
        await q.shot('midi-mappings');
        await q.esc();
      });
      await q.step('render-queue', async () => {
        // two jobs: the same graph added twice through the Export menu
        for (let i = 0; i < 2; i++) {
          await k.js(`(() => { const b = document.querySelector('.rs-top .rs-btn--primary'); const caret = b && b.nextElementSibling; if (!caret) throw new Error('no export caret'); caret.click(); })()`);
          await sleep(300);
          await q.click('.rs-menu__item, [role=menuitem]', 'Add to render queue', false);
          await sleep(500);
        }
        await q.shot('render-queue-two-jobs');
        await k.js(`document.querySelector('[role=dialog] button[aria-label*=Close i], .rs-dialog__x')?.click()`);
        await q.esc();
      });
      await q.step('share', async () => {
        await q.menu('File', 'Share this look');
        await sleep(900);
        await q.shot('share-dialog');
        await k.js(`window.__qa.copied = null; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__qa.copied = t; } }, configurable: true }); } catch (e) { /* keep */ }`);
        await q.click('[role=dialog] button, .rs-dialog button', 'Copy link', false);
        await sleep(600);
        const link = await k.js(`window.__qa.copied`);
        console.log('  share link:', link ? link.slice(0, 60) + '... (' + link.length + ' chars)' : 'NOT FOUND');
        await q.esc();
        if (link) {
          await k.js(`location.hash = ${JSON.stringify(link.slice(link.indexOf('#')))}`);
          await sleep(1200);
          await q.shot('open-shared-graph-confirm');
        }
      });
      await q.step('stopmotion', async () => { await k.js(`location.hash = ''`); await q.clean(); await q.menu('File', 'Stop-motion capture'); await sleep(1200); await q.shot('stop-motion-no-camera'); await q.esc(); });
      await q.step('scan-tab', async () => { await k.js(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /^cancel$/i.test((x.textContent || '').trim())); if (b) b.click(); })()`); await sleep(300); await k.js(`window.__rsmps.ed.newScanTab()`); await sleep(2500); await q.shot('scan-start'); });
    },
  },
  {
    id: 'e-pop', ...W,
    async run(k) {
      const q = makeQa(k, 'e-pop');
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Pop', project: { duration: 20, fps: 30 }, nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, blur: { type: 'lens-blur', at: [300, 0] }, c: { type: 'cache', at: [600, 0] }, out: { type: 'image-out', at: [900, 0] } }, edges: [['src.image', 'blur.image'], ['blur.image', 'c.image'], ['c.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.c])`);
      await sleep(1200);
      await q.step('processes', async () => {
        await q.click('.rs-insp button', 'Bake', false);
        await sleep(1500);
        await q.click('button', 'Processes');
        await sleep(600);
        await q.shot('processes-popover');
        await q.esc();
        await k.js(`window.__rsmpsIo.processes.cancelAll && window.__rsmpsIo.processes.cancelAll()`);
      });
      await q.step('memory', async () => { await q.esc(); await k.js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.click()`); await sleep(400); await k.js(`document.querySelector('.rs-mem').click()`); await sleep(600); if (!(await k.js(`!!document.querySelector('.rs-mem__pop')`))) throw new Error('memory popover did not open'); await q.shot('memory-popover'); await q.esc(); });
    },
  },
  { id: 'e-safe', ...W, async run(k) { const q = makeQa(k, 'e-safe'); await q.boot('/index.html?safe=1'); await sleep(1500); await q.shot('safe-mode-banner'); } },
  {
    id: 'e-nogpu', ...W,
    initScript: "Object.defineProperty(Navigator.prototype, 'gpu', { get() { return undefined; }, configurable: true });",
    async run(k) {
      makeQa(k, 'e-nogpu');
      await k.load('/index.html');
      await k.waitFor("!!document.querySelector('.rs-nogpu')", 40000, 'no-webgpu screen');
      await sleep(800);
      await k.shot('no-webgpu-desktop');
    },
  },

  /* f. Transport with all controls */
  ...[{ id: 'f-transport', w: 1440, h: 900 }, { id: 'f-transport-1024', w: 1024, h: 600 }].map((v) => ({
    ...v, dsf: 1,
    async run(k) {
      const q = makeQa(k, v.id);
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Transport', nodes: { kbd: { type: 'midi-keyboard', at: [0, 0] }, syn: { type: 'synth', at: [300, 0] }, aout: { type: 'audio-out', at: [600, 0] }, src: { type: 'media-in', at: [0, 200], params: { assets: '@asset:scene' } }, out: { type: 'image-out', at: [600, 200] } }, edges: [['kbd.midi', 'syn.midi'], ['syn.audio', 'aout.audio'], ['src.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.kbd])`);
      await sleep(1500);
      await q.shot('transport-synth');
      await q.step('transport-playing', async () => { await k.js(`window.__rsmpsIo.player.toggle()`); await sleep(1200); await q.shot('transport-playing'); await k.js(`window.__rsmpsIo.player.toggle()`); });
      await q.step('transport-timeline', async () => {
        await k.js(`window.__qa.build({ name: 'Transport 2', nodes: { tl: { type: 'audio-timeline', at: [300, 0] }, out: { type: 'image-out', at: [600, 200] }, src: { type: 'media-in', at: [0, 200], params: { assets: '@asset:scene' } } }, edges: [['src.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.tl]); window.__rsmps.ed.openTimeline(window.__qa.ids.tl)`);
        await sleep(1500);
        await q.shot('transport-audio-timeline');
      });
    },
  })),
  /* g. Dialogs the other scenes do not open, and the compare / rename flows */
  {
    id: 'g-views', ...W,
    async run(k) {
      const q = makeQa(k, 'g-views');
      await q.boot();
      await q.media();
      await k.js(`window.__qa.build({ name: 'Views', nodes: { src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } }, pix: { type: 'pixelate', at: [320, 0] }, out: { type: 'image-out', at: [620, 0] } }, edges: [['src.image', 'pix.image'], ['pix.image', 'out.image']] }); window.__rsmps.ed.select([window.__qa.ids.pix]); window.__rsmps.ed.setViewed(window.__qa.ids.out)`);
      await sleep(1500);
      for (const [id, name] of [['backups', 'backups'], ['about', 'about'], ['shortcuts', 'shortcuts'], ['keymap', 'keymap'], ['blankSheets', 'print-blank-sheets']]) {
        await q.step(name, async () => { await k.js(`window.__rsmps.ed.openDialog(${JSON.stringify(id)})`); await sleep(1000); await q.shot(name); await k.js(`window.__rsmps.ed.openDialog(null)`); await sleep(300); });
      }
      await q.step('snapshot-rename', async () => {
        try { await q.click('button', 'Snapshot', true); } catch { await q.click('button', 'Snapshot and compare'); await sleep(250); await q.click('.rs-menu__item, [role=menuitem]', 'Snapshot', true); } await sleep(1200); await q.clean();
        await k.js(`(() => { const b = document.querySelector('.rs-cmp__x[aria-label="Rename snapshot"]'); if (!b) throw new Error('no rename button'); b.click(); })()`);
        await sleep(400);
        await q.shot('snapshot-rename-inline');
        await q.esc();
      });
      await q.step('sdf-3d', async () => {
        await k.js(`window.__qa.single('sdf-3d', { shape3: 'box' }); window.__rsmps.ed.select([window.__qa.ids.n])`);
        await sleep(2000);
        await q.shot('sdf-3d-inspector');
      });
    },
  },
];
