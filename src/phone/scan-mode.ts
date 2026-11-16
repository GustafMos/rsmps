/**
 * The phone page's SCAN MODE: viewfinder with a guide and a live corner check, shutter (and optional auto-capture), full-resolution
 * stills uploaded to the computer over the existing link, a strip of thumbnails with the computer's status for each, and the preview of the
 * assembled animation. The pure parts live in scan-check / scan-capture / scan-transfer / scan-photos / scan-preview (all unit-tested);
 * this file is the DOM and device glue, and needs a real phone to be confirmed.
 */
import {
  AutoCaptureGate,
  CHECK_SIDE,
  SteadyTracker,
  checkFrame,
  checkSize,
  markerHint,
  rgbaToGray,
  type CheckResult,
} from './scan-check';
import {
  PATH_TEXT,
  canAutoCapture,
  captureGrabFrame,
  captureNativeCamera,
  captureTakePhoto,
  closeViewfinder,
  hasImageCapture,
  openViewfinder,
  pickCapturePath,
  prepareStill,
  type Viewfinder,
} from './scan-capture';
import {
  addThumb,
  applyStatus,
  missingLines,
  progressLine,
  removeThumb,
  setProgress,
  setSent,
  setUploadFailed,
  thumbLabel,
  type CapturePathName,
  type Thumb,
} from './scan-photos';
import { counterText, frameAt, isMissingFrame, spriteRect } from './scan-preview';
import {
  FRAME_PREVIEW,
  PHOTO_LIMITS,
  PREVIEW_LIMITS,
  parseChunkFrame,
  parsePreviewMeta,
  parseScanReady,
  parseScanStatus,
  parseScanSummary,
  type PreviewMeta,
  type ScanSummaryMsg,
} from './scan-protocol';
import { ChunkSender, TransferReceiver } from './scan-transfer';

export interface ScanModeEnv {
  send(msg: unknown): void;
  sendBinary(data: Uint8Array): void;
  buffered(): number;
  isOpen(): boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface Pending {
  id: number;
  blob: Blob;
  name: string;
  w: number;
  h: number;
  sender: ChunkSender | null;
}

export function createScanMode(env: ScanModeEnv) {
  const root = $('scan');
  const video = $<HTMLVideoElement>('scanVideo');
  const hintEl = $('scanHint');
  const infoEl = $('scanInfo');
  const progressEl = $('scanProgress');
  const thumbsEl = $('thumbs');
  const shutter = $<HTMLButtonElement>('shutter');
  const autoBox = $<HTMLInputElement>('autoCap');
  const doneBtn = $<HTMLButtonElement>('scanDone');
  const fileInput = $<HTMLInputElement>('scanFile');
  const flash = $('scanFlash');
  const ticks = [$('tickTL'), $('tickTR'), $('tickBR'), $('tickBL')];
  const previewPane = $('previewPane');
  const previewCanvas = $<HTMLCanvasElement>('previewCanvas');
  const playBtn = $<HTMLButtonElement>('previewPlay');
  const counterEl = $('previewCounter');
  const previewNote = $('previewNote');
  const missingEl = $('previewMissing');
  const backBtn = $<HTMLButtonElement>('previewBack');
  const scrub = $<HTMLInputElement>('previewScrub');

  let limits = { chunkBytes: PHOTO_LIMITS.chunkBytes, window: PHOTO_LIMITS.window };
  let projectFps = 12;
  let active = false;
  let finder: Viewfinder | null = null;
  let thumbs: Thumb[] = [];
  const dataUrls = new Map<number, string>();
  const queue: Pending[] = [];
  const keep = new Map<number, Pending>(); // photos that failed to upload (can be sent again)
  let current: Pending | null = null;
  let summary: ScanSummaryMsg | null = null;
  let capturing = false;
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let path: CapturePathName = 'nativeCamera';
  let chain: CapturePathName[] = ['nativeCamera'];
  let last: CheckResult | null = null;
  const steady = new SteadyTracker();
  const gate = new AutoCaptureGate();
  const checkCanvas = document.createElement('canvas');
  let usedPaths = new Map<number, CapturePathName>();

  /* ------------------------------------------- rendering ------------------------------------------- */

  function renderTicks(r: CheckResult | null): void {
    ticks.forEach((t, i) => t.classList.toggle('on', !!r?.corners[i]));
    root.classList.toggle('found', !!r?.quad);
  }

  let noticeUntil = 0;
  function notice(text: string): void {
    noticeUntil = performance.now() + 7000;
    infoEl.textContent = text;
    setTimeout(renderInfo, 7100);
  }

  function renderInfo(): void {
    if (performance.now() >= noticeUntil) infoEl.textContent = PATH_TEXT[path];
    progressEl.textContent = progressLine(thumbs, summary);
  }

  function renderThumbs(): void {
    thumbsEl.textContent = '';
    for (const t of thumbs) {
      const box = el('div', `thumb ${t.state}${t.retake || t.uploadFailed ? ' bad' : ''}`);
      box.dataset.id = String(t.id);
      const img = el('img', '');
      img.alt = '';
      const u = dataUrls.get(t.id);
      if (u) img.src = u;
      box.append(img);
      if (t.state === 'sending') {
        const bar = el('div', 'bar');
        const fill = el('i', '');
        fill.style.width = `${Math.round(t.progress * 100)}%`;
        bar.append(fill);
        box.append(bar);
      }
      box.append(el('span', 'label', thumbLabel(t)));
      const p = usedPaths.get(t.id);
      if (p) box.title = PATH_TEXT[p];
      if (t.retake) {
        const b = el('button', 'retake', 'Retake');
        b.dataset.act = 'retake';
        box.append(b);
      } else if (t.uploadFailed) {
        const b = el('button', 'retake', 'Send again');
        b.dataset.act = 'resend';
        box.append(b);
      }
      thumbsEl.append(box);
    }
    thumbsEl.scrollLeft = thumbsEl.scrollWidth;
    renderInfo();
    doneBtn.disabled = thumbs.length === 0;
  }

  thumbsEl.onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
    const id = Number((b?.closest('.thumb') as HTMLElement | null)?.dataset.id);
    if (!b || !id) return;
    if (b.dataset.act === 'retake') {
      thumbs = removeThumb(thumbs, id);
      dataUrls.delete(id);
      renderThumbs();
      notice('Retake: put the whole sheet in view and shoot again.');
    } else if (b.dataset.act === 'resend') {
      const p = keep.get(id);
      if (!p) return;
      keep.delete(id);
      thumbs = addThumb(thumbs.filter((t) => t.id !== id), { id, name: p.name, size: p.blob.size, path: usedPaths.get(id) });
      renderThumbs();
      enqueue(p);
    }
  };

