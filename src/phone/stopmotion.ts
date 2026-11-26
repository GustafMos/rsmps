/**
 * Stop motion on the phone page (mode `stopmotion`): the logic of the capture screen. No DOM here: the camera, the clock, the wake lock and
 * the socket are injected, so everything is tested with fakes. The screen itself is stopmotion-view.ts.
 *
 *  - Shutter: one still at the size the computer asked for (settings.maxSide), kept as a small copy for the onion skin and sent through
 *    `ShotSender` (stopmotion-protocol.ts). At most MAX_QUEUE pictures wait for the computer; when that is full the shutter says so and
 *    Auto shoot skips the tick instead of queueing more.
 *  - Onion skin: the last shots are known here, so the faint overlay needs no round trip.
 *  - Auto shoot: drift free, shot k is due at start + k * interval (a slow capture skips the ticks it covered, never queues), stops after
 *    `stopAfter` pictures, and keeps the screen awake. The computer can start and stop it (sm-cmd) and sees its state (sm-status).
 *  - Settings: the computer is the authority; changes made here go up as sm-set and come back as sm-settings.
 */
import { onionWeights } from '../io/stopmotion';
import { DEFAULT_SETTINGS, ShotSender, cleanPatch, isSmType, parseSettings, COMMANDS, type SmSettings, type SmStatus } from './stopmotion-protocol';
import type { Still } from './stopmotion-camera';

export interface SmDeps {
  send(msg: Record<string, unknown>): void;
  isOpen(): boolean;
  buffered(): number;
  now(): number;
  later(ms: number, fn: () => void): () => void;
  /** Screen wake lock: resolves a release function, or null where there is none. */
  wakeLock(): Promise<(() => void) | null>;
  /** One still at most `maxSide` on its longer side (0 = full size), or null. */
  still(maxSide: number): Promise<Still | null>;
  thumb(still: Still): Promise<Blob | null>;
  /** Lock / unlock exposure and focus. */
  lock(on: boolean): Promise<{ ok: boolean; note: string }>;
  /** A random page id (letters and digits). */
  newSid(): string;
}

export interface ShotView {
  n: number;
  state: 'queued' | 'stored' | 'failed';
  thumb: Blob | null;
}

export interface SmState {
  settings: SmSettings;
  /** The computer has said hello back (settings arrived). */
  linked: boolean;
  /** Shots in the project as the computer counts them, plus the ones still on the way. */
  count: number;
  unsent: number;
  progress: number | null;
  shots: ShotView[];
  auto: { running: boolean; count: number; nextAt: number };
  /** Plain words for what is going on ('' when nothing). */
  note: string;
  locked: boolean;
  taking: boolean;
  /** The computer is not answering. */
  stalled: boolean;
}

export type ShootResult = 'ok' | 'full' | 'busy' | 'failed';

const KEEP = 12;
const TICK_MS = 250;

