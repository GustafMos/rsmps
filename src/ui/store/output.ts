/**
 * Output window (performance mode): a second, chrome-less window that shows only the picture of the viewer, for a projector or a second monitor.
 *
 * HOW THE PICTURE GETS THERE: `canvas.captureStream()` of the player's canvas into a `<video>` in the popup. The browser's compositor moves the
 * frames, so there is no JavaScript per frame and no GPU read-back, and a frame is only sent when the player drew one. The cost is about one
 * extra frame of latency. If the capture gives no picture within 1.5 s (a browser that cannot capture a WebGPU canvas) it falls back to
 * "copy": a 2D canvas in the popup that the main window draws into every animation frame with drawImage (no extra latency, but it costs a
 * frame copy and needs the main window to stay visible, not minimised).
 *
 * WHAT IS SHOWN: whatever the player renders, so the playback proxy (preview scale) applies; stop playback and press Full res, or lower the
 * proxy, for the sharpest picture. Overlays of the viewer (compare, magnifier, grid) are separate elements and never appear.
 */
import { createStore, type Store } from './createStore';

export type OutputFit = 'fit' | 'fill' | 'native';

export interface OutputOpts {
  fit: OutputFit;
  /** Nearest-neighbour scaling (pixel art). */
  sharp: boolean;
  /** CSS colour behind the picture. */
  bg: string;
  /** No on-screen hint at all (the cursor still hides after 2 s). */
  clean: boolean;
  /** Desktop app only: which display to open on ('auto' = the first display that is not the main window's). */
  display: 'auto' | '1' | '2' | '3';
}

export interface OutputUi {
  open: boolean;
  blackout: boolean;
  freeze: boolean;
  method: 'stream' | 'copy' | null;
  opts: OutputOpts;
}

export const WINDOW_NAME = 'rsmps-output';
const KEY = 'rsmps.output.opts';
export const DEFAULT_OPTS: OutputOpts = { fit: 'fit', sharp: true, bg: '#000000', clean: false, display: 'auto' };

function loadOpts(): OutputOpts {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const o = raw as Partial<OutputOpts>;
      return {
        fit: o.fit === 'fill' || o.fit === 'native' ? o.fit : 'fit',
        sharp: o.sharp !== false,
        bg: typeof o.bg === 'string' && /^#[0-9a-f]{6}$/i.test(o.bg) ? o.bg : DEFAULT_OPTS.bg,
        clean: o.clean === true,
        display: o.display === '1' || o.display === '2' || o.display === '3' ? o.display : 'auto',
      };
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_OPTS };
}

