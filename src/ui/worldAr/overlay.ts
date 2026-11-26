/**
 * What is on the screen over the camera picture in the World AR view: a hint, four buttons (Place, Reset, Record, Exit), a slim Height strip on the right edge (drag it up or down to raise or lower the object, double tap to put it back on the surface) and a line of
 * numbers for reporting problems. Plain DOM, not React: the browser lifts this one element out of the page and shows it full-screen
 * over the camera (the WebXR "DOM overlay"), so it must stand on its own, with its own styles.
 *
 * Fingers anywhere but on the buttons go to the gesture reader (tap, drag, twist, pinch). Where the browser does not grant the
 * overlay, none of this is visible; the AR view then works with taps only and is left with the phone's Back button.
 */
import { formatElapsed } from '../../io/live-record';
import type { WorldArHandle, WorldArViewState } from '../../io/world-ar/controller';
import { GestureReader } from '../../io/world-ar/placement';

export interface ArOverlay {
  root: HTMLElement;
  /** Connect the buttons and fingers to an opened view. */
  attach(handle: WorldArHandle): void;
  update(state: WorldArViewState): void;
  remove(): void;
}

const BTN = 'font:600 15px system-ui,sans-serif;color:#fff;background:rgba(20,24,32,.72);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:12px 16px;min-width:64px;touch-action:manipulation;';