export function createStopMotionPhone(d: SmDeps) {
  const sid = d.newSid();
  let seq = 0;
  let settings: SmSettings = { ...DEFAULT_SETTINGS };
  let linked = false;
  let serverShots = 0;
  let note = '';
  let locked = false;
  let taking = false;
  let entered = false;
  let shots: ShotView[] = [];
  let auto = { running: false, count: 0, nextAt: 0 };
  let autoStart = 0;
  let autoK = 0;
  let stopAutoTimer: (() => void) | null = null;
  let stopTicker: (() => void) | null = null;
  let stopStatus: (() => void) | null = null;
  let releaseLock: (() => void) | null = null;
  let lockWanted = false;
  let lockAsked = false;
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const l of [...listeners]) l();
    scheduleStatus();
  };

  const sender = new ShotSender(
    sid,
    { send: (m) => d.send(m), buffered: () => d.buffered(), isOpen: () => d.isOpen() },
    {
      onChange: changed,
      onStored: (n) => {
        const s = shots.find((x) => x.n === n);
        if (s) s.state = 'stored';
        changed();
      },
      onFailed: (n, reason) => {
        const s = shots.find((x) => x.n === n);
        if (s) s.state = 'failed';
        note = reason;
        changed();
      },
    },
  );

  const state = (): SmState => ({
    settings,
    linked,
    count: serverShots + sender.unsent,
    unsent: sender.unsent,
    progress: sender.progress,
    shots,
    auto: { ...auto },
    note: note || (sender.full ? 'Sending… the computer is still saving earlier pictures.' : sender.waiting ? 'Waiting for the Stop Motion on the computer.' : sender.stalled ? 'The computer is not answering. Pictures are kept and sent when it is back.' : ''),
    locked,
    taking,
    stalled: sender.stalled,
  });

  /* ------------------------------------------------ status to the computer ------------------------------------------------ */

  let statusDue = false;
  function scheduleStatus(): void {
    if (statusDue || !d.isOpen()) return;
    statusDue = true;
    stopStatus = d.later(150, () => {
      statusDue = false;
      sendStatus();
    });
  }
  function sendStatus(): void {
    if (!d.isOpen()) return;
    const st = state();
    const msg: SmStatus = {
      unsent: st.unsent,
      progress: st.progress,
      shots: st.count,
      auto: { running: auto.running, count: auto.count, limit: settings.stopAfter, nextInMs: auto.running ? Math.max(0, Math.round(auto.nextAt - d.now())) : 0 },
      note: st.note,
      locked,
    };
    d.send({ type: 'sm-status', ...msg });
  }

  /* ------------------------------------------------ shutter ------------------------------------------------ */

  async function shoot(): Promise<ShootResult> {
    if (taking) return 'busy';
    if (sender.full) {
      note = '';
      changed();
      return 'full';
    }
    taking = true;
    note = '';
    changed();
    let still: Still | null = null;
    try {
      still = await d.still(settings.maxSide);
    } catch {
      still = null;
    } finally {
      taking = false;
    }
    if (!still) {
      note = 'The camera could not take the picture. Try again.';
      changed();
      return 'failed';
    }
    const n = ++seq;
    const thumb = await d.thumb(still).catch(() => null);
    if (!sender.enqueue({ n, bytes: still.bytes, mime: still.mime, w: still.w, h: still.h }, d.now())) {
      changed();
      return 'full';
    }
    shots.push({ n, state: 'queued', thumb });
    if (shots.length > KEEP) shots = shots.slice(-KEEP);
    changed();
    return 'ok';
  }

  /** Undo last: removes the newest shot of this phone wherever it is (on the way or already in the project). */
  function undo(): boolean {
    const last = shots[shots.length - 1];
    if (!last) {
      note = 'There is no shot of this phone to undo. Use Undo last on the computer for earlier ones.';
      changed();
      return false;
    }
    shots = shots.slice(0, -1);
    sender.undo(last.n, d.now());
    if (last.state === 'stored') serverShots = Math.max(0, serverShots - 1);
    note = '';
    changed();
    return true;
  }

  /* ------------------------------------------------ auto shoot ------------------------------------------------ */

  function startAuto(): void {
    if (auto.running) return;
    autoStart = d.now();
    autoK = 0;
    auto = { running: true, count: 0, nextAt: autoStart };
    syncLock();
    scheduleAuto();
    changed();
  }

  function scheduleAuto(): void {
    const every = settings.interval * 1000;
    const due = autoStart + autoK * every;
    auto.nextAt = due;
    stopAutoTimer = d.later(due - d.now(), () => void autoTick());
  }

  async function autoTick(): Promise<void> {
    if (!auto.running) return;
    autoK++;
    if (sender.full || taking) {
      note = 'Sending… skipped a picture because the earlier ones are still going to the computer.';
    } else {
      const r = await shoot();
      if (r === 'ok') auto.count++;
    }
    if (!auto.running) return;
    if (settings.stopAfter > 0 && auto.count >= settings.stopAfter) {
      note = `Auto shoot finished: ${auto.count} pictures.`;
      return stopAuto();
    }
    const every = settings.interval * 1000;
    const now = d.now();
    while (autoStart + autoK * every < now - 1) autoK++; // a slow capture skips the ticks it covered
    scheduleAuto();
    changed();
  }

  function stopAuto(): void {
    stopAutoTimer?.();
    stopAutoTimer = null;
    auto = { ...auto, running: false };
    syncLock();
    changed();
  }

  /* ------------------------------------------------ keeping the screen awake ------------------------------------------------ */

  function syncLock(): void {
    const want = entered || auto.running;
    if (want === lockWanted) return;
    lockWanted = want;
    if (want) {
      lockAsked = true;
      void d.wakeLock().then((release) => {
        if (lockWanted && lockAsked) releaseLock = release;
        else release?.(); // not needed any more by the time it arrived
      });
    } else {
      lockAsked = false;
      releaseLock?.();
      releaseLock = null;
    }
  }

  /* ------------------------------------------------ settings ------------------------------------------------ */

  function setSetting(patch: Partial<Omit<SmSettings, 'rev'>>): void {
    const p = cleanPatch(patch);
    if (!Object.keys(p).length) return;
    settings = { ...settings, ...p };
    d.send({ type: 'sm-set', patch: p });
    changed();
  }

  async function toggleLock(): Promise<void> {
    const r = await d.lock(!locked);
    if (r.ok) locked = !locked;
    note = r.note;
    changed();
  }

  /* ------------------------------------------------ link ------------------------------------------------ */

  function hello(): void {
    d.send({ type: 'sm-hello', v: 1, sid, next: seq + 1 });
  }

  function onOpen(): void {
    hello();
    sender.onOpen(d.now());
    scheduleStatus();
    changed();
  }

  function onClose(): void {
    sender.onClose();
    linked = false;
    changed();
  }

  /** Returns true when the message was for stop motion. */
  function onMessage(msg: Record<string, unknown>): boolean {
    if (!isSmType(msg.type)) return false;
    const now = d.now();
    if (msg.type === 'sm-settings') {
      const s = parseSettings(msg);
      linked = true;
      if (s && (s.rev > settings.rev || msg.reset === true)) settings = s; // `reset`: the answer to our hello, the computer's copy wins
      changed();
    } else if (msg.type === 'sm-count') {
      serverShots = typeof msg.shots === 'number' && msg.shots >= 0 ? Math.floor(msg.shots) : serverShots;
      changed();
    } else if (msg.type === 'sm-cmd' && typeof msg.cmd === 'string' && (COMMANDS as readonly string[]).includes(msg.cmd)) {
      if (msg.cmd === 'shoot') void shoot();
      else if (msg.cmd === 'auto-start') startAuto();
      else stopAuto();
    } else if (msg.type === 'sm-removed' && msg.sid === sid && typeof msg.n === 'number') {
      const n = msg.n;
      shots = shots.filter((x) => x.n !== n); // removed on the computer: it leaves the strip and the onion skin
      sender.onMessage(msg, now);
      changed();
    } else sender.onMessage(msg, now);
    return true;
  }

  function enter(): void {
    entered = true;
    syncLock();
    stopTicker?.();
    const loop = () => {
      sender.tick(d.now());
      stopTicker = d.later(TICK_MS, loop);
    };
    stopTicker = d.later(TICK_MS, loop);
    changed();
  }

  function leave(): void {
    entered = false;
    stopAuto();
    stopTicker?.();
    stopTicker = null;
    stopStatus?.();
    statusDue = false;
    syncLock();
  }

  /** The faint pictures of the last shots to lay over the live view, newest first. */
  function onionLayers(): { n: number; thumb: Blob; opacity: number }[] {
    if (!settings.onion) return [];
    const withPic = shots.filter((s) => s.thumb).reverse();
    const w = onionWeights(Math.min(settings.onionFrames, withPic.length), settings.onionStrength);
    return w.map((opacity, i) => ({ n: withPic[i].n, thumb: withPic[i].thumb!, opacity }));
  }

  return {
    sid,
    sender,
    state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    shoot,
    undo,
    startAuto,
    stopAuto,
    toggleAuto: () => (auto.running ? stopAuto() : startAuto()),
    setSetting,
    toggleLock,
    onionLayers,
    onOpen,
    onClose,
    onMessage,
    enter,
    leave,
  };
}

export type StopMotionPhone = ReturnType<typeof createStopMotionPhone>;
