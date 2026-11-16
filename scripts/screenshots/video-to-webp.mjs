// Turns a video (for example a phone/scanner recording of a printed-and-scanned animation) into an animated WebP and/or
// a contact sheet, using Electron's own decoder (no ffmpeg needed). Frames go to the OS temp folder, never into the repo.
//
//   npx electron scripts/screenshots/video-to-webp.mjs <video> --webp docs/screenshots/scan-example-1.webp [--start 2] [--dur 6] [--fps 12] [--max 640] [--quality 70] [--pingpong]
//   npx electron scripts/screenshots/video-to-webp.mjs <video> --contact contact.png [--cols 4 --rows 3 --width 1200]
//   npx electron scripts/screenshots/video-to-webp.mjs <video> --probe
//
// --pingpong plays the clip forward then backward, which loops cleanly when the clip does not loop on its own.
// Needs a codec Chromium can decode (H.264, VP9, AV1). H.265 usually fails: the script says so and stops.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const argv = process.argv.slice(1).filter((a) => !a.endsWith('video-to-webp.mjs'));
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const input = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined; // the video is the first argument
if (!input) { console.error('usage: electron video-to-webp.mjs <video> [--webp out] [--contact out] [--probe]'); process.exit(2); }

app.commandLine.appendSwitch('disable-gpu'); // decoding and 2D canvas only; keep the GPU free for the owner
app.disableHardwareAcceleration();

const work = mkdtempSync(join(tmpdir(), 'rsmps-video-'));
const done = (code) => { try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } app.exit(code); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { webSecurity: false, offscreen: false } });
  const page = join(work, 'page.html');
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><video id="v" muted playsinline preload="auto"></video><canvas id="c"></canvas>');
  await win.loadFile(page);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const meta = await js(`new Promise((res) => {
    const v = document.getElementById('v');
    v.onloadedmetadata = () => res({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => res({ error: (v.error && v.error.message) || 'decode error (codec not supported?)' });
    v.src = ${JSON.stringify(pathToFileURL(resolve(input)).href)};
    setTimeout(() => res({ error: 'timeout loading metadata' }), 20000);
  })`);
  if (meta.error || !meta.w) {
    console.error('Cannot decode this video with Electron: ' + (meta.error || 'no video track') + '. If it is H.265/HEVC, re-export it as H.264 first.');
    return done(3);
  }
  console.log(`video ${meta.w}x${meta.h}, ${meta.duration.toFixed(2)} s`);
  if (flag('probe')) return done(0);

  /** Frames at the given times, scaled so the long side is `max`, returned as PNG buffers. */
  async function grab(times, max) {
    const k = Math.min(1, max / Math.max(meta.w, meta.h));
    const w = Math.round(meta.w * k), h = Math.round(meta.h * k);
    await js(`(() => { const c = document.getElementById('c'); c.width = ${w}; c.height = ${h}; })()`);
    const out = [];
    for (const t of times) {
      const b64 = await js(`new Promise((res) => {
        const v = document.getElementById('v'), c = document.getElementById('c'), x = c.getContext('2d');
        const draw = () => { x.drawImage(v, 0, 0, c.width, c.height); res(c.toDataURL('image/png').split(',')[1]); };
        const target = ${t};
        if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) { draw(); return; }
        v.onseeked = () => { v.onseeked = null; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(draw); else draw(); setTimeout(draw, 800); };
        v.currentTime = target;
      })`);
      out.push(Buffer.from(b64, 'base64'));
    }
    return { frames: out, w, h };
  }

  const contact = opt('contact');
  if (contact) {
    const cols = +opt('cols', 4), rows = +opt('rows', 3), W = +opt('width', 1200), gut = 4;
    const n = cols * rows;
    const times = Array.from({ length: n }, (_, i) => Math.min(meta.duration - 0.05, ((i + 0.5) / n) * meta.duration));
    const cellW = Math.floor((W - gut * (cols + 1)) / cols);
    const { frames, w, h } = await grab(times, cellW * 2);
    const cellH = Math.round((cellW * h) / w);
    const tiles = [];
    for (let i = 0; i < n; i++) {
      const img = await sharp(frames[i]).resize(cellW, cellH, { fit: 'fill' }).png().toBuffer();
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="22"><rect width="${cellW}" height="22" fill="#000" fill-opacity="0.6"/><text x="6" y="16" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#fff">${times[i].toFixed(1)} s</text></svg>`);
      tiles.push({ input: await sharp(img).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer(), left: gut + (i % cols) * (cellW + gut), top: gut + Math.floor(i / cols) * (cellH + gut) });
    }
    mkdirSync(dirname(resolve(contact)), { recursive: true });
    await sharp({ create: { width: W, height: gut + rows * (cellH + gut), channels: 3, background: '#111' } }).composite(tiles).png().toFile(resolve(contact));
    console.log('contact sheet', contact);
  }

  const webp = opt('webp');
  if (webp) {
    const start = +opt('start', 0), fps = +opt('fps', 12), max = +opt('max', 640), q = +opt('quality', 70);
    const dur = Math.min(+opt('dur', 6), meta.duration - start);
    const count = Math.max(2, Math.floor(dur * fps));
    const times = Array.from({ length: count }, (_, i) => Math.min(meta.duration - 0.02, start + i / fps));
    const { frames, w, h } = await grab(times, max);
    let seq = frames;
    if (flag('pingpong')) seq = [...frames, ...frames.slice(1, -1).reverse()];
    const raw = [];
    for (const f of seq) raw.push(await sharp(f).ensureAlpha().raw().toBuffer());
    const anim = await sharp(Buffer.concat(raw), { raw: { width: w, height: h * raw.length, channels: 4, pageHeight: h } })
      .webp({ loop: 0, delay: raw.map(() => Math.round(1000 / fps)), quality: q, effort: 5, smartSubsample: true })
      .toBuffer();
    mkdirSync(dirname(resolve(webp)), { recursive: true });
    writeFileSync(resolve(webp), anim);
    console.log(`${webp}: ${raw.length} frames ${w}x${h} @ ${fps} fps, ${Math.round(anim.length / 1024)} KB`);
    if (anim.length > 4 * 1024 * 1024) console.warn('WARNING: over 4 MB; lower --fps, --max, --dur or --quality');
  }
  done(0);
}).catch((e) => { console.error(e); done(1); });
