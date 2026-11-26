// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorldArHandle, WorldArViewState } from '../../io/world-ar/controller';
import type { Gesture } from '../../io/world-ar/placement';
import { createArOverlay } from './overlay';

type Listener = (e: Record<string, unknown>) => void;
interface El {
  style: Record<string, unknown>;
  children: El[];
  textContent: string;
  title: string;
  attrs: Record<string, string>;
  listeners: Map<string, Listener[]>;
  disabled?: boolean;
  [k: string]: unknown;
}

/** A document with just enough in it to drive the overlay's strips (the test runs without a browser). */
function stubDocument() {
  const el = (): El => {
    const e: El = { style: {}, children: [], textContent: '', title: '', attrs: {}, listeners: new Map() };
    e.setAttribute = (k: string, v: string) => void (e.attrs[k] = v);
    e.addEventListener = (type: string, cb: Listener) => void e.listeners.set(type, [...(e.listeners.get(type) ?? []), cb]);
    e.append = (...c: El[]) => void e.children.push(...c);
    e.appendChild = (c: El) => void e.children.push(c);
    e.remove = () => undefined;
    e.setPointerCapture = () => undefined;
    return e;
  };
  const all: El[] = [];
  const doc = { createElement: () => (all.push(el()), all[all.length - 1]), body: { appendChild: () => undefined } };
  return { doc: doc as unknown as Document, all };
}

const fire = (e: El, type: string, ev: Record<string, unknown>) => {
  for (const cb of e.listeners.get(type) ?? []) cb({ pointerId: 1, stopPropagation: () => undefined, preventDefault: () => undefined, ...ev });
};

function state(o: Partial<WorldArViewState> = {}): WorldArViewState {
  return { phase: 'placed', hint: '', height: 0, zoom: 1, zoomAvailable: true, recording: false, recSeconds: 0, saving: false, fps: 30, pictureFps: 20, renderMs: 5, copyMs: 2, route: 'pixels', recordFps: 30, askedFps: 30, cameraFps: 30, anchored: true, features: { hitTest: true, anchors: true, domOverlay: true, cameraAccess: true }, error: null, ...o } as unknown as WorldArViewState;
}

function setup() {
  const { doc, all } = stubDocument();
  const ov = createArOverlay(doc);
  const gestures: Gesture[] = [];
  ov.attach({ gesture: (g: Gesture) => gestures.push(g), place() {}, reset() {}, toggleRecord() {}, close: async () => undefined } as unknown as WorldArHandle);
  const strip = (name: string) => all.find((e) => e.attrs['aria-label'] === name)!;
  const stats = () => all.find((e) => typeof e.style.cssText === 'string' && (e.style.cssText as string).includes('white-space:pre'))!;
  return { ov, gestures, strip, stats, all };
}

describe('the Zoom strip of the AR overlay', () => {
  it('is a second strip on the left edge, next to the Height strip on the right', () => {
    const t = setup();
    expect((t.strip('Zoom').style.cssText as string).includes('left:')).toBe(true);
    expect((t.strip('Height').style.cssText as string).includes('right:')).toBe(true);
  });

  it('dragging up zooms in, down zooms out; the strip does not reach the room', () => {
    const t = setup();
    const z = t.strip('Zoom');
    fire(z, 'pointerdown', { clientY: 400, timeStamp: 0 });
    fire(z, 'pointermove', { clientY: 380 });
    fire(z, 'pointermove', { clientY: 395 });
    fire(z, 'pointerup', { clientY: 395, timeStamp: 50 });
    expect(t.gestures).toEqual([
      { type: 'zoom', dy: 20 },
      { type: 'zoom', dy: -15 },
    ]);
  });

  it('a double tap goes back to 1x', () => {
    const t = setup();
    const z = t.strip('Zoom');
    for (const at of [0, 200]) {
      fire(z, 'pointerdown', { clientY: 400, timeStamp: at });
      fire(z, 'pointerup', { clientY: 400, timeStamp: at + 30 });
    }
    expect(t.gestures).toEqual([{ type: 'zoom-reset' }]);
  });

  it('shows the number while it changes, hides when this phone has no camera picture, and the readout names the zoom', () => {
    const t = setup();
    t.ov.update(state({ zoom: 2.04 }));
    const z = t.strip('Zoom');
    expect(z.style.display).toBe('flex');
    expect(z.children[1].textContent).toBe('2.0x');
    expect(t.stats().textContent).toContain('zoom 2.0x');
    const t2 = setup();
    t2.ov.update(state({ zoomAvailable: false, features: { hitTest: true, anchors: true, domOverlay: true, cameraAccess: false } as never }));
    expect(t2.strip('Zoom').style.display).toBe('none');
    expect(t2.stats().textContent).toContain('no zoom');
    t.ov.remove();
    t2.ov.remove();
  });

  it('the readout says when the recording rate had to be lowered', () => {
    const t = setup();
    t.ov.update(state({ recording: true, recordFps: 30, askedFps: 60, cameraFps: 30 }));
    expect(t.stats().textContent).toContain('recording at 30 per second');
    expect(t.stats().textContent).toContain('60 was asked');
    t.ov.remove();
  });
});
