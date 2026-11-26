import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { createGraph } from '../../engine/graph';
import type { Vec3 } from '../../engine/lib/motion-math';
import { angleToDir, centreNdcInShot, coverageOf, lookAtQuat } from '../../engine/lib/scan-coverage';
import { decodeDepth, normalizeScan, projectToShot } from '../../engine/lib/scan-data';
import type { XrPose } from '../../engine/lib/xr-math';
import type { AssetInfo } from '../../engine/types';
import { WorldArController, type WorldArEnv, type WorldArHandle, type WorldArScanOutcome, type WorldArViewState } from './controller';
import { FakeXrSession, FakeXrSystem, fakeTransform } from './fake-xr';
import type { ArPainter } from './loop';
import type { ScanEnv, ScanGrab } from './scan-session';
import { depthReadout, noCameraPictureMessage, scanBlockedReason } from './support';
import { DEPTH_INIT, SCAN_FEATURES } from './xr-api';

const UP: Vec3 = [0, 1, 0];
const CENTER: Vec3 = [0, 0, -2];
const FLOOR_HIT: XrPose = { p: CENTER, q: [0, 0, 0, 1] };
const FEATURES = ['hit-test', 'anchors', 'dom-overlay', 'camera-access'];

/** A painter that only records what the scan view asks of it: the dome, and the photos it grabs. */
class FakeScanPainter implements ArPainter {
  meshes = 0;
  grabs = 0;
  /** The "camera picture" is blurry right now. */
  blur = false;
  begin() {}
  picture() {}
  ring() {}
  mesh() {
    this.meshes++;
  }
  still(): ScanGrab | null {
    this.grabs++;
    return { width: 1080, height: 1920, blur: this.blur } as ScanGrab;
  }
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function scanRig(xr: FakeXrSystem, o: { encodeDelay?: number } = {}) {
  let clock = 0;
  const painters: FakeScanPainter[] = [];
  const encodes = { running: 0, peak: 0, total: 0 };
  const scanEnv: ScanEnv = {
    async encode(grab) {
      encodes.running++;
      encodes.peak = Math.max(encodes.peak, encodes.running);
      encodes.total++;
      if (o.encodeDelay) await new Promise((r) => setTimeout(r, o.encodeDelay));
      await Promise.resolve();
      encodes.running--;
      // a blurry picture has little edge energy, a sharp one a lot
      return { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), variance: (grab as unknown as { blur: boolean }).blur ? 6 : 400 };
    },
  };
  const env: WorldArEnv = {
    xr,
    async makePainter(session) {
      const p = new FakeScanPainter();
      painters.push(p);
      return { painter: p as never, layer: (session as FakeXrSession).layer, dispose: () => undefined };
    },
    makeTransform: fakeTransform,
    makeGpuCanvas: () => {
      throw new Error('the scan view must not make a GPU canvas');
    },
    canvasCopyWorks: () => false,
    makeRecorder: () => null,
    now: () => clock,
    makeScanEnv: () => scanEnv,
  };
  const added: File[] = [];
  let holds = 0;
  const c = new WorldArController(
    {
      gpu: {} as never,
      gate: {
        evaluateHeld: async () => {
          throw new Error('the scan view must not render the graph');
        },
        drop: () => undefined,
      },
      registry: new Registry(),
      add: async (files) => {
        added.push(...files);
        return files.map((file, i) => ({ id: `photo${added.length - files.length + i + 1}`, name: file.name }) as unknown as AssetInfo);
      },
      holdPlayer: () => {
        holds++;
        return () => holds--;
      },
    },
    env,
  );
  const states: WorldArViewState[] = [];
  const outcomes: WorldArScanOutcome[] = [];
  const graph = createGraph('p');
  let handle: WorldArHandle | null = null;
  const open = async (auto = true) =>
    (handle = await c.open({ graph: () => graph, node: 'scan', card: { mode: 'upright', width: 0.5 }, overlay: { clientWidth: 360, clientHeight: 640 } as HTMLElement, onState: (s) => states.push(s), onTake: () => undefined, scan: { auto, onScan: (r) => outcomes.push(r) } }));
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += 33;
      xr.session!.step(33);
      await tick();
    }
  };
  const at = (p: Vec3, aim: Vec3 = CENTER) => {
    xr.session!.viewer = { p, q: lookAtQuat(p, aim) };
  };
  /** Walk round the target at elevation `el` degrees, `dist` metres out, `speed` m/s, for `turns` times round. */
  const walk = async (el: number, o: { turns?: number; speed?: number; dist?: number; startAz?: number; aim?: Vec3; away?: boolean } = {}) => {
    const dist = o.dist ?? 1.2;
    const dAz = ((o.speed ?? 0.25) * 0.033) / dist;
    const start = o.startAz ?? 0;
    const end = start + (o.turns ?? 1) * 2 * Math.PI;
    for (let az = start; az < end; az += dAz) {
      const d = angleToDir(az, el, UP);
      const p: Vec3 = [CENTER[0] + d[0] * dist, CENTER[1] + d[1] * dist, CENTER[2] + d[2] * dist];
      at(p, o.away ? [p[0] + d[0] * 5, p[1] + d[1] * 5, p[2] + d[2] * 5] : o.aim);
      await step();
    }
  };
  /** Find the surface, tap, and press Start: the walk begins. */
  const begin = async (h: WorldArHandle) => {
    at([0, 1.4, 0], [0, 0, -2]);
    xr.session!.hit = FLOOR_HIT;
    await step(2);
    h.place();
    await step(2);
    h.scan!.begin();
    await step(2);
  };
  return { c, env, painters, encodes, added, states, outcomes, open, step, at, walk, begin, holds: () => holds, last: () => handle!.state(), scan: () => handle!.state().scan! };
}

