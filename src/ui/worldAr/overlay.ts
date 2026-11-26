/**
 * What is on the screen over the camera picture in the World AR view: a hint, four buttons (Place, Reset, Record, Exit) and a line of
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
  hint.style.cssText = 'position:absolute;left:12px;right:12px;top:max(12px,env(safe-area-inset-top));padding:10px 12px;border-radius:12px;background:rgba(20,24,32,.72);text-align:center;pointer-events:none;';
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
  root.append(touch, hint, badge, stats, bar);
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
      hint.textContent = s.error ?? s.hint;
      place.disabled = s.phase !== 'aiming';
      place.style.opacity = place.disabled ? '0.4' : '1';
      reset.disabled = s.phase !== 'placed';
      reset.style.opacity = reset.disabled ? '0.4' : '1';
      record.textContent = s.saving ? 'Saving' : s.recording ? `Stop ${formatElapsed(s.recSeconds)}` : 'Record';
      record.disabled = s.saving;
      record.style.background = s.recording ? 'rgba(200,30,30,.85)' : 'rgba(20,24,32,.72)';
      // numbers worth reading out when something is wrong: camera frames per second, pictures of the object per second and what one
      // costs, how the picture gets into the view, and which extras this phone granted
      const f = s.features;
      stats.textContent = [
        `${s.fps} fps · object ${s.pictureFps}/s`,
        `render ${s.renderMs} ms · copy ${s.copyMs} ms (${s.route})`,
        `${f.hitTest ? 'surfaces' : 'NO surfaces'} · ${s.anchored ? 'anchored' : f.anchors ? 'anchor pending' : 'no anchors'} · ${f.cameraAccess ? 'camera clip' : 'motion only'}`,
      ].join('\n');
    },
    remove() {
      handle = null;
      root.remove();
    },
  };
}
