/**
 * The phone page's "Motion" section: orientation (quaternion), rotation rate, acceleration, a multi-touch pad, compass, optional location
 * and optional WebXR position. Everything goes to the computer as small JSON frames on the existing pairing WebSocket (see
 * motion-protocol.ts); nothing else is opened. Streaming stops while the page is hidden. Nothing is sent until the user presses Start.
 *
 * Needs a real phone to confirm: the permission prompt on iOS, the sensor values themselves and the AR toggle. The pure parts are tested.
 */
import { arSupported, startAr, type ArHandle } from './motion-ar';
import { GeoOrigin, RateGate, buildMotionPacket, iosAlphaOffset, type RawSensors } from './motion-pure';
import { MOTION_MAX_HZ, MOTION_VERSION, r3, type CapsMsg, type PhoneMotionMessage } from './motion-protocol';
import { TapDetector, newGesture, updateGesture, type PadTouch } from './touch-gestures';

interface Env {
  send(msg: PhoneMotionMessage): void;
  /** Dev only (`?fake=1`): synthesise a moving phone instead of reading sensors. */
  fake: boolean;
}

type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> };
const DOE = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined) as (PermissionApi & typeof DeviceOrientationEvent) | undefined;
const DME = (typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : undefined) as (PermissionApi & typeof DeviceMotionEvent) | undefined;
const isIos = (): boolean => typeof DOE?.requestPermission === 'function';