const system = (features = [...FEATURES, 'depth-sensing']) => new FakeXrSystem({ features });

describe('opening the scan view', () => {
  it('asks for depth as an optional extra with CPU usage, and keeps the graph unrendered', async () => {
    const xr = system();
    const t = scanRig(xr);
    const h = await t.open();
    expect(xr.lastInit!.requiredFeatures).toBeUndefined();
    expect(xr.lastInit!.optionalFeatures).toEqual([...SCAN_FEATURES]);
    expect(xr.lastInit!.depthSensing).toEqual(DEPTH_INIT);
    expect(h.scan).toBeTruthy();
    expect(t.holds()).toBe(1); // the normal viewer stands still: no graph picture meanwhile
    await t.step(2);
    expect(t.scan().phase).toBe('aim');
    await h.close();
    expect(t.holds()).toBe(0);
  });
  it('a phone without the camera picture cannot scan: a plain sentence, nothing left open', async () => {
    const xr = system(['hit-test', 'anchors', 'dom-overlay']);
    const t = scanRig(xr);
    await expect(t.open()).rejects.toThrow(noCameraPictureMessage);
    expect(t.c.active).toBeNull();
    expect(xr.session!.ended).toBe(true);
    expect(t.holds()).toBe(0);
  });
  it('the panel reuses the World AR wording when AR is not there', () => {
    expect(scanBlockedReason({ state: 'ok', message: 'fine' })).toBeNull();
    expect(scanBlockedReason({ state: 'no-webxr', message: 'Computers have no AR camera.' })).toBe('Computers have no AR camera.');
    expect(depthReadout(true)).toBe('depth: yes');
    expect(depthReadout(false)).toBe('depth: no');
  });
});

