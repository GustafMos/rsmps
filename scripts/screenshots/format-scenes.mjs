// In-browser export check of the format registry, run with the responsive harness (hidden Electron window, real WebGPU, the app's real exporter):
//
//   VITE_RSMPS_QA=1 npx vite build --outDir <OS temp>/rsmps-qa-dist --emptyOutDir
//   npx electron scripts/screenshots/responsive.mjs --dist <OS temp>/rsmps-qa-dist --scenes scripts/screenshots/format-scenes.mjs [--only f-exports,f-inspector]
//
// f-exports   exports the formats the app writes itself through window.__rsmps (HAP in three flavors, Motion JPEG through the browser's canvas, PNG / uncompressed MOV,
//             GIF, APNG, stills incl. QOI / TIFF / TGA / BMP / ICO / PPM / OpenEXR / Radiance HDR / 16-bit TIFF / AVIF, sound files) and saves the bytes to
//             <preview dir>/formats/browser/ for scripts/check-formats-browser.mjs (decodes them with FFmpeg).
// f-bigmov    a 4K HAP export of 25 frames (more than 200 MB) through a File System Access style sink (a mock of showSaveFilePicker over OPFS, since a hidden window has no
//             user gesture), with the JS heap sampled during the export: it must stay far below the file size.
// f-inspector screenshots of the Output node's inspector with HAP, GIF and a still format chosen, and the Image format list opened as a list box.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_DIR = (process.env.RSMPS_PREVIEW_DIR ?? join(tmpdir(), 'rsmps-previews')).split('\\').join('/');
const OUT = join(PNG_DIR, 'formats', 'browser');
mkdirSync(OUT, { recursive: true });
const W = { w: 1440, h: 900, dsf: 1 };

const LIB = `(() => {
  const H = () => window.__rsmps;
  const lib = (window.__fx = {
    build(w, h, fps, seconds, sound) {
      const { io, ed, graph: G } = H();
      let g = G.createGraph('shapes');
      g = { ...g, project: { ...g.project, width: w, height: h, fps, duration: seconds, loop: true, lengthMode: 'absolute' } };
      const add = (type, at, params, label) => { const r = G.addNode(g, io.registry, type, { x: at[0], y: at[1] }, params); g = r.graph; if (label) g = { ...g, nodes: g.nodes.map((n) => (n.id === r.node.id ? { ...n, label } : n)) }; return r.node.id; };
      const s = add('shape', [0, 0], { kind: 'ellipse', width: 0.5, height: 0.6, fill: [1, 0.3, 0.1, 0.55] });
      const a = add('animate', [0, 200], { from: 0.3, to: 0.7, wave: 'sine' });
      const out = add('image-out', [300, 0], { name: 'shapes', kind: 'video' }, 'Out');
      g = G.connect(g, io.registry, { node: s, port: 'image' }, { node: out, port: 'image' });
      g = G.connect(g, io.registry, { node: a, port: 'value' }, { node: s, port: 'x' });
      let ao = null;
      if (sound) {
        const o = add('oscillator', [0, 400], {});
        ao = add('audio-out', [300, 400], {});
        g = G.connect(g, io.registry, { node: o, port: 'audio' }, { node: ao, port: 'audio' });
      }
      ed.loadGraph(g);
      lib.ids = { out, ao, s };
      return lib.ids;
    },
    set(id, key, value) { H().ed.setParam(id, key, value); },
    async run(outputs, extra) {
      const { io, ed } = H();
      const t0 = performance.now();
      const files = await io.exporter.run({ graph: ed.state.graph, outputs, items: 'current', item: 0, zip: false, ...(extra || {}) });
      const ms = performance.now() - t0;
      const out = [];
      for (const f of files) {
        const buf = new Uint8Array(await f.blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
        out.push({ name: f.name, size: buf.length, b64: btoa(bin) });
      }
      return { ms, files: out };
    },
  });
})()`;

async function boot(k) {
  await k.load('/index.html');
  await k.waitFor(`!!document.querySelector('.rs-app') && !!window.__rsmps`, 60000, 'app shell');
  await k.js(LIB);
  await k.js(`try { localStorage.setItem('rsmps.ui.zoomHint', '9'); } catch {}`);
  await k.sleep(600);
}

function save(prefix, res) {
  const saved = [];
  for (const f of res.files) {
    const name = `${prefix}${f.name}`;
    writeFileSync(join(OUT, name), Buffer.from(f.b64, 'base64'));
    saved.push(`${name} (${f.size} B)`);
  }
  return saved;
}