  /* -------------------------------------------- upload -------------------------------------------- */

  function enqueue(p: Pending): void {
    queue.push(p);
    startNext();
  }

  function startNext(): void {
    if (current || !queue.length) return;
    const p = (current = queue.shift()!);
    void p.blob.arrayBuffer().then((buf) => {
      if (current !== p) return;
      const bytes = new Uint8Array(buf);
      p.sender = new ChunkSender({
        prefix: 'scan',
        id: p.id,
        name: p.name,
        mime: p.blob.type,
        w: p.w,
        h: p.h,
        bytes,
        chunkBytes: limits.chunkBytes,
        window: limits.window,
        transport: { sendJson: (m) => env.send(m), sendChunk: (f) => env.sendBinary(f), buffered: () => env.buffered() },
        onProgress: (_s, acked, total) => {
          thumbs = setProgress(thumbs, p.id, acked / total);
          renderThumbs();
        },
        onDone: () => {
          thumbs = setSent(thumbs, p.id);
          current = null;
          renderThumbs();
          startNext();
        },
        onFail: (reason) => {
          thumbs = setUploadFailed(thumbs, p.id, reason);
          keep.set(p.id, p);
          current = null;
          renderThumbs();
          startNext();
        },
      });
      if (env.isOpen()) p.sender.start(performance.now());
    }, () => {
      thumbs = setUploadFailed(thumbs, p.id, 'The photo could not be read.');
      current = null;
      renderThumbs();
      startNext();
    });
  }

  function tick(): void {
    const s = current?.sender;
    if (s && env.isOpen()) s.tick(performance.now());
    previewIn.sweep(performance.now());
  }

  /* -------------------------------------------- capture -------------------------------------------- */

  async function startViewfinder(): Promise<void> {
    if (finder) return;
    try {
      finder = await openViewfinder(video);
    } catch (err) {
      finder = null;
      notice(`The viewfinder could not open (${(err as Error).message ?? err}). The shutter will use your phone's camera app.`);
    }
    const pick = pickCapturePath({ imageCapture: hasImageCapture(), trackMaxSide: finder?.maxSide ?? 0, noStream: !finder });
    path = pick.first;
    chain = pick.chain;
    autoBox.disabled = !canAutoCapture(path);
    if (autoBox.disabled) autoBox.checked = false;
    renderInfo();
  }

  function stopViewfinder(): void {
    closeViewfinder(finder, video);
    finder = null;
  }

