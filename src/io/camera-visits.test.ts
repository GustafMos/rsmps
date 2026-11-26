import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSources, type LiveRequest } from './live';
import { DEFAULT_TURNS, type TurnSettings } from './camera-turns';
import { resetCatalogueCache } from './camera-catalogue';
import { FakeVideo, installCameras, removeCameras, type Kit } from './fake-cameras';
import { uploadExternal } from './upload';

vi.mock('./upload', () => ({ uploadExternal: vi.fn(async () => undefined) }));

const gpu = {
  device: { limits: { maxTextureDimension2D: 8192 } },
  acquire: (width: number, height: number) => ({ width, height }),
  retain: () => undefined,
  release: () => undefined,
};

const ask = (facing: 'user' | 'environment', turns: Partial<TurnSettings> = {}): LiveRequest => ({ kind: 'camera', deviceId: '', facing, width: 640, height: 480, turns: { ...DEFAULT_TURNS, clash: 'always', ...turns } });
const FRONT = (t: Partial<TurnSettings> = {}) => ask('user', { role: 'visited', every: 4, ...t });
const BACK = () => ask('environment');
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let kit: Kit;
let live: LiveSources;

/** What two Webcam nodes do: ask for a picture every 50 ms. Returns the last pictures they got and when the first picture of the front one came. */
async function run(ms: number, front: () => LiveRequest = FRONT) {
  const out = { front: null as unknown, back: null as unknown, firstFront: -1 };
  const t0 = performance.now();
  for (let t = 0; t < ms; t += 50) {
    out.front = await live.frame(front(), 0);
    out.back = await live.frame(BACK(), 0);
    if (out.front && out.firstFront < 0) out.firstFront = performance.now() - t0;
    await tick(50);
  }
  return out;
}

/** Both cameras have clashed and the back one is main; faults are switched on only after that, so they hit the visits. */
const warm = async () => {
  await run(800);
  // the front camera was open for a moment before the clash and left a picture: forget it, so the tests need a real visit
  for (const e of (live as unknown as { entries: Map<string, { held: unknown; heldAt: unknown; lastGoodAt: number; req: { facing?: string } }> }).entries.values()) {
    if (e.req.facing === 'user') {
      e.held = null;
      e.heldAt = null;
      e.lastGoodAt = 0;
    }
  }
};
const frontFails = () => (_d: unknown, el: unknown) => {
  const t = ((el as { srcObject?: { getVideoTracks?: () => { settings: { deviceId?: string } }[] } }).srcObject?.getVideoTracks?.() ?? [])[0];
  return t?.settings.deviceId === 'front0' ? Promise.reject(new Error('texture destroyed')) : Promise.resolve(undefined);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  resetCatalogueCache();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  kit = installCameras('never');
  live = new LiveSources(gpu as never);
  vi.mocked(uploadExternal).mockReset();
  vi.mocked(uploadExternal).mockResolvedValue(undefined);
});
afterEach(() => {
  live?.closeAll();
  FakeVideo.freezeAll = false;
  removeCameras();
  vi.useRealTimers();
});

describe('a visit on a real phone', () => {
  it('works when the phone frees the camera slowly (400 ms after the other one closed)', async () => {
    await warm();
    kit.releaseMs = 1000;
    const r = await run(15000);
    expect(r.front).not.toBeNull();
    expect(r.back).not.toBeNull();
    expect(live.cameraReport()).toMatch(/main camera back/);
  });

  it('works when the video needs play() and the first picture takes 1.2 s, with no frame callbacks', async () => {
    await warm();
    FakeVideo.needPlay = true;
    FakeVideo.needPlayIds = new Set(['front0']);
    FakeVideo.firstFrameMs = 1200;
    FakeVideo.silentRvfc = true;
    const r = await run(12000);
    expect(r.front).not.toBeNull();
  });

  it('waits for a cold front camera that takes 4 s to give a picture', async () => {
    await warm();
    FakeVideo.needPlay = true;
    FakeVideo.needPlayIds = new Set(['front0']);
    FakeVideo.firstFrameMs = 4000;
    const r = await run(20000);
    expect(r.front).not.toBeNull();
  });

  it('keeps the size the camera really delivers (480 x 640 instead of 640 x 480)', async () => {
    FakeVideo.followTrack = true;
    kit.swapIds.add('front0');
    const r = await run(8000);
    expect(r.front).toMatchObject({ width: 480, height: 640 });
  });

  it('a camera asked by side with Automatic device keeps its picture when Refresh every and Role change', async () => {
    await run(8000);
    const r = await run(1000, () => FRONT({ every: 30, role: 'auto', settle: 1 }));
    expect(r.front).not.toBeNull();
    expect(r.firstFront).toBe(0);
  });

  it('a node that only got the waiting picture still counts as looked at: its first visit starts within 4 s', async () => {
    const r = await run(4000);
    expect(r.firstFront).toBeGreaterThanOrEqual(0);
    expect(r.firstFront).toBeLessThan(4000);
  });

  it('falls back to a plain side request when the sizes are refused', async () => {
    await warm();
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (c) => {
      const v = (c?.video ?? {}) as MediaTrackConstraints;
      if (v.facingMode === 'user' && (v.width || v.height)) throw Object.assign(new Error('x'), { name: 'OverconstrainedError' });
      return real(c);
    });
    const r = await run(12000);
    expect(r.front).not.toBeNull();
  });

  it('stops every track of the main camera during a visit, and brings the main camera back after a failed visit', async () => {
    await warm();
    kit.failIds.add('front0');
    const r = await run(30000);
    expect(r.front).toBeNull();
    expect(r.back).not.toBeNull();
    expect(kit.live()).toHaveLength(1);
    expect(kit.live()[0].settings.deviceId).toBe('back0');
  });
});

describe('what the owner can see', () => {
  const lineOf = () => live.cameraInfo(FRONT() as never).turnLine;

  it('before its first turn the visited camera says it is waiting', async () => {
    await run(300);
    expect(lineOf()).toMatch(/waiting for its first turn/);
  });

  it('says why visits fail, with the count and the next try', async () => {
    await warm();
    kit.failIds.add('front0');
    await run(30000);
    expect(lineOf()).toMatch(/the last \d+ visits? failed: the camera could not be opened \(busy\)/);
  });

  it('says when no picture arrived in time', async () => {
    await warm();
    FakeVideo.needPlay = true;
    FakeVideo.needPlayIds = new Set(['front0']);
    FakeVideo.firstFrameMs = 60000;
    await run(9000);
    expect(lineOf()).toMatch(/no picture arrived in time/);
  });

  it('says when the picture could not be copied', async () => {
    await warm();
    vi.mocked(uploadExternal).mockImplementation(frontFails() as never);
    await run(9000);
    expect(lineOf()).toMatch(/the picture could not be copied/);
  });

  it('after a good visit it says how old the last picture is', async () => {
    await run(8000);
    expect(lineOf()).toMatch(/last picture \d+ s ago/);
  });

  it('the camera report lists what happened, in plain text', async () => {
    await warm();
    kit.releaseMs = 300;
    await run(9000);
    const text = live.cameraReport();
    expect(text).toMatch(/Camera report/);
    expect(text).toMatch(/Cameras known/);
    expect(text).toMatch(/open asked/);
    expect(text).toMatch(/NotReadableError/);
    expect(text).toMatch(/visit/);
    expect(text).toMatch(/first picture/);
    expect(text).toMatch(/main camera back/);
    process.stdout.write(text + '\n');
  });
});