export const scenes = [
  {
    id: 'f-exports', ...W,
    async run(k) {
      await boot(k);
      const ids = await k.js(`window.__fx.build(640, 360, 25, 1, true)`);
      const manifest = [];
      const one = async (tag, params, outputs = [ids.out], extra) => {
        try {
          for (const [key, v] of Object.entries(params)) await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, ${JSON.stringify(key)}, ${JSON.stringify(v)})`);
          const res = await k.js(`window.__fx.run(${JSON.stringify(outputs)}, ${JSON.stringify(extra ?? {})})`);
          const saved = save(tag + '__', res);
          manifest.push({ tag, params, ms: Math.round(res.ms), files: res.files.map((f) => ({ name: tag + '__' + f.name, size: f.size })) });
          console.log(`  ${tag}: ${saved.join(', ')}  ${Math.round(res.ms)} ms`);
        } catch (e) {
          manifest.push({ tag, params, error: String(e.message ?? e).slice(0, 300) });
          console.log(`  ${tag}: FAILED ${String(e.message ?? e).slice(0, 200)}`);
        }
      };
      // video and animated formats, every frame from the real render loop
      await one('hap', { kind: 'video', codec: 'hap' });
      await one('hap_alpha', { codec: 'hap_alpha' });
      await one('hap_q', { codec: 'hap_q' });
      await one('hap_better', { codec: 'hap', hapQuality: 'better' });
      await one('hap_nosnappy', { codec: 'hap', hapQuality: 'fast', hapSnappy: false });
      await one('mjpeg', { codec: 'mjpeg' });
      await one('png_mov', { codec: 'png-mov' });
      await one('raw_mov', { codec: 'raw-mov' });
      await one('gif', { codec: 'gif' });
      await one('gif_shared_floyd', { codec: 'gif', gifPalette: 'global', gifDither: 'floyd', gifColors: 64, gifLoop: 3 });
      await one('apng', { codec: 'apng' });
      await one('h264', { codec: 'avc' }); // the browser's own encoder, for comparison
      // stills (frame 0) in every format the app writes itself, plus the browser ones
      for (const fmt of ['png', 'webp', 'jpeg', 'avif', 'qoi', 'tiff', 'tga', 'bmp', 'tiff16', 'ico', 'ppm', 'hdr', 'exr']) await one('still_' + fmt, { kind: 'image', imageFormat: fmt });
      await one('seq_qoi', { kind: 'sequence', imageFormat: 'qoi', name: 'f_{frame}' });
      // sound only
      for (const f of ['wav32f', 'wav24', 'wav', 'aiff24', 'aiff', 'flac24', 'flac', 'aac', 'webm-opus', 'mp3']) {
        await k.js(`window.__rsmps.ed.setParam(${JSON.stringify(ids.ao)}, 'soundFormat', ${JSON.stringify(f)})`);
        try {
          const res = await k.js(`window.__fx.run(${JSON.stringify([ids.ao])})`);
          const saved = save('sound_' + f + '__', res);
          manifest.push({ tag: 'sound_' + f, files: res.files.map((x) => ({ name: 'sound_' + f + '__' + x.name, size: x.size })) });
          console.log(`  sound_${f}: ${saved.join(', ')}`);
        } catch (e) {
          manifest.push({ tag: 'sound_' + f, error: String(e.message ?? e).slice(0, 300) });
          console.log(`  sound_${f}: FAILED ${String(e.message ?? e).slice(0, 200)}`);
        }
      }
      writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
      console.log('manifest: ' + join(OUT, 'manifest.json'));
    },
  },

  {
    id: 'f-bigmov', ...W,
    async run(k) {
      await boot(k);
      const ids = await k.js(`window.__fx.build(3840, 2160, 25, 1, false)`);
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'codec', 'hap_alpha')`);
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'hapSnappy', false)`);
      // A hidden window has no user gesture, so the real showSaveFilePicker would be refused: a stand-in that returns a real OPFS file handle
      // (same FileSystemFileHandle / FileSystemWritableFileStream API, including seeking writes) exercises the same sink.
      const r = await k.js(`(async () => {
        const root = await navigator.storage.getDirectory();
        window.showSaveFilePicker = async (o) => root.getFileHandle(o.suggestedName, { create: true });
        let peak = 0;
        const timer = setInterval(() => { const m = performance.memory; if (m) peak = Math.max(peak, m.usedJSHeapSize); }, 50);
        const base = performance.memory ? performance.memory.usedJSHeapSize : 0;
        const t0 = performance.now();
        const files = await window.__rsmps.io.exporter.run({ graph: window.__rsmps.ed.state.graph, outputs: [${JSON.stringify(ids.out)}], items: 'current', item: 0, zip: false });
        const ms = performance.now() - t0;
        clearInterval(timer);
        const h = await root.getFileHandle('shapes.mov');
        const f = await h.getFile();
        return { ms, files: files.map((x) => ({ name: x.name, savedPath: x.savedPath ?? null, blobSize: x.blob.size })), fileSize: f.size, peakHeapMB: Math.round(peak / 1048576), baseHeapMB: Math.round(base / 1048576) };
      })()`);
      console.log('  big MOV: ' + JSON.stringify(r));
      // copy the OPFS file to disk in chunks so FFmpeg can decode it
      const file = join(OUT, 'big_4k_hap_alpha.mov');
      writeFileSync(file, Buffer.alloc(0));
      const { appendFileSync } = await import('node:fs');
      const CH = 8 * 1048576;
      for (let at = 0; at < r.fileSize; at += CH) {
        const b64 = await k.js(`(async () => { const root = await navigator.storage.getDirectory(); const f = await (await root.getFileHandle('shapes.mov')).getFile(); const buf = new Uint8Array(await f.slice(${at}, ${at + CH}).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return btoa(s); })()`);
        appendFileSync(file, Buffer.from(b64, 'base64'));
      }
      writeFileSync(join(OUT, 'big.json'), JSON.stringify(r, null, 1));
      console.log('  saved ' + file);
    },
  },

  {
    id: 'f-inspector', ...W,
    async run(k) {
      await boot(k);
      const ids = await k.js(`window.__fx.build(640, 360, 25, 1, true)`);
      const select = () => k.js(`window.__rsmps.ed.select([${JSON.stringify(ids.out)}])`);
      const shot = async (name, key) => {
        await k.sleep(500);
        if (key) await k.js(`(() => { const e = document.querySelector('[data-param-key="${key}"]'); if (e) e.scrollIntoView({ block: 'center' }); })()`);
        await k.sleep(200);
        await k.js(`(() => { const ed = window.__rsmps.ed; ed.dismissSupport && ed.dismissSupport(); for (const t of ed.state.toasts) ed.dismissToast(t.id); })()`);
        await k.shot(name);
      };
      await select();
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'codec', 'hap')`);
      await k.sleep(1200);
      await shot('hap', 'hapQuality');
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'codec', 'gif')`);
      await k.sleep(500);
      await shot('gif', 'gifLoop');
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'codec', 'apng')`);
      await k.sleep(300);
      await shot('apng', 'gifLoop');
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'kind', 'image')`);
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'imageFormat', 'exr')`);
      await k.sleep(500);
      await shot('still-exr', 'imageFormat');
      // the Image format dropdown, opened as a list so the groups and tags show in a capture (a native popup is not part of a page capture)
      const info = await k.js(`(() => {
        const sels = [...document.querySelectorAll('select')];
        const sel = sels.find((s) => [...s.options].some((o) => o.value === 'qoi'));
        if (!sel) return null;
        const groups = [...sel.children].map((c) => c.tagName === 'OPTGROUP' ? c.label + ': ' + [...c.children].map((o) => o.textContent).join(' | ') : c.textContent);
        sel.size = Math.min(24, sel.options.length + sel.querySelectorAll('optgroup').length);
        sel.style.height = 'auto';
        sel.scrollIntoView({ block: 'center' });
        return groups;
      })()`);
      console.log('  image format list: ' + JSON.stringify(info));
      writeFileSync(join(OUT, 'image-format-groups.json'), JSON.stringify(info, null, 1));
      await k.sleep(400);
      await shot('image-format-list');
      await k.js(`(() => { const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'qoi')); if (sel) { sel.size = 0; sel.removeAttribute('size'); sel.style.height = ''; } })()`);
      // the codec list as groups
      await k.js(`window.__fx.set(${JSON.stringify(ids.out)}, 'kind', 'video')`);
      await k.sleep(400);
      const codecs = await k.js(`(() => {
        const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'hap_alpha'));
        if (!sel) return null;
        const groups = [...sel.children].map((c) => c.tagName === 'OPTGROUP' ? c.label + ': ' + [...c.children].map((o) => o.textContent).join(' | ') : c.textContent);
        sel.size = Math.min(26, sel.options.length + sel.querySelectorAll('optgroup').length);
        sel.style.height = 'auto';
        sel.scrollIntoView({ block: 'center' });
        return groups;
      })()`);
      writeFileSync(join(OUT, 'codec-groups.json'), JSON.stringify(codecs, null, 1));
      await k.sleep(400);
      await shot('codec-list');
    },
  },
];