export function createArOverlay(doc: Document = document): ArOverlay {
  const root = doc.createElement('div');
  // hidden in the page; the browser shows it by itself as the overlay of the session
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;user-select:none;-webkit-user-select:none;touch-action:none;color:#fff;font:14px/1.4 system-ui,sans-serif;';
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'AR view');

  const touch = doc.createElement('div');
  touch.style.cssText = 'position:absolute;inset:0;touch-action:none;';
  const hint = doc.createElement('div');
  hint.style.cssText = 'position:absolute;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 40px);padding:10px 12px;border-radius:12px;background:rgba(20,24,32,.72);text-align:center;pointer-events:none;';
  hint.setAttribute('role', 'status');
  const badge = doc.createElement('div');
  badge.textContent = 'Experimental';
  badge.style.cssText = 'position:absolute;left:12px;bottom:calc(max(16px,env(safe-area-inset-bottom)) + 62px);font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(180,120,0,.8);pointer-events:none;';
  const stats = doc.createElement('div');
  stats.style.cssText = 'position:absolute;right:12px;bottom:calc(max(16px,env(safe-area-inset-bottom)) + 62px);font:11px ui-monospace,monospace;opacity:.8;text-shadow:0 1px 2px #000;pointer-events:none;text-align:right;white-space:pre;';
  const bar = doc.createElement('div');
  bar.style.cssText = 'position:absolute;left:0;right:0;bottom:max(16px,env(safe-area-inset-bottom));display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:0 8px;';
  const button = (label: string, title: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = BTN;
    // a press on a button is not a tap on the room
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) b.addEventListener(ev, (e) => e.stopPropagation());
    bar.appendChild(b);
    return b;
  };
  const place = button('Place', 'Put it on the ring');
  const reset = button('Reset', 'Pick it up and choose another spot');
  const record = button('Record', 'Record the movement (and the camera picture where the browser hands it over)');
  const exit = button('Exit', 'Leave the AR view');
  // Two slim, full-reach strips (at least 44 px wide, clear of the notch and the gesture bar): Height on the right edge, Zoom on the left.
  // Each has its own finger, never a tap or drag on the room. Travel up the screen raises / zooms in; a quick double tap resets.
  const makeStrip = (side: 'left' | 'right', name: string, title: string, move: (dy: number) => void, reset: () => void) => {
    const el = doc.createElement('div');
    el.style.cssText = `position:absolute;${side}:max(8px,env(safe-area-inset-${side}));top:28%;bottom:calc(max(16px,env(safe-area-inset-bottom)) + 120px);width:52px;display:none;flex-direction:column;align-items:center;justify-content:space-between;border-radius:26px;background:rgba(20,24,32,.55);border:1px solid rgba(255,255,255,.35);touch-action:none;font:600 12px system-ui,sans-serif;`;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', name);
    el.title = title;
    const up = doc.createElement('div');
    up.textContent = '▲';
    up.style.cssText = 'padding-top:10px;pointer-events:none;';
    const label = doc.createElement('div');
    label.style.cssText = 'pointer-events:none;writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:.05em;white-space:nowrap;';
    label.textContent = name;
    const down = doc.createElement('div');
    down.textContent = '▼';
    down.style.cssText = 'padding-bottom:10px;pointer-events:none;';
    el.append(up, label, down);
    let y: number | null = null;
    let id = -1;
    let lastTap = -1e9;
    let moved = 0;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (y !== null) return;
      y = e.clientY;
      id = e.pointerId;
      moved = 0;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* the moves still arrive while the finger stays on the strip */
      }
    });
    el.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      if (y === null || e.pointerId !== id) return;
      const dy = y - e.clientY;
      y = e.clientY;
      moved += Math.abs(dy);
      if (dy) move(dy);
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      e.stopPropagation();
      if (y === null || e.pointerId !== id) return;
      y = null;
      if (cancelled || moved >= 8) return;
      if (e.timeStamp - lastTap <= 400) {
        reset();
        lastTap = -1e9;
      } else lastTap = e.timeStamp;
    };
    el.addEventListener('pointerup', (e) => end(e, false));
    el.addEventListener('pointercancel', (e) => end(e, true));
    // the number shows briefly while it changes, then the word again
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (text: string) => {
      label.textContent = text;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        label.textContent = name;
        timer = null;
      }, 1500);
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
    };
    return { el, show, stop };
  };
  const heightStrip = makeStrip('right', 'Height', 'Drag up or down to raise or lower it. Double tap to put it back on the surface.', (dy) => handle?.gesture({ type: 'lift', dy }), () => handle?.gesture({ type: 'lift-reset' }));
  const zoomStrip = makeStrip('left', 'Zoom', 'Drag up to zoom in, down to zoom out (1x to 4x). Double tap to go back to 1x. The recording keeps the full picture.', (dy) => handle?.gesture({ type: 'zoom', dy }), () => handle?.gesture({ type: 'zoom-reset' }));
  const strip = heightStrip.el;
  root.append(touch, hint, badge, stats, strip, zoomStrip.el, bar);
  doc.body.appendChild(root);

  let handle: WorldArHandle | null = null;
  const reader = new GestureReader();
  const send = (list: ReturnType<GestureReader['down']>) => {
    for (const g of list) handle?.gesture(g);
  };
  touch.addEventListener('pointerdown', (e) => {
    try {
      touch.setPointerCapture(e.pointerId); // a finger that slides onto a button keeps dragging the object
    } catch {
      /* not capturable: the moves still arrive while it stays on the layer */
    }
    send(reader.down(e.pointerId, e.clientX, e.clientY, e.timeStamp));
  });
  touch.addEventListener('pointermove', (e) => send(reader.move(e.pointerId, e.clientX, e.clientY)));
  touch.addEventListener('pointerup', (e) => send(reader.up(e.pointerId, e.timeStamp)));
  touch.addEventListener('pointercancel', (e) => send(reader.cancel(e.pointerId)));
  // The session would also report every tap as its own "select". The page handles the fingers itself, so that one is switched off
  // for the whole overlay (the DOM Overlays module's `beforexrselect`).
  root.addEventListener('beforexrselect', (e) => e.preventDefault());
  let shownHeight = 0;
  let shownZoom = 1;
  const showHeight = (metres: number) => heightStrip.show(`${metres >= 0 ? '+' : '-'}${Math.round(Math.abs(metres) * 100)} cm`);
  place.addEventListener('click', () => handle?.place());
  reset.addEventListener('click', () => handle?.reset());
  record.addEventListener('click', () => handle?.toggleRecord());
  exit.addEventListener('click', () => void handle?.close());

  return {
    root,
    attach(h) {
      handle = h;
      root.style.display = 'block';
    },
    update(s) {
      const zoom = s.zoom ?? 1;
      hint.textContent = s.error ?? s.hint;
      place.disabled = s.phase !== 'aiming';
      place.style.opacity = place.disabled ? '0.4' : '1';
      reset.disabled = s.phase !== 'placed';
      reset.style.opacity = reset.disabled ? '0.4' : '1';
      strip.style.display = s.phase === 'placed' ? 'flex' : 'none';
      strip.setAttribute('aria-valuenow', String(Math.round(s.height * 100)));
      // Zoom needs the camera picture (the page draws it larger itself); without it the strip is not shown and the readout says why
      zoomStrip.el.style.display = s.zoomAvailable === true ? 'flex' : 'none';
      zoomStrip.el.setAttribute('aria-valuenow', zoom.toFixed(1));
      if (Math.abs(zoom - shownZoom) > 1e-3) {
        shownZoom = zoom;
        zoomStrip.show(`${zoom.toFixed(1)}x`);
      }
      if (Math.abs(s.height - shownHeight) > 1e-4) {
        shownHeight = s.height;
        showHeight(s.height); // the number shows briefly while it changes, then the word again
      }
      record.textContent = s.saving ? 'Saving' : s.recording ? `Stop ${formatElapsed(s.recSeconds)}` : 'Record';
      record.disabled = s.saving;
      record.style.background = s.recording ? 'rgba(200,30,30,.85)' : 'rgba(20,24,32,.72)';
      // numbers worth reading out when something is wrong: camera frames per second, pictures of the object per second and what one
      // costs, how the picture gets into the view, and which extras this phone granted
      const f = s.features;
      const rate = s.recordFps !== s.askedFps ? `${s.recording ? 'recording' : 'will record'} at ${s.recordFps} per second: the phone's AR camera gives ${s.cameraFps}, ${s.askedFps} was asked` : s.recording ? `recording at ${s.recordFps} per second` : '';
      stats.textContent = [
        `${s.fps} fps${zoom !== 1 ? ` · zoom ${zoom.toFixed(1)}x` : ''} · object ${s.pictureFps}/s`,
        ...(rate ? [rate] : []),
        ...(f.cameraAccess ? [] : ['no zoom: this phone does not hand over the camera picture']),
        `render ${s.renderMs} ms · copy ${s.copyMs} ms (${s.route})`,
        `${f.hitTest ? 'surfaces' : 'NO surfaces'} · ${s.anchored ? 'anchored' : f.anchors ? 'anchor pending' : 'no anchors'} · ${f.cameraAccess ? 'camera clip' : 'motion only'}`,
      ].join('\n');
    },
    remove() {
      heightStrip.stop();
      zoomStrip.stop();
      handle = null;
      root.remove();
    },
  };
}
