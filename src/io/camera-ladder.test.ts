import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSources } from './live';
import { CLASH_MESSAGE, GAVE_UP_MESSAGE, describePairTests, ladderRungs } from './camera-ladder';
import { resetCatalogueCache } from './camera-catalogue';
import { FakeVideo, installCameras, removeCameras, type Kit } from './fake-cameras';

const BACK = { kind: 'camera', deviceId: 'back0' } as const;
const FRONT = { kind: 'camera', deviceId: 'front0' } as const;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let kit: Kit;
let live: LiveSources;

function setup(rule: 'free' | 'pair720' | 'never') {
  kit = installCameras(rule);
  live = new LiveSources({} as never);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  resetCatalogueCache();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => {
  live?.closeAll();
  FakeVideo.freezeAll = false;
  removeCameras();
  vi.useRealTimers();
});

describe('ladder rungs', () => {
  it('goes 1280x720, 640x480, then the other way of choosing the camera', () => {
    const r = ladderRungs({ deviceId: 'a' }, { facing: 'user' });
    expect(r.map((x) => x.id)).toEqual(['hd', 'sd', 'hd-alt', 'sd-alt']);
    expect(r[0].constraints).toMatchObject({ deviceId: { exact: 'a' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
    expect(r[2].constraints).toMatchObject({ facingMode: { exact: 'user' } });
    expect(ladderRungs(null, null)).toHaveLength(2);
  });
  it('says the pair results in plain words', () => {
    expect(describePairTests([{ a: 'Back', b: 'Front', works: [] }])[0]).toMatch(/does not work at any size/);
    expect(describePairTests([{ a: 'Back', b: 'Front', works: ['720p', '480p'] }])[0]).toMatch(/only at 720p and 480p/);
  });
});

describe('two device cameras at once', () => {
  it('a phone that allows a pair only up to 720p: the second camera finds 720p by lowering the first, which goes back up when the second closes', async () => {
    setup('pair720');
    live.drawable(BACK);
    await tick(10);
    expect(kit.tracks[0].settings.width).toBe(1920);
    live.drawable(FRONT);
    await tick(50);
    expect(kit.live()).toHaveLength(2);
    expect(kit.gum.length).toBeLessThanOrEqual(8);
    const front = kit.tracks[kit.tracks.length - 1];
    expect(front.settings.width).toBe(1280);
    expect(kit.tracks[0].settings.width).toBe(1280); // lowered without a restart
    expect(kit.tracks[0].stopped).toBe(false);
    const info = live.cameraInfo(FRONT);
    expect(info.reducedTo).toEqual({ width: 1280, height: 720 });
    expect(info.note).toBe('Running at 1280 × 720 so the front and back cameras can work together');
    expect(live.cameraInfo(BACK).note).toMatch(/1280 × 720/);
    // the front camera stops being wanted: the back one goes back up
    for (let i = 0; i < 8; i++) {
      live.drawable(BACK);
      await tick(1000);
    }
    expect(live.cameraInfo(FRONT).open).toBe(false);
    expect(kit.tracks[0].settings.width).toBe(1920);
    expect(live.cameraInfo(BACK).note).toBe('');
  });

  it('remembers the pair: opening the second camera again does not run the ladder again', async () => {
    setup('pair720');
    live.drawable(BACK);
    await tick(10);
    live.drawable(FRONT);
    await tick(50);
    const before = kit.gum.length;
    for (let i = 0; i < 8; i++) {
      live.drawable(BACK);
      await tick(1000);
    }
    live.drawable(FRONT);
    await tick(50);
    expect(kit.live()).toHaveLength(2);
    expect(kit.gum.length - before).toBe(1);
  });

  it('a phone that never allows two cameras: plain message, the first camera keeps working, no loop', async () => {
    setup('never');
    live.drawable(BACK);
    await tick(10);
    live.drawable(FRONT);
    await tick(100);
    await expect(live.frame(FRONT, 0)).rejects.toThrow(CLASH_MESSAGE);
    expect(CLASH_MESSAGE).toMatch(/could not run these two cameras at the same time/);
    expect(live.cameraInfo(BACK).open).toBe(true);
    expect(kit.live()).toHaveLength(1);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
    const calls = kit.gum.length;
    expect(calls).toBeLessThanOrEqual(24);
    // asking again for half a minute does not run the ladder again (cooldown and the remembered failure)
    for (let i = 0; i < 30; i++) {
      live.drawable(BACK);
      live.drawable(FRONT);
      await tick(1000);
    }
    expect(kit.gum.length).toBe(calls);
  });

  it('one camera alone never goes down the ladder', async () => {
    setup('pair720');
    kit.failWith = 'NotReadableError';
    live.drawable(BACK);
    await tick(10);
    await expect(live.frame(BACK, 0)).rejects.toThrow(/in use by another program/);
    expect(kit.gum.length).toBe(1);
  });

  it('two Webcam nodes that ask for the same camera share one stream', async () => {
    setup('pair720');
    live.drawable({ ...BACK, controls: { zoom: 2 } } as never);
    live.drawable({ ...BACK, freeze: true } as never);
    await tick(10);
    expect(kit.gum.length).toBe(1);
  });
});

describe('test cameras together', () => {
  it('lists which pairs work at which size, and opens what was open again', async () => {
    setup('pair720');
    live.drawable(BACK);
    await tick(10);
    const p = live.testCamerasTogether();
    await tick(5000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2); // two back cameras with one front camera
    for (const row of r.rows) expect(row.works).toEqual(['720p', '480p']);
    expect(r.lines[0]).toMatch(/works only at 720p and 480p/);
    expect(kit.live()).toHaveLength(1); // only the camera that was open before
    expect(live.cameraInfo(BACK).open).toBe(true);
  });

  it('a phone that never allows two cameras: no size works', async () => {
    setup('never');
    const p = live.testCamerasTogether();
    await tick(5000);
    const r = await p;
    expect(r.rows.every((x) => x.works.length === 0)).toBe(true);
    expect(r.lines[0]).toMatch(/does not work at any size/);
    expect(kit.live()).toHaveLength(0);
  });
});

describe('a camera that Android took away', () => {
  async function opened(rule: 'free' | 'never' = 'free') {
    setup(rule);
    live.drawable(BACK);
    await tick(10);
    live.applyCamera(BACK, { zoom: 3 });
    await tick(300);
  }
  const keepAsking = async (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      live.drawable(BACK);
      await tick(500);
    }
  };

  it('ended track: nothing happens while the page is hidden, one restart on return, controls applied again', async () => {
    await opened();
    kit.tracks[0].readyState = 'ended';
    kit.visibility = 'hidden';
    await keepAsking(6000);
    expect(kit.gum.length).toBe(1);
    kit.visibility = 'visible';
    kit.fire('visibilitychange');
    await tick(50);
    expect(kit.gum.length).toBe(2);
    expect(kit.tracks[0].stopped).toBe(true);
    await tick(400);
    expect(kit.tracks[1].applied.at(-1)).toMatchObject({ advanced: [{ zoom: 3 }] });
    await keepAsking(5000);
    expect(kit.gum.length).toBe(2); // healthy again: no second restart
  });

  it('muted and never unmuted: restarted after the grace time, not before', async () => {
    await opened();
    kit.tracks[0].onmute?.();
    await keepAsking(1000);
    expect(kit.gum.length).toBe(1);
    await keepAsking(2000);
    expect(kit.gum.length).toBe(2);
  });

  it('a track that unmutes in time is left alone', async () => {
    await opened();
    kit.tracks[0].onmute?.();
    await keepAsking(500);
    kit.tracks[0].onunmute?.();
    await keepAsking(5000);
    expect(kit.gum.length).toBe(1);
  });

  it('live but frozen: play() first, then a fresh video element, then a new stream', async () => {
    await opened();
    FakeVideo.freezeAll = true;
    const video = (live as unknown as { entries: Map<string, { el: FakeVideo }> }).entries.values().next().value!.el;
    const created = FakeVideo.created;
    const plays = video.plays;
    await keepAsking(4000);
    expect(video.plays).toBeGreaterThan(plays);
    expect(kit.gum.length).toBe(1);
    await keepAsking(1500);
    expect(FakeVideo.created).toBeGreaterThan(created);
    expect(kit.gum.length).toBe(1);
    await keepAsking(3500);
    expect(kit.gum.length).toBe(2);
  });

  it('a camera that keeps failing: backs off, stops, says so plainly, and asks the browser no more', async () => {
    await opened();
    kit.failWith = 'NotReadableError';
    kit.tracks[0].readyState = 'ended';
    await keepAsking(30000);
    const calls = kit.gum.length;
    expect(calls).toBe(1 + 4);
    expect(live.cameraInfo(BACK).error).toBe(GAVE_UP_MESSAGE);
    await expect(live.frame(BACK, 0)).rejects.toThrow(GAVE_UP_MESSAGE);
    await keepAsking(20000);
    expect(kit.gum.length).toBe(calls);
  });

  it('the Restart button replaces a stream that looks open but is stuck, and clears every cooldown', async () => {
    await opened();
    const stuck = kit.tracks[0];
    kit.failWith = 'NotReadableError';
    live.drawable(FRONT);
    await tick(10);
    kit.failWith = null;
    const p = live.askCamera();
    await tick(300);
    expect((await p).ok).toBe(true);
    expect(stuck.stopped).toBe(true);
    const before = kit.gum.length;
    live.drawable(BACK);
    live.drawable(FRONT); // a camera that failed before is tried at once
    await tick(100);
    expect(kit.gum.length).toBe(before + 2);
    expect(live.cameraInfo(BACK).open).toBe(true);
  });

  it('the AR view owns the camera: nothing is restarted', async () => {
    await opened();
    kit.tracks[0].readyState = 'ended';
    live.suspendCameras(true);
    await tick(10);
    const calls = kit.gum.length;
    kit.fire('visibilitychange');
    await keepAsking(8000);
    expect(kit.gum.length).toBe(calls);
  });
});
