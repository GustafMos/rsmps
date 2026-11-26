// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStill, fitSide, lockable, setCameraLock, type StillEnv } from './stopmotion-camera';
import { createStopMotionPhone, type SmDeps } from './stopmotion';

type Msg = Record<string, unknown>;

const jpegBlob = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/jpeg' });

function fakeEnv(opts: { photo?: { w: number; h: number } | 'throws' | null; frame?: { w: number; h: number } } = {}) {
  const calls = { resize: [] as [number, number][], frame: [] as [number, number][] };
  const photo = opts.photo === undefined ? { w: 4000, h: 3000 } : opts.photo;
  const env: StillEnv = {
    takePhoto: photo === null ? undefined : async () => (photo === 'throws' ? Promise.reject(new Error('busy')) : jpegBlob(photo.w % 97 + 5)),
    sizeOf: async () => (photo && photo !== 'throws' ? photo : null),
    resize: async (_b, w, h) => (calls.resize.push([w, h]), jpegBlob(3)),
    frameSize: () => opts.frame ?? { w: 1920, h: 1080 },
    encodeFrame: async (w, h) => (calls.frame.push([w, h]), jpegBlob(9)),
  };
  return { env, calls };
}

describe('phone still capture', () => {
  it('fits the longer side to the shot size and never enlarges', () => {
    expect(fitSide(4000, 3000, 0)).toEqual({ w: 4000, h: 3000 });
    expect(fitSide(4000, 3000, 1080)).toEqual({ w: 1080, h: 810 });
    expect(fitSide(3000, 4000, 720)).toEqual({ w: 540, h: 720 });
    expect(fitSide(640, 480, 1080)).toEqual({ w: 640, h: 480 });
  });

  it('full size: the camera photo as it is', async () => {
    const { env, calls } = fakeEnv();
    const s = await captureStill(env, 0);
    expect(s).toMatchObject({ w: 4000, h: 3000, mime: 'image/jpeg' });
    expect(calls.resize).toEqual([]);
  });

  it('1080 and 720: the photo is shrunk to the requested size', async () => {
    const a = fakeEnv();
    expect(await captureStill(a.env, 1080)).toMatchObject({ w: 1080, h: 810 });
    expect(a.calls.resize).toEqual([[1080, 810]]);
    const b = fakeEnv();
    expect(await captureStill(b.env, 720)).toMatchObject({ w: 720, h: 540 });
  });

  it('without ImageCapture (or when it fails) the video frame is used, at the requested size', async () => {
    const a = fakeEnv({ photo: null });
    expect(await captureStill(a.env, 0)).toMatchObject({ w: 1920, h: 1080 });
    const b = fakeEnv({ photo: 'throws' });
    expect(await captureStill(b.env, 720)).toMatchObject({ w: 720, h: 405 });
    expect(b.calls.frame).toEqual([[720, 405]]);
  });

  it('gives null when there is no photo and no picture', async () => {
    const a = fakeEnv({ photo: null, frame: { w: 0, h: 0 } });
    expect(await captureStill(a.env, 0)).toBeNull();
  });

  it('locks exposure and focus only where the camera offers manual modes', async () => {
    const caps = { focusMode: ['continuous', 'manual'], exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 100, step: 1 }, focusDistance: { min: 0, max: 1, step: 0.1 } };
    expect(lockable(caps)).toEqual(['focus', 'exposure']);
    const applied: unknown[] = [];
    const track = { getCapabilities: () => caps, getSettings: () => ({ exposureTime: 500, focusDistance: 0.4 }), applyConstraints: async (c: unknown) => void applied.push(c) };
    const r = await setCameraLock(track, true);
    expect(r.ok).toBe(true);
    expect(applied[0]).toEqual({ advanced: [{ focusMode: 'manual', focusDistance: 0.4, exposureMode: 'manual', exposureTime: 100 }] }); // clamped to the camera's range
    await setCameraLock(track, false);
    expect(applied[1]).toEqual({ advanced: [{ focusMode: 'continuous', exposureMode: 'continuous' }] });
    expect((await setCameraLock({ getCapabilities: () => ({}), applyConstraints: async () => undefined }, true)).ok).toBe(false);
    expect((await setCameraLock(null, true)).ok).toBe(false);
  });
});