  function flashNow(): void {
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 120);
    try {
      navigator.vibrate?.(25);
    } catch {
      /* no haptics */
    }
  }

  async function newId(): Promise<number> {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return (b[0] || 1) >>> 0;
  }

  async function thumbUrl(blob: Blob): Promise<string> {
    try {
      const bmp = await createImageBitmap(blob);
      const k = 120 / Math.max(bmp.width, bmp.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      return c.toDataURL('image/jpeg', 0.7);
    } catch {
      return '';
    }
  }

  /** Take one still by the first path that works, then queue its upload. */
  async function shoot(by: 'tap' | 'auto'): Promise<void> {
    if (capturing || !active) return;
    capturing = true;
    gate.shotTaken(performance.now());
    shutter.disabled = true;
    try {
      let blob: Blob | null = null;
      let used: CapturePathName = path;
      let lastErr: unknown = null;
      for (const p of chain) {
        if (by === 'auto' && !canAutoCapture(p)) continue;
        try {
          if (p === 'takePhoto' && finder) blob = await captureTakePhoto(finder);
          else if (p === 'grabFrame' && finder) blob = await captureGrabFrame(finder, video);
          else if (p === 'nativeCamera') {
            stopViewfinder(); // free the camera for the phone's own camera app
            const f = await captureNativeCamera(fileInput);
            await startViewfinder().catch(() => undefined);
            if (!f) return; // came back without a photo
            blob = f;
          }
          if (blob) {
            used = p;
            break;
          }
        } catch (err) {
          lastErr = err;
          notice(`${PATH_TEXT[p]} did not work; trying the next way.`);
        }
      }
      if (!blob) throw lastErr ?? new Error('No photo was taken.');
      flashNow();
      const prepared = await prepareStill(blob);
      const id = await newId();
      const name = `phone-${id.toString(36)}.${prepared.blob.type === 'image/png' ? 'png' : prepared.blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      usedPaths.set(id, used);
      const url = await thumbUrl(prepared.blob);
      if (url) dataUrls.set(id, url);
      thumbs = addThumb(thumbs, { id, name, size: prepared.blob.size, path: used });
      renderThumbs();
      enqueue({ id, blob: prepared.blob, name, w: prepared.w, h: prepared.h, sender: null });
    } catch (err) {
      notice(`The photo could not be taken: ${(err as Error).message ?? err}`);
    } finally {
      capturing = false;
      shutter.disabled = false;
    }
  }

  /* --------------------------------------- live corner check ---------------------------------------- */

  function check(): void {
    if (!active || capturing || previewPane.hidden === false || !video.videoWidth) return;
    const { w, h } = checkSize(video.videoWidth, video.videoHeight, CHECK_SIDE);
    checkCanvas.width = w;
    checkCanvas.height = h;
    const ctx = checkCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    const now = performance.now();
    let r: CheckResult;
    try {
      r = checkFrame(rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h);
    } catch {
      return;
    }
    last = r;
    const steadyMs = steady.update(r.quad, now, w / h);
    renderTicks(r);
    const hint = markerHint(r, steadyMs, autoBox.checked);
    hintEl.textContent = hint.text;
    hintEl.dataset.tone = hint.tone;
    if (autoBox.checked && gate.update(steadyMs, !!r.quad, now)) void shoot('auto');
  }

  /* --------------------------------------------- preview --------------------------------------------- */

  let sprite: ImageBitmap | null = null;
  let meta: PreviewMeta | null = null;
  let playing = true;
  let startedAt = 0;
  let startFrame = 0;
  let shown = -1;
  let raf = 0;

  function drawFrame(i: number): void {
    if (!sprite || !meta) return;
    const r = spriteRect(meta, i);
    if (previewCanvas.width !== r.sw || previewCanvas.height !== r.sh) {
      previewCanvas.width = r.sw;
      previewCanvas.height = r.sh;
    }
    previewCanvas.getContext('2d')!.drawImage(sprite, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
    counterEl.textContent = counterText(meta, i);
    previewNote.textContent = isMissingFrame(meta, i) ? 'This frame is missing: it shows the previous drawing.' : '';
    scrub.value = String(i);
    shown = i;
  }

  function loop(): void {
    cancelAnimationFrame(raf);
    if (!meta || previewPane.hidden) return;
    if (playing) {
      const i = frameAt(performance.now() - startedAt, meta.fps, meta.count, startFrame);
      if (i !== shown) drawFrame(i);
    }
    raf = requestAnimationFrame(loop);
  }

  function setPlaying(on: boolean): void {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    if (on) {
      startedAt = performance.now();
      startFrame = Math.max(0, shown);
    }
  }
  playBtn.onclick = () => setPlaying(!playing);
  scrub.oninput = () => {
    setPlaying(false);
    drawFrame(Number(scrub.value));
  };

  function renderMissing(): void {
    missingEl.textContent = '';
    const lines = summary ? missingLines(summary) : meta ? missingLines({ sheets: 0, missingSheets: meta.missingSheets, missingFrames: meta.missingFrames }) : [];
    if (!lines.length && (summary || meta)) lines.push('Every sheet is scanned.');
    for (const l of lines) missingEl.append(el('li', '', l));
  }

  function showPreviewPane(on: boolean): void {
    previewPane.hidden = !on;
    if (on) {
      stopCheck();
      renderMissing();
      loop();
    } else {
      cancelAnimationFrame(raf);
      startCheck();
    }
  }

  const previewIn = new TransferReceiver({
    prefix: 'preview',
    limits: PREVIEW_LIMITS,
    allowed: ['image/jpeg'],
    send: (m) => env.send(m),
    checkBegin: (b) => (parsePreviewMeta(b) ? null : 'The preview description is not valid.'),
    onComplete: (done) => {
      const m = parsePreviewMeta(done.begin);
      if (!m) return;
      void createImageBitmap(new Blob([done.bytes as BlobPart], { type: 'image/jpeg' })).then((bmp) => {
        sprite?.close();
        sprite = bmp;
        meta = m;
        scrub.max = String(Math.max(0, m.count - 1));
        shown = -1;
        previewIn.forget(done.id);
        setPlaying(true);
        drawFrame(0);
        renderMissing();
        if (!previewPane.hidden) loop();
        doneBtn.textContent = 'Preview';
      }, () => undefined);
    },
  });

  backBtn.onclick = () => showPreviewPane(false);
  doneBtn.onclick = () => {
    env.send({ type: 'scan-done' });
    showPreviewPane(true);
    if (!meta) previewNote.textContent = 'Waiting for the preview from your computer…';
  };

  /* ------------------------------------------- lifecycle ------------------------------------------- */

  function startCheck(): void {
    stopCheck();
    if (!active || !finder) return;
    checkTimer = setInterval(check, 250); // about 4 checks per second
  }
  function stopCheck(): void {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
    renderTicks(null);
  }

  shutter.onclick = () => void shoot('tap');

  return {
    async enter(): Promise<void> {
      active = true;
      root.hidden = false;
      document.body.classList.add('scanning');
      renderThumbs();
      await startViewfinder();
      showPreviewPane(false);
      startCheck();
      tickTimer ??= setInterval(tick, 150);
    },
    leave(): void {
      active = false;
      root.hidden = true;
      document.body.classList.remove('scanning');
      stopCheck();
      stopViewfinder();
      cancelAnimationFrame(raf);
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
    },
    /** Page hidden / shown again (the camera must not stay open behind another app). */
    async visibility(visible: boolean): Promise<void> {
      if (!active) return;
      if (!visible) {
        stopCheck();
        stopViewfinder();
      } else {
        await startViewfinder();
        if (previewPane.hidden) startCheck();
      }
    },
    /** The socket opened (again): resume an upload in progress, the computer says where it is. */
    onOpen(): void {
      current?.sender?.start(performance.now());
    },
    onClose(): void {
      current?.sender?.pause();
    },
    /** A JSON message from the computer. Returns true when it belonged to scan mode. */
    onMessage(msg: { type?: string }): boolean {
      const t = msg.type ?? '';
      const now = performance.now();
      if (t === 'scan-ready') {
        const r = parseScanReady(msg);
        if (r) {
          limits = { chunkBytes: r.limits.chunkBytes, window: r.limits.window };
          if (r.fps) projectFps = r.fps;
        }
        return true;
      }
      if (t === 'scan-status') {
        const s = parseScanStatus(msg);
        if (s) {
          thumbs = applyStatus(thumbs, s);
          renderThumbs();
        }
        return true;
      }
      if (t === 'scan-summary') {
        const s = parseScanSummary(msg);
        if (s) {
          summary = s;
          renderInfo();
          renderMissing();
        }
        return true;
      }
      if (t.startsWith('scan-') && current?.sender) {
        current.sender.onMessage(msg as Record<string, unknown>, now);
        current.sender.pump();
        return true;
      }
      if (t.startsWith('preview-')) {
        previewIn.handleJson(msg, now);
        return true;
      }
      return false;
    },
    /** A binary frame from the computer: a preview chunk. */
    onBinary(data: ArrayBuffer): boolean {
      const f = parseChunkFrame(data);
      if (!f || f.kind !== FRAME_PREVIEW) return false;
      previewIn.handleChunk(f, performance.now());
      return true;
    },
    get fps(): number {
      return projectFps;
    },
    get lastCheck(): CheckResult | null {
      return last;
    },
  };
}

export type ScanMode = ReturnType<typeof createScanMode>;
