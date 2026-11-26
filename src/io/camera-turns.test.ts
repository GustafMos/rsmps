import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSources, type LiveRequest } from './live';
import { CLASH_MESSAGE } from './camera-ladder';
import { DEFAULT_TURNS, resolveRoles, turnLine, turnSettingsOf, type TurnSettings } from './camera-turns';
import { resetCatalogueCache } from './camera-catalogue';
import { FakeVideo, installCameras, removeCameras, type Kit } from './fake-cameras';

vi.mock('./upload', () => ({ uploadExternal: vi.fn(async () => undefined) }));

const gpu = {
  device: { limits: { maxTextureDimension2D: 8192 } },
  acquire: (width: number, height: number) => ({ width, height }),
  retain: () => undefined,
  release: () => undefined,
};

const cam = (deviceId: string, turns: Partial<TurnSettings> = {}): LiveRequest => ({ kind: 'camera', deviceId, turns: { ...DEFAULT_TURNS, ...turns } });
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let kit: Kit;
let live: LiveSources;
let errors: Error[];
let maxLive: number;

/** What the two Webcam nodes do: ask for a picture every 50 ms, and note what they got. */
async function run(ms: number, reqs: LiveRequest[], got?: Record<string, unknown[]>): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    for (const r of reqs) {
      try {
        const f = await live.frame(r, 0);
        if (got) (got[(r as { deviceId: string }).deviceId] ??= []).push(f);
      } catch (e) {
        errors.push(e as Error);
      }
    }
    maxLive = Math.max(maxLive, kit.live().length);
    await tick(50);
  }
}

const tracksOf = (id: string) => kit.tracks.filter((t) => t.settings.deviceId === id).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  resetCatalogueCache();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  errors = [];
  maxLive = 0;
});
afterEach(() => {
  live?.closeAll();
  FakeVideo.freezeAll = false;
  removeCameras();
  vi.useRealTimers();
});

function setup(rule: 'free' | 'pair720' | 'never') {
  kit = installCameras(rule);
  live = new LiveSources(gpu as never);
}

describe('who is main', () => {
  const m = (key: string, role: 'auto' | 'main' | 'visited', seq: number, viewed = false) => ({ key, role, seq, viewed });
  it('Automatic: the one being looked at, else the one opened first', () => {
    expect(resolveRoles([m('a', 'auto', 1), m('b', 'auto', 2)]).main).toBe('a');
    expect(resolveRoles([m('a', 'auto', 1), m('b', 'auto', 2, true)]).main).toBe('b');
  });
  it('Main camera wins; two that say so: the first wins and the other is named', () => {
    expect(resolveRoles([m('a', 'auto', 1), m('b', 'main', 2)]).main).toBe('b');
    const r = resolveRoles([m('a', 'main', 1), m('b', 'main', 2)]);
    expect(r.main).toBe('a');
    expect(r.lostMain).toEqual(['b']);
    expect(r.visited).toEqual(['b']);
  });
  it('a camera set to Visited is not main; if all say Visited the first opened stays live', () => {
    expect(resolveRoles([m('a', 'visited', 1), m('b', 'auto', 2)]).main).toBe('b');
    expect(resolveRoles([m('a', 'visited', 1), m('b', 'visited', 2)]).main).toBe('a');
  });
  it('settings of an old project are the defaults, and out-of-range values are clamped', () => {
    expect(turnSettingsOf({})).toEqual(DEFAULT_TURNS);
    expect(turnSettingsOf({ every: 999, settle: -2, clash: 'stop', role: 'main' })).toEqual({ clash: 'stop', role: 'main', every: 120, settle: 0 });
  });
  it('says what is going on in plain words', () => {
    const base = { role: 'visited' as const, lostMain: false, live: false, every: 5, age: 2000, visitMs: 600, returnMs: 300, visiting: false, failed: false };
    expect(turnLine(base)).toBe('Visited every 5 s · last picture 2 s ago · a visit takes about 0.9 s (the main camera pauses meanwhile)');
    expect(turnLine({ ...base, role: 'main', visitMs: null })).toBe('Main camera: live');
    expect(turnLine({ ...base, every: 0, age: null })).toMatch(/only when asked/);
  });
});