describe('a walk round the target', () => {
  it('two full circles at two heights take a sensible number of photos and fill those two rows', async () => {
    const t = scanRig(system());
    const h = await t.open();
    await t.begin(h);
    expect(t.scan().phase).toBe('capture');
    await t.walk(20);
    const afterOne = t.scan();
    expect(afterOne.kept).toBeGreaterThan(24);
    expect(afterOne.kept).toBeLessThan(80);
    await t.walk(45, { startAz: 0.4 });
    const s = t.scan();
    expect(s.kept).toBeGreaterThan(40);
    expect(s.kept).toBeLessThan(160);
    // two rows of 24 cells out of 6 x 24: a third of the dome
    expect(s.coverage).toBeGreaterThan(0.3);
    expect(s.coverage).toBeLessThan(0.35);
    expect(s.line).toMatch(/^Coverage 3\d% · \d+ photos$/);
    expect(t.encodes.peak).toBeLessThanOrEqual(2); // never more than two encodes at once
    expect(t.painters[0].meshes).toBeGreaterThan(100); // the dome is drawn every frame
    // Done: the scan and its photos are saved, and the coverage computed from the stored data agrees
    await h.close();
    expect(t.outcomes.length).toBe(1);
    const out = t.outcomes[0];
    expect(out.error).toBeNull();
    expect(out.scan!.shots.length).toBe(s.kept);
    expect(t.added.map((f) => f.name).slice(0, 2)).toEqual(['Scan photo 001.jpg', 'Scan photo 002.jpg']);
    expect(out.assets.length).toBe(s.kept);
    expect(out.scan!.shots[0].asset).toBe('photo1');
    expect(out.scan!.units).toBe('m');
    expect(out.scan!.target.center).toEqual(CENTER);
    expect(out.scan!.target.radius).toBe(0.5);
    expect(out.scan!.target.up).toEqual(UP);
    expect(normalizeScan(out.scan).shots.length).toBe(s.kept); // the stored data is valid
    expect(coverageOf(out.scan!).fraction).toBeCloseTo(s.coverage, 9);
    // the stored pose and intrinsics put the target in the middle of every photo
    for (const shot of out.scan!.shots) {
      const px = projectToShot(shot, CENTER)!;
      expect(Math.abs(px[0] - shot.cx)).toBeLessThan(2);
      expect(Math.abs(px[1] - shot.cy)).toBeLessThan(2);
      expect(centreNdcInShot(shot, CENTER)![0]).toBeCloseTo(0, 1);
      expect(shot.w).toBe(1080);
      expect(shot.sharp).toBeGreaterThan(0.9);
    }
    expect(out.summary!.coverage).toBeCloseTo(s.coverage, 9);
    expect(out.summary!.rings).toBe(2);
  });

  it('fast motion takes nothing and says "Move slower"', async () => {
    const t = scanRig(system());
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { speed: 2.5, turns: 0.5 });
    expect(t.scan().kept).toBe(0);
    expect(t.painters[0].grabs).toBe(0);
    expect(t.scan().guidance).toBe('Move slower');
    expect(t.last().hint).toBe('Move slower');
    await h.close();
    expect(t.outcomes[0].scan).toBeNull();
    expect(t.outcomes[0].error).toMatch(/No photos/);
  });

  it('looking away from the object takes nothing and says "Aim at the object"', async () => {
    const t = scanRig(system());
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { away: true, turns: 0.6 });
    expect(t.scan().kept).toBe(0);
    expect(t.scan().guidance).toBe('Aim at the object');
    await h.close();
  });

  it('a blurry camera picture is left out with a hint and does not count for coverage', async () => {
    const t = scanRig(system());
    const h = await t.open();
    await t.begin(h);
    const dAz = (0.25 * 0.033) / 1.2;
    let az = 0;
    const go = async (frames: number, blur: boolean) => {
      t.painters[0].blur = blur;
      for (let i = 0; i < frames; i++, az += dAz) {
        const d = angleToDir(az, 20, UP);
        t.at([CENTER[0] + d[0] * 1.2, CENTER[1] + d[1] * 1.2, CENTER[2] + d[2] * 1.2]);
        await t.step();
      }
    };
    await go(500, false);
    const sharpKept = t.scan().kept;
    expect(sharpKept).toBeGreaterThan(8);
    const covered = t.scan().coverage;
    let sawHint = false;
    t.painters[0].blur = true;
    for (let i = 0; i < 400; i++, az += dAz) {
      const d = angleToDir(az, 20, UP);
      t.at([CENTER[0] + d[0] * 1.2, CENTER[1] + d[1] * 1.2, CENTER[2] + d[2] * 1.2]);
      await t.step();
      if (t.scan().notice === 'Too blurry, hold steadier') sawHint = true;
    }
    expect(sawHint).toBe(true);
    expect(t.scan().rejected).toBeGreaterThan(0);
    expect(t.scan().kept).toBe(sharpKept); // not one blurry photo was kept
    expect(t.scan().coverage).toBe(covered);
    await h.close();
    expect(t.outcomes[0].rejected).toBeGreaterThan(0);
    expect(t.outcomes[0].scan!.shots.every((s) => s.sharp > 0.9)).toBe(true);
  });

  it('automatic capture can be switched off; the shutter button then takes exactly one photo, wherever it is', async () => {
    const t = scanRig(system());
    const h = await t.open(false);
    await t.begin(h);
    await t.walk(20, { turns: 0.3 });
    expect(t.scan().kept).toBe(0);
    h.scan!.shutter();
    await t.step(3);
    expect(t.scan().kept).toBe(1);
    h.scan!.shutter(); // same spot again: a manual photo does not need a new viewpoint
    await t.step(3);
    expect(t.scan().kept).toBe(2);
    h.scan!.setAuto(true);
    await t.step(30);
    expect(t.scan().kept).toBe(2); // auto is on, but this is no new viewpoint
    expect(t.scan().flash).toBe(2);
    await h.close();
  });

  it('one skipped shot when the encodes are busy, never a queue', async () => {
    const t = scanRig(system(), { encodeDelay: 200 });
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { turns: 0.5 });
    expect(t.encodes.peak).toBeLessThanOrEqual(2);
    await h.close();
    expect(t.outcomes[0].scan).not.toBeNull();
  });
});