function phoneRig(opts: { stillMs?: number; open?: boolean } = {}) {
  const sent: Msg[] = [];
  let open = opts.open ?? true;
  const locks = { got: 0, released: 0 };
  const stills: number[] = [];
  const deps: SmDeps = {
    send: (m) => void (open && sent.push(m)),
    isOpen: () => open,
    buffered: () => 0,
    now: () => Date.now(),
    later: (ms, fn) => {
      const t = setTimeout(fn, Math.max(0, ms));
      return () => clearTimeout(t);
    },
    wakeLock: async () => (locks.got++, () => void locks.released++),
    still: async (maxSide) => {
      stills.push(maxSide);
      if (opts.stillMs) await new Promise((r) => setTimeout(r, opts.stillMs));
      return { bytes: new Uint8Array([1, 2, 3, stills.length]), mime: 'image/jpeg', w: 8, h: 6 };
    },
    thumb: async () => new Blob(['t']),
    lock: async (on) => ({ ok: true, note: on ? 'Locked.' : 'Unlocked.' }),
    newSid: () => 'phonesid1',
  };
  const sm = createStopMotionPhone(deps);
  const type = (t: string) => sent.filter((m) => m.type === t);
  return { sm, sent, type, stills, locks, setOpen: (o: boolean) => (open = o) };
}

/** Answers every begin like a computer that stores everything at once. */
function autoComputer(r: ReturnType<typeof phoneRig>) {
  let answered = 0;
  return () => {
    for (; answered < r.sent.length; answered++) {
      const m = r.sent[answered];
      if (m.type === 'sm-begin') r.sm.onMessage({ type: 'sm-ack', sid: m.sid, n: m.n, next: m.chunks }); // pretend all chunks are in
      if (m.type === 'sm-begin') r.sm.onMessage({ type: 'sm-stored', sid: m.sid, n: m.n });
    }
  };
}