describe('cameras that take turns (a phone that opens one camera at a time)', () => {
  const A = cam('back0');
  const B = cam('front0');

  it('no error: the main camera stays live, the visited one gets a first picture, then one every 5 seconds, one stream at a time', async () => {
    setup('never');
    const got: Record<string, unknown[]> = {};
    await run(3000, [A, B], got);
    expect(errors).toEqual([]);
    expect(live.cameraInfo(A).turnLine).toMatch(/^Main camera: /);
    expect(live.cameraInfo(B).turnLine).toMatch(/^Visited every 5 s/);
    expect(live.cameraInfo(B).canRefresh).toBe(true);
    expect(live.cameraInfo(A).canRefresh).toBe(false);
    await run(2000, [A, B], got);
    const first = tracksOf('front0');
    expect(first).toBe(1); // its first visit
    expect(got.front0.at(-1)).toMatchObject({ width: 640, height: 480 });
    await run(30_000, [A, B], got);
    const visits = tracksOf('front0') - first;
    expect(visits).toBeGreaterThanOrEqual(5);
    expect(visits).toBeLessThanOrEqual(7);
    expect(maxLive).toBe(1);
    // main is open again after every visit, and both nodes always had a picture
    expect(kit.live()).toHaveLength(1);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
    expect(got.back0.every((f) => f !== null)).toBe(true);
    expect(got.front0.slice(-100).every((f) => f !== null)).toBe(true);
    expect(live.cameraInfo(B).turnLine).toMatch(/a visit takes about \d\.\d s/);
  });

  it('before its first visit the visited camera has no picture yet, and says so (waiting, not an error)', async () => {
    setup('never');
    live.frame(A, 0).catch(() => undefined);
    await tick(10);
    await live.frame(B, 0).catch(() => undefined);
    await tick(10);
    // the ladder is still running for the second camera: wait until it joined the schedule
    await run(500, [A]);
    expect(live.waitingForTurn(B)).toBe(true);
    expect(await live.frame(B, 0)).toBeNull();
  });

  it('there is no tight loop: a simulated minute asks the browser for a camera only a few dozen times', async () => {
    setup('never');
    await run(60_000, [A, B]);
    expect(errors).toEqual([]);
    expect(kit.gum.length).toBeLessThan(40);
  });

  it('Refresh now: with Refresh every 0 the camera is visited once by itself, then only when asked', async () => {
    setup('never');
    const B0 = cam('front0', { every: 0 });
    await run(6000, [A, B0]);
    expect(tracksOf('front0')).toBe(1);
    await run(20_000, [A, B0]);
    expect(tracksOf('front0')).toBe(1);
    expect(live.refreshNow(B0)).toBe(true);
    expect(live.refreshNow(A)).toBe(false); // the main camera is not visited
    await run(3000, [A, B0]);
    expect(tracksOf('front0')).toBe(2);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
  });

  it('Role: the second camera set to Main camera becomes the live one and the first is visited', async () => {
    setup('never');
    const Bm = cam('front0', { role: 'main' });
    await run(8000, [A, Bm]);
    expect(errors).toEqual([]);
    expect(kit.live()).toHaveLength(1);
    expect(kit.live()[0].settings.deviceId).toBe('front0');
    expect(live.cameraInfo(A).turnLine).toMatch(/^Visited every/);
    expect(live.cameraInfo(Bm).turnLine).toMatch(/^Main camera/);
  });

  it('two cameras both set to Main camera: the first wins and the other says so', async () => {
    setup('never');
    const Am = cam('back0', { role: 'main' });
    const Bm = cam('front0', { role: 'main' });
    await run(6000, [Am, Bm]);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
    expect(live.cameraInfo(Bm).turnLine).toMatch(/set to Main camera came first/);
  });

  it('a visit that fails keeps the picture, backs off, and gives the main camera back at once', async () => {
    setup('never');
    await run(8000, [A, B]);
    expect(live.cameraInfo(B).turnLine).not.toMatch(/could not be opened/);
    kit.failIds.add('front0');
    const before = kit.gum.length;
    await run(60_000, [A, B]);
    expect(errors).toEqual([]);
    expect(kit.live()).toHaveLength(1);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
    expect(await live.frame(B, 0)).not.toBeNull(); // the picture from before
    // backing off: a visit now asks up to six times (a phone frees its camera slowly), but visits are far apart, not one every 5 seconds
    expect(kit.gum.length - before).toBeLessThan(40);
    kit.failIds.clear();
    await run(70_000, [A, B]);
    expect(live.cameraInfo(B).turnLine).toMatch(/last picture \d s ago/);
  });

  it('a hidden page and the AR view pause the visits', async () => {
    setup('never');
    await run(8000, [A, B]);
    kit.visibility = 'hidden';
    const n = tracksOf('front0');
    await run(30_000, [A]);
    expect(tracksOf('front0')).toBe(n);
    kit.visibility = 'visible';
    live.suspendCameras(true);
    await run(30_000, [A, B]);
    expect(tracksOf('front0')).toBe(n);
    expect(kit.live()).toHaveLength(0);
    live.suspendCameras(false);
    await run(10_000, [A, B]);
    expect(kit.live()).toHaveLength(1);
    expect(tracksOf('front0')).toBeGreaterThan(n);
  });

  it('the stuck-camera watchdog does not treat a camera closed on purpose as stuck', async () => {
    setup('never');
    const recover = vi.spyOn(live as unknown as { recover: () => void }, 'recover');
    await run(40_000, [A, B]);
    expect(recover).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('a recording asking for pictures keeps the cameras still (no visits meanwhile)', async () => {
    setup('never');
    await run(8000, [A, B]);
    const n = tracksOf('front0');
    for (let i = 0; i < 100; i++) {
      live.drawable(A);
      await run(100, [A, B]);
    }
    expect(tracksOf('front0')).toBe(n);
  });

  it('Always take turns works on a phone that could run both, and Stop with a message gives the old error', async () => {
    setup('free');
    const Ba = cam('front0', { clash: 'always' });
    await run(4000, [A, Ba]);
    expect(errors).toEqual([]);
    expect(maxLive).toBe(1);
    live.closeAll();
    removeCameras();

    setup('never');
    const stop = { clash: 'stop' } as const;
    await run(3000, [cam('back0', stop), cam('front0', stop)]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe(CLASH_MESSAGE);
    expect(CLASH_MESSAGE).toMatch(/Take turns/);
  });

  it('a phone that allows two cameras never takes turns', async () => {
    setup('free');
    await run(40_000, [A, B]);
    expect(errors).toEqual([]);
    expect(kit.live()).toHaveLength(2);
    expect(kit.gum.length).toBe(2);
    expect(live.cameraInfo(B).turnLine).toBe('');
  });

  it('Test cameras together ends with a plain conclusion when no pair works', async () => {
    setup('never');
    const pending = live.testCamerasTogether();
    await tick(5000);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toMatch(/runs one camera at a time: use Take turns/);
  });
});