describe('saving', () => {
  it('an abrupt end of the session (Back button) still saves what was taken, once', async () => {
    const xr = system();
    const t = scanRig(xr);
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { turns: 0.4 });
    const kept = t.scan().kept;
    expect(kept).toBeGreaterThan(5);
    xr.session!.systemEnd();
    const end = await h.closed;
    expect(end.error).toBeNull();
    expect(t.outcomes.length).toBe(1);
    expect(t.outcomes[0].scan!.shots.length).toBe(kept);
    expect(t.added.length).toBe(kept);
    await h.close().catch(() => undefined); // closing after the end does not save twice
    expect(t.outcomes.length).toBe(1);
  });
  it('waits for photos still being encoded', async () => {
    const xr = system();
    const t = scanRig(xr, { encodeDelay: 30 });
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { turns: 0.2 });
    h.scan!.shutter();
    await t.step(1);
    const closing = h.close();
    await closing;
    expect(t.outcomes[0].scan!.shots.length).toBe(t.outcomes[0].assets.length);
    expect(t.outcomes[0].scan!.shots.length).toBeGreaterThan(0);
  });
});

describe('the depth probe', () => {
  it('granted: every photo carries a compact depth map and the readout says yes', async () => {
    const xr = system();
    xr.onSession = (s) => (s.depth = { width: 160, height: 90, metres: 1.3 });
    const t = scanRig(xr);
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { turns: 0.3 });
    expect(t.scan().depth).toBe(true);
    expect(t.scan().depthShots).toBe(t.scan().kept);
    await h.close();
    const out = t.outcomes[0];
    expect(out.depth).toBe(true);
    expect(out.scan!.shots.length).toBeGreaterThan(5);
    for (const s of out.scan!.shots) {
      const d = decodeDepth(s.depth!)!;
      expect(Math.max(d.width, d.height)).toBe(48);
      expect(d.rawValueToMeters).toBe(0.001);
      expect(d.data[0]).toBe(1300);
    }
  });
  it('denied: depth: no, and the shots have no depth at all', async () => {
    const t = scanRig(system(FEATURES));
    const h = await t.open();
    await t.begin(h);
    await t.walk(20, { turns: 0.3 });
    expect(t.scan().depth).toBe(false);
    await h.close();
    expect(t.outcomes[0].depth).toBe(false);
    expect(t.outcomes[0].scan!.shots.length).toBeGreaterThan(5);
    expect(t.outcomes[0].scan!.shots.every((s) => !('depth' in s))).toBe(true);
  });
});

describe('sizing the dome before the walk', () => {
  it('pinch and the Size strip change the radius within 0.1 to 5 m; it is fixed once the walk begins', async () => {
    const t = scanRig(system());
    const h = await t.open();
    at0(t);
    await t.step(2);
    t.c.active!.gesture({ type: 'pinch', factor: 1e-6 });
    await t.step(1);
    expect(t.scan().radius).toBeCloseTo(0.1, 6);
    h.gesture({ type: 'pinch', factor: 1e9 });
    await t.step(1);
    expect(t.scan().radius).toBe(5);
    h.gesture({ type: 'zoom-reset', });
    await t.step(1);
    expect(t.scan().radius).toBe(0.5);
    h.gesture({ type: 'zoom', dy: 100 });
    await t.step(1);
    expect(t.scan().radius).toBeGreaterThan(0.5);
    h.place();
    await t.step(2);
    expect(t.scan().phase).toBe('setup');
    const r = t.scan().radius;
    h.scan!.begin();
    await t.step(2);
    h.gesture({ type: 'pinch', factor: 2 });
    await t.step(1);
    expect(t.scan().radius).toBe(r);
    await h.close();
  });
});

function at0(t: ReturnType<typeof scanRig>) {
  t.at([0, 1.4, 0], [0, 0, -2]);
  // the fake session's surface under the middle of the screen
  (t.env.xr as FakeXrSystem).session!.hit = FLOOR_HIT;
}
