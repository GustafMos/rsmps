import { describe, expect, it, vi } from 'vitest';
import { LiveSources } from './live';
import { buildConstraints } from './camera-controls';

class FakeVideo {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
  readyState = 2;
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  play() {
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
  load() {}
}

class FakeTrack {
  applied: MediaTrackConstraints[] = [];
  stopped = false;
  fail = false;
  constructor(
    public caps: Record<string, unknown>,
    public settings: Record<string, unknown> = { frameRate: 30, width: 640, height: 480 },
  ) {}
  getCapabilities() {
    return this.caps;
  }
  getSettings() {
    return this.settings;
  }
  async applyConstraints(c: MediaTrackConstraints) {
    if (this.fail) throw Object.assign(new Error('nope'), { name: 'OverconstrainedError' });
    this.applied.push(c);
  }
  stop() {
    this.stopped = true;
  }
}

const FULL_CAPS = {
  zoom: { min: 1, max: 8, step: 0.1 },
  torch: true,
  focusMode: ['continuous', 'manual'],
  focusDistance: { min: 0.1, max: 5, step: 0.01 },
  exposureCompensation: { min: -3, max: 3, step: 0.5 },
  frameRate: { min: 1, max: 60 },
};

async function withCamera(caps: Record<string, unknown>, run: (live: LiveSources, tracks: FakeTrack[], gum: MediaStreamConstraints[]) => Promise<void>) {
  const tracks: FakeTrack[] = [];
  const gum: MediaStreamConstraints[] = [];
  vi.stubGlobal('HTMLVideoElement', FakeVideo);
  vi.stubGlobal('document', { createElement: () => new FakeVideo() });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      async getUserMedia(c: MediaStreamConstraints) {
        gum.push(c);
        const t = new FakeTrack(caps);
        tracks.push(t);
        return { getTracks: () => [t], getVideoTracks: () => [t] };
      },
    },
  });
  const live = new LiveSources({} as never);
  try {
    await run(live, tracks, gum);
  } finally {
    live.closeAll();
    vi.unstubAllGlobals();
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CAM = { kind: 'camera', deviceId: '' } as const;
async function openCam(live: LiveSources) {
  live.drawable(CAM);
  await wait(20);
}
const lastAdv = (t: FakeTrack) => (t.applied.at(-1) as { advanced: Record<string, unknown>[] }).advanced[0];

describe('camera controls', () => {
  it('reads capabilities and settings of an open camera, and nothing before it is open', async () => {
    await withCamera(FULL_CAPS, async (live) => {
      expect(live.cameraInfo(CAM).open).toBe(false);
      await openCam(live);
      const info = live.cameraInfo(CAM);
      expect(info.open).toBe(true);
      expect(info.capabilities).toMatchObject({ torch: true, zoom: { max: 8 } });
      expect(info.settings.frameRate).toBe(30);
      expect(info.digitalZoom).toBe(1);
    });
  });

  it('clamps zoom to the camera range and keeps only the latest of many quick changes', async () => {
    await withCamera(FULL_CAPS, async (live, tracks) => {
      await openCam(live);
      for (let i = 1; i <= 50; i++) live.applyCamera(CAM, { zoom: 1 + i * 0.5 });
      await wait(300);
      expect(tracks[0].applied.length).toBeLessThanOrEqual(3);
      expect(lastAdv(tracks[0]).zoom).toBe(8); // 26 asked, the camera goes to 8
      live.applyCamera(CAM, { zoom: 0.2 });
      await wait(300);
      expect(lastAdv(tracks[0]).zoom).toBe(1);
    });
  });

  it('applies the wish again after the camera is reopened', async () => {
    await withCamera(FULL_CAPS, async (live, tracks, gum) => {
      await openCam(live);
      live.applyCamera(CAM, { zoom: 3, torch: true });
      await wait(200);
      live.suspendCameras(true);
      expect(tracks[0].stopped).toBe(true);
      live.suspendCameras(false);
      await openCam(live);
      await wait(250);
      expect(gum.length).toBe(2);
      expect(lastAdv(tracks[1])).toMatchObject({ zoom: 3, torch: true });
    });
  });

  it('does not apply what the camera lacks, says so plainly and keeps the stream', async () => {
    await withCamera({ zoom: { min: 1, max: 4, step: 0.1 } }, async (live, tracks) => {
      await openCam(live);
      const r = live.applyCamera(CAM, { torch: true });
      expect(r.ok).toBe(false);
      expect(r.message).toBe('This camera cannot do that.');
      await wait(200);
      expect(tracks[0].applied).toEqual([]);
      expect(tracks[0].stopped).toBe(false);
      expect(live.cameraInfo(CAM).error).toBe('This camera cannot do that.');
      expect(live.applyCamera(CAM, { zoom: 2 }).ok).toBe(true);
    });
  });

  it('a refused constraint does not break the stream', async () => {
    await withCamera(FULL_CAPS, async (live, tracks) => {
      await openCam(live);
      tracks[0].fail = true;
      live.applyCamera(CAM, { zoom: 2 });
      await wait(200);
      expect(tracks[0].stopped).toBe(false);
      expect(live.cameraInfo(CAM).open).toBe(true);
      expect(live.cameraInfo(CAM).error).toBe('This camera cannot do that.');
    });
  });

  it('asks for the frame rate as ideal, never exact, also when opening the camera', async () => {
    await withCamera(FULL_CAPS, async (live, tracks, gum) => {
      live.drawable({ ...CAM, controls: { frameRate: 25 } });
      await wait(20);
      expect((gum[0].video as MediaTrackConstraints).frameRate).toEqual({ ideal: 25 });
      live.applyCamera(CAM, { frameRate: 60 });
      await wait(200);
      expect((tracks[0].applied.at(-1) as { frameRate: unknown }).frameRate).toEqual({ ideal: 60 });
      live.applyCamera(CAM, { frameRate: 500 });
      await wait(200);
      expect((tracks[0].applied.at(-1) as { frameRate: unknown }).frameRate).toEqual({ ideal: 60 }); // clamped to what the camera reports
      expect(gum.length).toBe(1); // no new getUserMedia, so no new permission question
    });
  });

  it('a camera without zoom leaves the zoom to the picture', async () => {
    await withCamera({}, async (live, tracks) => {
      await openCam(live);
      live.applyCamera(CAM, { zoom: 2 });
      await wait(200);
      expect(tracks[0].applied).toEqual([]);
      expect(live.cameraInfo(CAM).digitalZoom).toBe(2);
    });
  });
});

describe('camera constraints (pure)', () => {
  it('ask for nothing while everything is neutral, so an old project leaves the camera alone', () => {
    expect(buildConstraints({ zoom: 1, exposureComp: 0 }, FULL_CAPS, new Set(), {}).keys).toEqual([]);
  });
  it('map the 0..1 values into the camera range', () => {
    const b = buildConstraints({ focus: 'manual', focusDistance: 0.5 }, FULL_CAPS, new Set(), {});
    const adv = (b.constraints as { advanced: Record<string, unknown>[] }).advanced[0];
    expect(adv.focusMode).toBe('manual');
    expect(adv.focusDistance).toBeCloseTo(2.55);
  });
  it('put a control back to neutral once when it is let go of', () => {
    const b = buildConstraints({ zoom: 1 }, FULL_CAPS, new Set(['zoom', 'torch']), {});
    expect((b.constraints as { advanced: Record<string, unknown>[] }).advanced[0]).toEqual({ zoom: 1, torch: false });
    expect(b.active).toEqual([]);
  });
});