/** The HTML of the output window. Pure string so it can be tested. */
export function outputHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>RSMPS Output</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#000;color:#ddd;font:13px system-ui,sans-serif}
#stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.pic{display:block;max-width:none}
#black{position:fixed;inset:0;background:#000;display:none}
#hint{position:fixed;left:12px;bottom:12px;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.65);transition:opacity .4s}
</style></head><body><div id="stage"><video id="v" class="pic" autoplay muted playsinline></video><canvas id="c" class="pic" style="display:none"></canvas></div><div id="black"></div>
<div id="hint">F or double-click: full screen &nbsp; B: blackout &nbsp; Space: freeze &nbsp; 1 fit &nbsp; 2 fill &nbsp; 3 pixels 1:1</div></body></html>`;
}

export class OutputController {
  readonly store: Store<OutputUi> = createStore<OutputUi>({ open: false, blackout: false, freeze: false, method: null, opts: loadOpts() });
  private win: Window | null = null;
  private src: HTMLCanvasElement | null = null;
  private raf = 0;
  private hideTimer = 0;
  private checkTimer = 0;
  private cleanup: (() => void) | null = null;

  constructor(private notify: (msg: string, kind: 'ok' | 'info' | 'error') => void) {}

  /** The player's canvas in the viewer. */
  private findCanvas(): HTMLCanvasElement | null {
    return document.querySelector<HTMLCanvasElement>('canvas.rs-viewer__canvas');
  }

  isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): boolean {
    if (this.isOpen()) {
      this.win!.focus();
      return true;
    }
    const o = this.store.get().opts;
    const features = `popup=yes,width=1280,height=720,left=80,top=80,display=${o.display}`;
    let w: Window | null = null;
    try {
      w = window.open('', WINDOW_NAME, features);
    } catch {
      w = null;
    }
    if (!w) {
      this.notify('The output window was blocked. Allow pop-ups for this site (the icon at the right of the address bar), then try again.', 'error');
      return false;
    }
    this.win = w;
    const doc = w.document;
    doc.open();
    doc.write(outputHtml());
    doc.close();
    this.store.set((s) => ({ ...s, open: true, blackout: false, freeze: false }));
    this.wire(w);
    this.applyOpts();
    this.attachSource();
    this.raf = requestAnimationFrame(this.tick);
    const onUnload = () => this.close();
    window.addEventListener('beforeunload', onUnload);
    this.cleanup = () => window.removeEventListener('beforeunload', onUnload);
    return true;
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hideTimer);
    clearTimeout(this.checkTimer);
    this.cleanup?.();
    this.cleanup = null;
    const w = this.win;
    this.win = null;
    this.src = null;
    try {
      if (w && !w.closed) w.close();
    } catch {
      /* already gone */
    }
    this.store.set((s) => ({ ...s, open: false, blackout: false, freeze: false, method: null }));
  }

  setOpts(patch: Partial<OutputOpts>): void {
    const opts = { ...this.store.get().opts, ...patch };
    this.store.set((s) => ({ ...s, opts }));
    try {
      localStorage.setItem(KEY, JSON.stringify(opts));
    } catch {
      /* storage unavailable */
    }
    if (this.isOpen()) this.applyOpts();
  }

  setBlackout(on = !this.store.get().blackout): void {
    this.store.set((s) => ({ ...s, blackout: on }));
    const b = this.win?.document.getElementById('black');
    if (b) b.style.display = on ? 'block' : 'none';
  }

  setFreeze(on = !this.store.get().freeze): void {
    this.store.set((s) => ({ ...s, freeze: on }));
    const v = this.win?.document.getElementById('v') as HTMLVideoElement | null;
    if (v) {
      if (on) v.pause();
      else void v.play().catch(() => undefined);
    }
  }

  fullscreen(): void {
    const el = this.win?.document.documentElement;
    if (!el) return;
    if (this.win!.document.fullscreenElement) void this.win!.document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => this.notify('Full screen was refused. Click inside the output window and press F again.', 'info'));
  }

  /* ------------------------------------------------------------ internals */

  private wire(w: Window): void {
    const d = w.document;
    const showCursor = () => {
      d.body.style.cursor = '';
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => (d.body.style.cursor = 'none'), 2000);
    };
    d.addEventListener('mousemove', showCursor);
    showCursor();
    d.addEventListener('dblclick', () => this.fullscreen());
    d.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'f') this.fullscreen();
      else if (k === 'b') this.setBlackout();
      else if (k === ' ') {
        e.preventDefault();
        this.setFreeze();
      } else if (k === '1') this.setOpts({ fit: 'fit' });
      else if (k === '2') this.setOpts({ fit: 'fill' });
      else if (k === '3') this.setOpts({ fit: 'native' });
    });
    w.addEventListener('pagehide', () => {
      if (this.win === w) this.close();
    });
    // the hint fades by itself; a clean feed never shows it
    window.setTimeout(() => {
      const h = d.getElementById('hint');
      if (h) h.style.opacity = '0';
    }, 5000);
  }

  private applyOpts(): void {
    const d = this.win?.document;
    if (!d) return;
    const o = this.store.get().opts;
    d.body.style.background = o.bg;
    d.documentElement.style.background = o.bg;
    const hint = d.getElementById('hint');
    if (hint) hint.style.display = o.clean ? 'none' : 'block';
    for (const id of ['v', 'c']) {
      const el = d.getElementById(id) as HTMLElement | null;
      if (!el) continue;
      el.style.imageRendering = o.sharp ? 'pixelated' : 'auto';
      this.sizePicture(el, o);
    }
  }

  private sizePicture(el: HTMLElement, o: OutputOpts): void {
    const v = el as HTMLVideoElement;
    const nw = (v as { videoWidth?: number }).videoWidth || (el as HTMLCanvasElement).width || 0;
    const nh = (v as { videoHeight?: number }).videoHeight || (el as HTMLCanvasElement).height || 0;
    el.style.objectFit = o.fit === 'fill' ? 'cover' : 'contain';
    if (o.fit === 'native' && nw && nh) {
      const dpr = this.win?.devicePixelRatio || 1;
      el.style.width = `${nw / dpr}px`;
      el.style.height = `${nh / dpr}px`;
    } else {
      el.style.width = '100vw';
      el.style.height = '100vh';
    }
  }

  /** (Re)connect the popup to the player's current canvas; called when the canvas element changes. */
  private attachSource(): void {
    const src = this.findCanvas();
    this.src = src;
    const d = this.win?.document;
    if (!d || !src) return;
    const v = d.getElementById('v') as HTMLVideoElement;
    const c = d.getElementById('c') as HTMLCanvasElement;
    clearTimeout(this.checkTimer);
    const useCopy = () => {
      v.style.display = 'none';
      c.style.display = 'block';
      v.srcObject = null;
      this.store.set((s) => ({ ...s, method: 'copy' }));
      this.applyOpts();
    };
    try {
      const stream = (src as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.();
      if (!stream) throw new Error('no captureStream');
      v.style.display = 'block';
      c.style.display = 'none';
      v.srcObject = stream;
      void v.play().catch(() => undefined);
      this.store.set((s) => ({ ...s, method: 'stream' }));
      this.checkTimer = window.setTimeout(() => {
        if (this.isOpen() && this.store.get().method === 'stream' && !v.videoWidth) useCopy();
      }, 1500);
      v.addEventListener('resize', () => this.applyOpts());
    } catch {
      useCopy();
    }
  }

  private tick = (): void => {
    if (!this.isOpen()) {
      if (this.win) this.close();
      return;
    }
    const ui = this.store.get();
    const cur = this.findCanvas();
    if (cur !== this.src) this.attachSource();
    if (ui.method === 'copy' && !ui.freeze && this.src) {
      const c = this.win!.document.getElementById('c') as HTMLCanvasElement | null;
      if (c) {
        if (c.width !== this.src.width || c.height !== this.src.height) {
          c.width = this.src.width;
          c.height = this.src.height;
          this.applyOpts();
        }
        try {
          c.getContext('2d')?.drawImage(this.src, 0, 0);
        } catch {
          /* the canvas had no frame yet */
        }
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
