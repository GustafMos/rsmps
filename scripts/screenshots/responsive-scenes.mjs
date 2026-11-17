// Scenes for responsive.mjs: one per viewport. Each walks through the main states of the app and saves a screenshot per state.
// A real graph without media comes from the first built-in preset, loaded through the Presets dialog (the built app has no dev handle).

async function boot(k) {
  await k.load('/index.html');
  await k.waitFor(`!!document.querySelector('.rs-app')`, 60000, 'app shell');
  await k.sleep(800);
}

/** Opens the first built-in preset as a new project tab; `openDialog` does the click-through that shows the Presets dialog. */
async function loadFirstPreset(k, openDialog, shotName) {
  await openDialog();
  await k.waitFor(`!!document.querySelector('.rs-preset .rs-btn--primary')`, 20000, 'presets dialog');
  if (shotName) await k.shot(shotName);
  await k.js(`document.querySelector('.rs-preset .rs-btn--primary').click()`);
  await k.waitFor(`document.querySelectorAll('[data-node-id]').length >= 4`, 30000, 'preset nodes');
  await k.sleep(2500);
}

const clickText = (k, scope, text, not) =>
  k.js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !(${JSON.stringify(not ?? '')} && b.textContent.includes(${JSON.stringify(not ?? '')}))); if (!e) throw new Error('no ' + ${JSON.stringify(text)}); e.click(); })()`);

const desktopDialog = (k) => async () => {
  await clickText(k, '.rs-top button', 'File');
  await k.sleep(300);
  await clickText(k, '.rs-menu__item', 'Presets…', 'Save as');
};

const phoneDialog = (k) => async () => {
  await k.tapSel('.rs-tabbar__btn:nth-child(5)');
  await k.sleep(400);
  await clickText(k, '.rs-more__row', 'Presets…', 'Save as');
};
const tab = (k, n) => k.tapSel(`.rs-tabbar__btn:nth-child(${n})`);
const edges = (k) => k.js(`document.querySelectorAll('.rs-graph .rs-wire-g').length`);

const multi = (k, type, pts) => k.cdp('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const zoomText = (k) => k.js(`document.querySelector('.rs-viewer__zoom')?.textContent ?? ''`);

/** Gestures: pinch and double-tap in the viewer, select mode in the graph, long press for tooltip and context menu. */
async function phoneExtras(k) {
  await tab(k, 1);
  await k.sleep(500);
  await k.frame();
  const z0 = await zoomText(k);
  await multi(k, 'touchStart', [[150, 380], [240, 380]]);
  for (let i = 1; i <= 8; i++) { await multi(k, 'touchMove', [[150 - i * 8, 380], [240 + i * 8, 380]]); await k.sleep(16); }
  await multi(k, 'touchEnd', []);
  await k.sleep(300);
  const z1 = await zoomText(k);
  console.log('  pinch out in the viewer: zoom', JSON.stringify(z0), '->', JSON.stringify(z1));
  await multi(k, 'touchStart', [[100, 380], [290, 380]]);
  for (let i = 1; i <= 8; i++) { await multi(k, 'touchMove', [[100 + i * 8, 380], [290 - i * 8, 380]]); await k.sleep(16); }
  await multi(k, 'touchEnd', []);
  await k.sleep(300);
  console.log('  pinch in:', JSON.stringify(await zoomText(k)));
  await k.doubleTap(195, 300);
  await k.sleep(300);
  console.log('  double-tap toggles fit/100%:', JSON.stringify(await zoomText(k)));
  await k.doubleTap(195, 300);
  await k.sleep(300);
  console.log('  double-tap again:', JSON.stringify(await zoomText(k)));
  // long press: tooltip on a titled control
  await k.tap(...(await k.centerOf('.rs-ptp__loop')).map(Math.round), 800);
  await k.sleep(300);
  console.log('  long-press on a titled button shows a touch tooltip:', await k.exists('.rs-touchtip'), '| loop toggled by the press?', await k.js(`document.querySelector('.rs-ptp__loop').getAttribute('aria-checked')`));
  await k.shot('longpress-tooltip');
  // long press: context menu where a right-click has one (a project tab)
  await tab(k, 5);
  await k.sleep(600);
  await k.tap(...(await k.centerOf('.rs-more__tabs .rs-tab')).map(Math.round), 800);
  await k.sleep(400);
  console.log('  long-press on a project tab opens its menu:', await k.exists('.rs-menu'));
  await k.shot('longpress-menu');
  await k.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await tab(k, 2);
  await k.sleep(500);
  // select mode: a one-finger drag draws the selection box
  await k.tapSel('.rs-selecttoggle');
  const g = await k.js(`(() => { const b = document.querySelector('.rs-graph').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`);
  await k.drag(Math.round(g[0] + 6), Math.round(g[1] + 10), Math.round(g[0] + g[2] - 6), Math.round(g[1] + g[3] - 10));
  console.log('  select mode + drag selected nodes:', await k.js(`document.querySelectorAll('.rs-node.is-selected').length`));
  await k.shot('select-mode');
  await k.tapSel('.rs-selecttoggle');
  // dragging a node to the edge of the panel pans the view
  await k.tapSel('.rs-selecttoggle');
  const nodeAt = await k.js(`(() => { const n = [...document.querySelectorAll('.rs-graph [data-node-id]')].find((e) => { const b = e.getBoundingClientRect(); return b.left > 5 && b.right < innerWidth - 5 && b.top > 150; }); if (!n) return null; const b = n.getBoundingClientRect(); return [b.x + b.width / 2, b.y + 10]; })()`);
  if (nodeAt) {
    const layerT = () => k.js(`document.querySelector('.rs-graph__layer').style.transform`);
    const t0 = await layerT();
    await k.frame();
    await k.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nodeAt[0], y: nodeAt[1], id: 1 }] });
    for (let i = 1; i <= 10; i++) { await k.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nodeAt[0] + ((g[0] + g[2] - 8 - nodeAt[0]) * i) / 10, y: nodeAt[1], id: 1 }] }); await k.sleep(16); }
    await k.sleep(700);
    const t1 = await layerT();
    await k.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await k.sleep(300);
    console.log('  edge auto-pan while dragging a node:', t0, '->', t1, t0 !== t1 ? '(panned)' : '(did NOT pan)');
    await k.js(`void 0`);
  }
  // one finger pans; a tap on empty space deselects
  await k.drag(Math.round(g[0] + 60), Math.round(g[1] + 40), Math.round(g[0] + 160), Math.round(g[1] + 120));
  const empty = await k.js(`(() => { const r = document.querySelector('.rs-graph').getBoundingClientRect(); for (let y = r.bottom - 12; y > r.top + 60; y -= 24) for (let x = r.right - 12; x > r.left + 12; x -= 24) { const e = document.elementFromPoint(x, y); if (e && (e.classList.contains('rs-graph') || e.classList.contains('rs-graph__layer'))) return [x, y]; } return null; })()`);
  if (empty) await k.tap(Math.round(empty[0]), Math.round(empty[1]));
  console.log('  tap on empty space deselects:', await k.js(`document.querySelectorAll('.rs-node.is-selected').length === 0`));
}

/** The phone flow, shared by portrait and landscape. */
async function phoneFlow(k, landscape) {
  await boot(k);
  await k.shot('start');
  await tab(k, 5);
  await k.sleep(400);
  await k.shot('more');
  await loadFirstPreset(k, phoneDialog(k), 'presets-dialog');
  await k.shot('presets-dialog-loaded');
  await tab(k, 2);
  await k.sleep(2200);
  await k.shot('graph');
  // tap-tap wiring: an output socket, then check the pending state, then cancel with a tap on empty space
  const before = await edges(k);
  const [ox, oy] = await k.js(`(() => { const s = [...document.querySelectorAll('.rs-graph [data-sock][data-dir=out]')].find((e) => { const b = e.getBoundingClientRect(); return b.left > 0 && b.right < innerWidth && b.top > 100 && b.bottom < innerHeight - 60; }); if (!s) return [0, 0]; const b = s.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  if (ox) {
    await k.tap(Math.round(ox), Math.round(oy));
    await k.sleep(300);
    console.log(`${landscape ? 'landscape' : 'phone'}: tapwire pending chip:`, await k.exists('.rs-wirechip'), 'edges', before);
    await k.shot('tapwire');
    await k.tapSel('.rs-wirechip .rs-btn');
    await k.sleep(200);
    console.log('  after cancel chip:', await k.exists('.rs-wirechip'));
  }
  // long press on empty graph space opens the add menu
  const [gx, gy] = await k.js(`(() => { const b = document.querySelector('.rs-graph').getBoundingClientRect(); return [b.x + b.width - 30, b.y + b.height - 30]; })()`);
  await k.tap(Math.round(gx), Math.round(gy), 800);
  await k.sleep(400);
  console.log('  long-press on background opened add menu:', await k.exists('.rs-add'));
  await k.shot('add-sheet');
  if (await k.exists('.rs-add__x')) await k.tapSel('.rs-add__x');
  await k.sleep(300);
  // list view
  await k.tapSel('.rs-gtb__seg .rs-btn:nth-child(2)');
  await k.sleep(300);
  await k.shot('list');
  await k.tapSel('.rs-gtb__seg .rs-btn:nth-child(1)');
  await k.sleep(300);
  // select a node, then double-tap it: focus opens the inspector
  const [nx, ny] = await k.js(`(() => { const n = [...document.querySelectorAll('.rs-graph [data-node-id]')].find((e) => { const b = e.getBoundingClientRect(); return b.left > 5 && b.right < innerWidth && b.top > 100; }) || document.querySelector('.rs-graph [data-node-id]'); const b = n.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height - 6]; })()`);
  await k.doubleTap(Math.round(nx), Math.round(ny));
  await k.sleep(500);
  console.log('  double-tap focus opened inspector:', await k.js(`document.querySelector('.rs-pshell').dataset.pane === 'inspector'`));
  if (!(await k.js(`document.querySelector('.rs-pshell').dataset.pane === 'inspector'`))) {
    console.log('  fallback: tapping the Inspector tab; element there:', await k.js(`(() => { const b = document.querySelector('.rs-tabbar__btn:nth-child(3)').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && (e.className + ' | ' + e.tagName); })()`), 'selection:', await k.js(`document.querySelectorAll('.rs-node.is-selected').length`));
    await tab(k, 3);
    await k.sleep(400);
    console.log('  pane now:', await k.js(`document.querySelector('.rs-pshell').dataset.pane`));
  }
  await k.sleep(500);
  await k.shot('inspector');
  await tab(k, 1);
  await k.sleep(600);
  await k.shot('view');
  await tab(k, 4);
  await k.sleep(500);
  await k.shot('media');
  await tab(k, 2);
  await k.sleep(500);
  await phoneExtras(k);
  // transport "…" sheet
  await k.tapSel('.rs-ptp .rs-btn:last-child');
  await k.sleep(400);
  await k.shot('transport-sheet');
}

const ANDROID_FF = 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const scenes = [
  { id: 'desktop', w: 1280, h: 720, dsf: 1, async run(k) { await boot(k); await k.shot('empty'); await loadFirstPreset(k, desktopDialog(k)); await k.shot('main'); } },
  { id: 'desktop-small', w: 1024, h: 600, dsf: 1, async run(k) { await boot(k); await loadFirstPreset(k, desktopDialog(k)); await k.shot('main'); } },
  { id: 'phone', w: 390, h: 844, dsf: 3, touch: true, ua: ANDROID_CHROME, platform: 'Android', async run(k) { await phoneFlow(k, false); } },
  { id: 'landscape', w: 844, h: 390, dsf: 3, touch: true, ua: ANDROID_CHROME, platform: 'Android', async run(k) { await phoneFlow(k, true); } },
  {
    id: 'tablet', w: 820, h: 1180, dsf: 2, touch: true,
    async run(k) {
      await boot(k);
      await loadFirstPreset(k, async () => {
        await clickText(k, '.rs-top button', 'File');
        await k.sleep(300);
        await clickText(k, '.rs-menu__item', 'Presets…', 'Save as');
      });
      await k.shot('main');
      await k.tapSel('button[aria-label="Toggle media panel"]');
      await k.sleep(500);
      await k.shot('media-drawer');
      await k.tapSel('.rs-drawer__head .rs-btn:first-of-type');
      await k.sleep(400);
      await k.shot('media-pinned');
      await k.tapSel('button[aria-label="Toggle media panel"]');
      await k.sleep(300);
      await k.tapSel('button[aria-label="Toggle inspector"]');
      await k.sleep(500);
      await k.shot('inspector-drawer');
    },
  },
  {
    id: 'nogpu-api', w: 390, h: 844, dsf: 3, touch: true, ua: ANDROID_FF, platform: 'Android',
    initScript: `Object.defineProperty(Navigator.prototype, 'gpu', { get() { return undefined; }, configurable: true });`,
    async run(k) {
      await k.load('/index.html');
      await k.waitFor(`!!document.querySelector('.rs-nogpu')`, 40000, 'no-webgpu screen');
      await k.sleep(800);
      await k.shot('firefox-android');
      await k.js(`document.querySelector('.rs-nogpu').scrollTo(0, 99999)`);
      await k.sleep(300);
      await k.shot('scrolled');
    },
  },
  {
    id: 'nogpu-adapter', w: 390, h: 844, dsf: 3, touch: true, ua: ANDROID_CHROME, platform: 'Android',
    initScript: `if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;`,
    async run(k) {
      await k.load('/index.html');
      await k.waitFor(`!!document.querySelector('.rs-nogpu')`, 40000, 'no-webgpu screen');
      await k.sleep(800);
      await k.shot('chrome-android-no-adapter');
    },
  },
];

export { boot, loadFirstPreset, clickText };