export function createMotion(env: Env) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const box = $('motion');
  const startBtn = $<HTMLButtonElement>('motionStart');
  const opts = $('motionOpts');
  const touchBox = $<HTMLInputElement>('optTouch');
  const geoBox = $<HTMLInputElement>('optGeo');
  const arRow = $('optArRow');
  const arBox = $<HTMLInputElement>('optAr');
  const rateSel = $<HTMLSelectElement>('motionRate');
  const recenterBtn = $<HTMLButtonElement>('recenter');
  const dot = $('motionDot');
  const note = $('motionNote');
  const pad = $('pad');

  const raw: RawSensors = { alpha: null, beta: null, gamma: null, absolute: false, heading: null, screenAngle: 0, rate: null, accel: null, accelG: null };
  const gate = new RateGate(MOTION_MAX_HZ);
  const geoOrigin = new GeoOrigin();
  let on = { motion: false, touch: false, geo: false, ar: false };
  let arSupport = false;
  let ar: ArHandle | null = null;
  let geoWatch: number | null = null;
  let raf = 0;
  let iosOffset: number | null = null;
  let lastEvent = 0;
  let sentAny = 0;
  let dirtyTouch = false;
  let hasOrientation = false;
  let hasMotion = false;
  let hasAbsolute = false;

  const caps = (): CapsMsg => ({
    type: 'caps',
    v: MOTION_VERSION,
    orientation: env.fake || (typeof window !== 'undefined' && 'DeviceOrientationEvent' in window),
    motion: env.fake || (typeof window !== 'undefined' && 'DeviceMotionEvent' in window),
    absolute: env.fake || hasAbsolute || isIos() || 'ondeviceorientationabsolute' in window,
    geo: 'geolocation' in navigator,
    ar: arSupport,
    touch: true,
    ios: isIos(),
    hz: gate.hz,
    on: { ...on },
  });
  const sendCaps = () => env.send(caps());

  function showDot(): void {
    const live = on.motion && sentAny > 0 && performance.now() - sentAny < 1500;
    dot.className = live ? 'live' : on.motion ? 'idle' : '';
    dot.title = live ? 'Sending motion' : on.motion ? 'Started, waiting for sensor data' : 'Motion is off';
  }

  /* ------------------------------------------- sensors ------------------------------------------- */

  const screenAngle = (): number => ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) + 360) % 360;

  function onOrientation(e: DeviceOrientationEvent, absolute: boolean): void {
    if (e.alpha === null && e.beta === null) return;
    // prefer the absolute event once it has delivered
    if (!absolute && hasAbsolute) return;
    if (absolute) hasAbsolute = true;
    hasOrientation = true;
    raw.alpha = e.alpha;
    raw.beta = e.beta;
    raw.gamma = e.gamma;
    raw.absolute = absolute || e.absolute === true;
    const h = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    raw.heading = typeof h === 'number' && Number.isFinite(h) && h >= 0 ? h : null;
    if (raw.heading !== null && !raw.absolute && e.alpha !== null && e.beta !== null) {
      iosOffset = iosAlphaOffset(e.alpha, raw.heading, iosOffset);
    }
    raw.screenAngle = screenAngle();
    lastEvent = performance.now();
  }
  const onOrientationEvent = (e: DeviceOrientationEvent) => onOrientation(e, false);
  const onAbsoluteEvent = (e: DeviceOrientationEvent) => onOrientation(e, true);
  function onMotion(e: DeviceMotionEvent): void {
    hasMotion = true;
    raw.rate = e.rotationRate ? { alpha: e.rotationRate.alpha, beta: e.rotationRate.beta, gamma: e.rotationRate.gamma } : null;
    raw.accel = e.acceleration ? { x: e.acceleration.x, y: e.acceleration.y, z: e.acceleration.z } : null;
    raw.accelG = e.accelerationIncludingGravity ? { x: e.accelerationIncludingGravity.x, y: e.accelerationIncludingGravity.y, z: e.accelerationIncludingGravity.z } : null;
    lastEvent = performance.now();
  }

  let fakeT0 = 0;
  function fakeSensors(): void {
    const t = (performance.now() - fakeT0) / 1000;
    raw.alpha = (t * 20) % 360;
    raw.beta = 90 + 25 * Math.sin(t * 1.3);
    raw.gamma = 20 * Math.sin(t * 0.7);
    raw.absolute = true;
    raw.screenAngle = 0;
    raw.rate = { alpha: 20, beta: 32 * Math.cos(t * 1.3), gamma: 14 * Math.cos(t * 0.7) };
    raw.accel = { x: 0.2 * Math.sin(t * 5), y: 0.1, z: 0 };
    raw.accelG = { x: 0, y: 9.8, z: 0 };
    lastEvent = performance.now();
  }

  /* ------------------------------------------- the loop -------------------------------------------- */

  function tick(): void {
    raf = 0;
    if (document.visibilityState !== 'visible') return; // resumed by visibilitychange
    const now = performance.now();
    if (on.motion && gate.ready(now)) {
      if (env.fake) fakeSensors();
      if (lastEvent > 0) {
        env.send(buildMotionPacket(raw, now, iosOffset));
        sentAny = now;
        showDot();
      }
    }
    if (dirtyTouch && on.touch) flushTouch(now);
    if (on.motion || on.touch || on.ar) raf = requestAnimationFrame(tick);
  }
  const ensureLoop = () => {
    if (!raf && (on.motion || on.touch)) raf = requestAnimationFrame(tick);
  };

  /* ------------------------------------------- touch pad -------------------------------------------- */

  const slots = new Map<number, number>(); // pointerId -> small id 0..4
  const pts = new Map<number, PadTouch>();
  const gesture = newGesture();
  const taps = new TapDetector();
  let sawMulti = false;
  const dots = new Map<number, HTMLElement>();

  function slotFor(pointerId: number): number | null {
    const have = slots.get(pointerId);
    if (have !== undefined) return have;
    for (let i = 0; i < 5; i++) {
      if (![...slots.values()].includes(i)) {
        slots.set(pointerId, i);
        return i;
      }
    }
    return null;
  }
  function norm(e: PointerEvent): PadTouch | null {
    const id = slotFor(e.pointerId);
    if (id === null) return null;
    const r = pad.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
    return { id, x, y, force: e.pointerType === 'touch' && e.pressure === 0.5 ? 0 : e.pressure };
  }
  function drawDots(): void {
    for (const [id, el] of dots) if (!pts.has(id)) (el.remove(), dots.delete(id));
    for (const p of pts.values()) {
      let el = dots.get(p.id);
      if (!el) {
        el = document.createElement('i');
        pad.appendChild(el);
        dots.set(p.id, el);
      }
      el.style.left = `${p.x * 100}%`;
      el.style.top = `${p.y * 100}%`;
    }
  }
  function flushTouch(now: number): void {
    dirtyTouch = false;
    const r = pad.getBoundingClientRect();
    const g = updateGesture(gesture, [...pts.values()], r.width / Math.max(1, r.height));
    env.send({
      type: 'touch',
      t: Math.round(now * 10) / 10,
      p: [...pts.values()].slice(0, 5).map((p) => [p.id, r3(p.x), r3(p.y), Math.round(p.force * 100) / 100]),
      ps: r3(g.pinch),
      tw: Math.round(g.twist * 10) / 10,
      pn: [r3(g.pan[0]), r3(g.pan[1])],
      g: gesture.gid,
    });
    drawDots();
  }
  function sendEvent(e: 'recenter' | 'tap' | 'doubletap'): void {
    env.send({ type: 'mevent', t: Math.round(performance.now() * 10) / 10, e });
  }
  pad.addEventListener('pointerdown', (e) => {
    const p = norm(e);
    if (!p) return;
    pad.setPointerCapture?.(e.pointerId);
    pts.set(p.id, p);
    if (pts.size > 1) sawMulti = true;
    taps.start(p.id, performance.now(), p.x, p.y);
    dirtyTouch = true;
    ensureLoop();
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    const p = norm(e);
    if (!p || !pts.has(p.id)) return;
    pts.set(p.id, p);
    dirtyTouch = true;
    e.preventDefault();
  });
  const up = (e: PointerEvent) => {
    const id = slots.get(e.pointerId);
    if (id === undefined) return;
    const p = pts.get(id);
    pts.delete(id);
    slots.delete(e.pointerId);
    if (p) {
      const ev = e.type === 'pointercancel' ? [] : taps.end(id, performance.now(), p.x, p.y, sawMulti);
      for (const x of ev) sendEvent(x);
    } else taps.cancel(id);
    if (pts.size === 0) sawMulti = false;
    dirtyTouch = true;
    ensureLoop();
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);

  function setTouch(v: boolean): void {
    on.touch = v;
    pad.hidden = !v;
    document.body.classList.toggle('has-pad', v);
    if (!v) {
      pts.clear();
      slots.clear();
      dirtyTouch = true;
      flushTouch(performance.now()); // tells the computer all fingers are up
    }
    ensureLoop();
    sendCaps();
  }

  /* ------------------------------------------- location + AR ------------------------------------------- */

  function setGeo(v: boolean): void {
    if (v === on.geo) return;
    if (!v) {
      if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
      geoWatch = null;
      on.geo = false;
      geoOrigin.reset();
      sendCaps();
      return;
    }
    // A separate permission, asked only when the user turns this on. Positions are sent relative to the first fix, never absolute.
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const f = geoOrigin.fix(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude);
        env.send({
          type: 'geo',
          t: Math.round(performance.now() * 10) / 10,
          x: f.x,
          y: f.y,
          ...(pos.coords.speed !== null && Number.isFinite(pos.coords.speed) ? { s: r3(pos.coords.speed) } : {}),
          ...(f.alt !== undefined ? { alt: f.alt } : {}),
          acc: Math.round(pos.coords.accuracy),
        });
      },
      () => {
        geoBox.checked = false;
        setGeo(false);
        note.textContent = 'Location was refused or is not available. Allow it in the browser settings to use it.';
      },
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 },
    );
    on.geo = true;
    sendCaps();
  }

  async function setAr(v: boolean): Promise<void> {
    if (!v) {
      await ar?.stop();
      ar = null;
      on.ar = false;
      sendCaps();
      return;
    }
    try {
      const gateAr = new RateGate(gate.hz);
      ar = await startAr(
        (m) => gateAr.ready(performance.now()) && env.send(m),
        () => {
          on.ar = false;
          arBox.checked = false;
          sendCaps();
        },
      );
      on.ar = true;
    } catch (err) {
      arBox.checked = false;
      on.ar = false;
      note.textContent = `Could not start position tracking: ${String((err as Error).message ?? err)}`;
    }
    sendCaps();
  }

  /* ------------------------------------------- start / stop ------------------------------------------- */

  async function start(): Promise<void> {
    startBtn.disabled = true;
    try {
      if (!env.fake) {
        // iOS: both permission requests must start inside this click handler, before any other await.
        const asks: Promise<string>[] = [];
        if (typeof DOE?.requestPermission === 'function') asks.push(DOE.requestPermission());
        if (typeof DME?.requestPermission === 'function') asks.push(DME.requestPermission());
        const answers = await Promise.all(asks);
        if (answers.some((a) => a !== 'granted')) {
          note.textContent = 'Motion access was refused. On iPhone: Settings > Safari > Motion & Orientation Access, then reload this page.';
          startBtn.disabled = false;
          return;
        }
        if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onAbsoluteEvent as EventListener);
        window.addEventListener('deviceorientation', onOrientationEvent);
        window.addEventListener('devicemotion', onMotion);
        if (!window.isSecureContext) note.textContent = 'Motion sensors need an https page.';
      } else fakeT0 = performance.now();
      on.motion = true;
      startBtn.hidden = true;
      opts.hidden = false;
      recenterBtn.hidden = false;
      showDot();
      ensureLoop();
      sendCaps();
      // when nothing arrives within 2 s there are no sensors (desktop browser, or the permission was silently blocked)
      setTimeout(() => {
        if (on.motion && !hasOrientation && !hasMotion && !env.fake) note.textContent = 'No sensor data yet. This browser or device may not have motion sensors, or access is blocked.';
      }, 2000);
    } catch (err) {
      note.textContent = String((err as Error).message ?? err);
      startBtn.disabled = false;
    }
  }

  function stopAll(): void {
    on = { motion: false, touch: false, geo: false, ar: false };
    window.removeEventListener('deviceorientation', onOrientationEvent);
    window.removeEventListener('deviceorientationabsolute', onAbsoluteEvent as EventListener);
    window.removeEventListener('devicemotion', onMotion);
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
    void ar?.stop();
  }

  startBtn.onclick = () => void start();
  touchBox.onchange = () => setTouch(touchBox.checked);
  geoBox.onchange = () => setGeo(geoBox.checked);
  arBox.onchange = () => void setAr(arBox.checked);
  rateSel.onchange = () => {
    gate.hz = Number(rateSel.value);
    sendCaps();
  };
  recenterBtn.onclick = () => sendEvent('recenter');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      gate.reset();
      ensureLoop();
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    showDot();
  });
  setInterval(showDot, 500);

  box.hidden = false;
  note.textContent = 'Motion, touch and location go only to your own computer over this link. Location is off unless you turn it on, and is sent relative to where you started.';
  void arSupported().then((ok) => {
    arSupport = ok;
    arRow.hidden = !ok;
    sendCaps();
  });
  return {
    /** Call when the WebSocket (re)opens: the computer must learn the capabilities again. */
    onOpen: sendCaps,
    stop: stopAll,
  };
}