describe('phone capture screen logic', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the shutter takes a still at the size the computer asked for and queues it', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-settings', rev: 2, maxSide: 1080, reset: true });
    expect(await r.sm.shoot()).toBe('ok');
    expect(r.stills).toEqual([1080]);
    expect(r.type('sm-begin')).toHaveLength(1);
    expect(r.type('sm-begin')[0]).toMatchObject({ sid: 'phonesid1', n: 1, w: 8, h: 6, mime: 'image/jpeg' });
    expect(r.sm.state().unsent).toBe(1);
  });

  it('the onion skin uses the last local shots, with no round trip, and follows the settings', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    await r.sm.shoot();
    await r.sm.shoot();
    expect(r.sm.onionLayers().map((l) => l.n)).toEqual([2]);
    expect(r.sm.onionLayers()[0].opacity).toBeCloseTo(0.4);
    r.sm.onMessage({ type: 'sm-settings', rev: 3, onionFrames: 2, onionStrength: 0.6 });
    const two = r.sm.onionLayers();
    expect(two.map((l) => l.n)).toEqual([2, 1]);
    expect(two[0].opacity).toBeGreaterThan(two[1].opacity);
    r.sm.setSetting({ onion: false });
    expect(r.sm.onionLayers()).toEqual([]);
    expect(r.type('sm-set').pop()).toMatchObject({ patch: { onion: false } });
    // undo of the last shot brings the previous one back as the onion skin
    r.sm.setSetting({ onion: true });
    r.sm.undo();
    expect(r.sm.onionLayers().map((l) => l.n)).toEqual([1]);
  });

  it('puts a tick on a shot once the computer has stored it, and Undo last asks the computer to remove that shot', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    await r.sm.shoot();
    expect(r.sm.state().shots[0].state).toBe('queued');
    r.sm.onMessage({ type: 'sm-ack', sid: 'phonesid1', n: 1, next: 1 });
    r.sm.onMessage({ type: 'sm-stored', sid: 'phonesid1', n: 1 });
    expect(r.sm.state().shots[0].state).toBe('stored');
    expect(r.sm.undo()).toBe(true);
    expect(r.type('sm-undo')).toEqual([{ type: 'sm-undo', sid: 'phonesid1', n: 1 }]);
    expect(r.sm.state().shots).toEqual([]);
    expect(r.sm.undo()).toBe(false);
  });

  it('a shot the computer removed leaves the strip', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    await r.sm.shoot();
    r.sm.onMessage({ type: 'sm-removed', sid: 'phonesid1', n: 1 });
    expect(r.sm.state().shots).toEqual([]);
    expect(r.sm.state().unsent).toBe(0);
  });

  it('says Sending and refuses the shutter when too many pictures wait for the computer', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    for (let i = 0; i < 3; i++) expect(await r.sm.shoot()).toBe('ok');
    expect(await r.sm.shoot()).toBe('full');
    expect(r.stills.length).toBe(3); // the camera was not even used for the fourth
    expect(r.sm.state().note).toMatch(/Sending/);
  });

  it('Auto shoot keeps a fixed grid, stops after the set number, holds the screen awake and lets go', async () => {
    const r = phoneRig();
    const answer = autoComputer(r);
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-settings', rev: 2, interval: 2, stopAfter: 3, reset: true });
    r.sm.startAuto();
    await vi.advanceTimersByTimeAsync(0);
    answer();
    expect(r.stills.length).toBe(1); // the first picture is immediate
    expect(r.locks.got).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    answer();
    expect(r.stills.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    answer();
    expect(r.stills.length).toBe(2); // t = 2 s
    await vi.advanceTimersByTimeAsync(2000);
    answer();
    expect(r.stills.length).toBe(3); // t = 4 s: the last one
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.stills.length).toBe(3);
    expect(r.sm.state().auto.running).toBe(false);
    expect(r.locks.released).toBe(1);
  });

  it('a slow capture skips the ticks it covered and never queues extra pictures', async () => {
    const r = phoneRig({ stillMs: 2500 });
    const answer = autoComputer(r);
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-settings', rev: 2, interval: 1, stopAfter: 0, reset: true });
    r.sm.startAuto();
    await vi.advanceTimersByTimeAsync(6000);
    answer();
    expect(r.stills.length).toBeLessThanOrEqual(3); // 1 s grid, but each capture takes 2.5 s
    r.sm.stopAuto();
  });

  it('Auto shoot skips a tick (and says Sending) while the computer has not stored earlier pictures', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-settings', rev: 2, interval: 1, stopAfter: 0, reset: true });
    r.sm.startAuto();
    await vi.advanceTimersByTimeAsync(10_000); // nobody answers
    expect(r.stills.length).toBe(3); // the queue holds three, the others were skipped
    expect(r.sm.state().auto.count).toBe(3);
    expect(r.sm.state().note).toMatch(/Sending/);
    r.sm.stopAuto();
  });

  it('the computer can start and stop Auto shoot and press the shutter; the phone reports back', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-cmd', cmd: 'shoot' });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.stills.length).toBe(1);
    r.sm.onMessage({ type: 'sm-cmd', cmd: 'auto-start' });
    await vi.advanceTimersByTimeAsync(300);
    expect(r.sm.state().auto.running).toBe(true);
    const st = r.type('sm-status').pop() as { auto: { running: boolean } };
    expect(st.auto.running).toBe(true);
    r.sm.onMessage({ type: 'sm-cmd', cmd: 'auto-stop' });
    expect(r.sm.state().auto.running).toBe(false);
  });

  it('keeps the screen awake while the capture screen is open and lets go when it closes', async () => {
    const r = phoneRig();
    r.sm.enter();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.locks.got).toBe(1);
    r.sm.startAuto();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.locks.got).toBe(1); // one lock serves both
    r.sm.leave();
    expect(r.sm.state().auto.running).toBe(false);
    expect(r.locks.released).toBe(1);
  });

  it('after a reconnect it says hello again, repeats pending undo requests and resumes the picture', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    await r.sm.shoot();
    r.setOpen(false);
    r.sm.onClose();
    r.sm.undo(); // while offline
    r.setOpen(true);
    r.sent.length = 0;
    r.sm.onOpen();
    expect(r.type('sm-hello')).toHaveLength(1);
    expect(r.type('sm-undo')).toEqual([{ type: 'sm-undo', sid: 'phonesid1', n: 1 }]);
    r.sm.onMessage({ type: 'sm-removed', sid: 'phonesid1', n: 1 });
    r.sent.length = 0;
    r.sm.onOpen();
    expect(r.type('sm-undo')).toEqual([]); // the answer arrived: not repeated
  });

  it('settings changed on the computer replace the phone copy; an older revision does not', () => {
    const r = phoneRig();
    r.sm.onOpen();
    r.sm.onMessage({ type: 'sm-settings', rev: 5, maxSide: 720, interval: 4 });
    expect(r.sm.state().settings).toMatchObject({ rev: 5, maxSide: 720, interval: 4 });
    r.sm.onMessage({ type: 'sm-settings', rev: 4, maxSide: 0, interval: 9 });
    expect(r.sm.state().settings).toMatchObject({ maxSide: 720, interval: 4 });
    r.sm.setSetting({ interval: 7 });
    expect(r.sm.state().settings.interval).toBe(7);
    expect(r.type('sm-set')[0]).toEqual({ type: 'sm-set', patch: { interval: 7 } });
  });

  it('locks and unlocks the camera and reports it', async () => {
    const r = phoneRig();
    r.sm.onOpen();
    await r.sm.toggleLock();
    expect(r.sm.state().locked).toBe(true);
    await r.sm.toggleLock();
    expect(r.sm.state().locked).toBe(false);
  });
});
