// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../engine/lib/motion-math';
import { angleToDir, coverageOf, lookAtQuat } from '../engine/lib/scan-coverage';
import type { ScanShot } from '../engine/lib/scan-data';
import { PhoneScan3dSession } from '../io/phone-scan3d';
import { FakeXrSession, FakeXrSystem, fakeTransform } from '../io/world-ar/fake-xr';
import type { ArPainter } from '../io/world-ar/loop';
import { checkWorldAr } from '../io/world-ar/support';
import { ScanRig, type ScanRigEnv, type ScanRigOpen, type ScanRigResult } from '../io/world-ar/scan-rig';
import type { ScanEnv, ScanGrab } from '../io/world-ar/scan-session';
import { createScan3dMode, supportLines, type Scan3dUi } from './scan3d';
import { SCAN3D_MAX_HELD } from './scan3d-protocol';
import { Wire, rng } from './scan3d-fake-link';

const CENTER: Vec3 = [0, 0, -2];
const UP: Vec3 = [0, 1, 0];
const FEATURES = ['hit-test', 'anchors', 'dom-overlay', 'camera-access', 'depth-sensing'];

class FakePainter implements ArPainter {
  begin() {}
  picture() {}
  ring() {}
  mesh() {}
  still(): ScanGrab | null {
    return { width: 1080, height: 1920 };
  }
}

class SpyRig extends ScanRig {
  kept: { shot: ScanShot; bytes: Uint8Array; index: number }[] = [];
  ended: ScanRigResult | null = null;
  override open(o: ScanRigOpen) {
    return super.open({
      ...o,
      onKeep: (shot, blob, index) => {
        o.onKeep?.(shot, blob, index);
        void blob.arrayBuffer().then((b) => this.kept.push({ shot: { ...shot }, bytes: new Uint8Array(b), index }));
      },
      onEnd: (r) => {
        this.ended = r;
        o.onEnd(r);
      },
    });
  }
}

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup(o: { features?: string[]; wire?: { loss: number; dup: number; jitter: number } } = {}) {
  const xr = new FakeXrSystem({ features: o.features ?? FEATURES });
  let clock = 0;
  const r = rng(21);
  const up = new Wire(r, o.wire ?? { loss: 0, dup: 0, jitter: 300 });
  const down = new Wire(r, o.wire ?? { loss: 0, dup: 0, jitter: 300 });
  let n = 0;
  const scanEnv: ScanEnv = {
    async encode() {
      // photos of different sizes, each a JPEG by its first bytes and different from the others
      const k = n++;
      const bytes = new Uint8Array(k % 5 === 0 ? 150_000 : 20_000 + k);
      for (let i = 3; i < bytes.length; i++) bytes[i] = (i * 31 + k * 7) & 255;
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      bytes[2] = 0xff;
      await Promise.resolve();
      return { blob: new Blob([bytes], { type: 'image/jpeg' }), variance: 400 };
    },
  };
  const env: ScanRigEnv = {
    xr,
    async makePainter(session) {
      return { painter: new FakePainter(), layer: (session as FakeXrSession).layer, dispose: () => undefined };
    },
    makeTransform: fakeTransform,
    makeScanEnv: () => scanEnv,
    now: () => clock,
    support: () => checkWorldAr({ secure: true, xr, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130', hasLayer: true }),
  };
  const rig = new SpyRig(env);
  const computer = new PhoneScan3dSession('tok', { sendJson: (_t, m) => down.push(clock, () => mode.onMessage(JSON.parse(JSON.stringify(m)))), now: () => clock }, () => undefined);
  const ui = { lines: [] as string[], label: '', enabled: false, press: null as (() => void) | null, problem: '' };
  const fakeUi: Scan3dUi = {
    show: () => undefined,
    lines: (l) => (ui.lines = l),
    start: (label, enabled, press) => {
      ui.label = label;
      ui.enabled = enabled;
      ui.press = press;
    },
    problem: (t) => (ui.problem = t),
  };
  const mode = createScan3dMode({
    send: (m) => {
      const c = JSON.parse(JSON.stringify(m));
      up.push(clock, () => computer.handleJson(c));
    },
    sendBinary: (d) => {
      const c = d.slice();
      up.push(clock, () => computer.handleBinary(c));
    },
    buffered: () => 0,
    isOpen: () => open,
    rig,
    overlay: () => null,
    ui: fakeUi,
    now: () => clock,
    every: () => () => undefined,
  });
  let open = true;
  const step = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      clock += 33;
      xr.session?.step(33);
      await tick();
      up.step(clock);
      down.step(clock);
      mode.tick();
    }
  };
  const at = (p: Vec3, aim: Vec3 = CENTER) => {
    xr.session!.viewer = { p, q: lookAtQuat(p, aim) };
  };
  const walk = async (el: number, dist = 1.2, turns = 1) => {
    const dAz = (0.25 * 0.033) / dist;
    for (let az = 0; az < turns * 2 * Math.PI; az += dAz) {
      const d = angleToDir(az, el, UP);
      at([CENTER[0] + d[0] * dist, CENTER[1] + d[1] * dist, CENTER[2] + d[2] * dist]);
      await step();
    }
  };
  return { xr, rig, mode, computer, ui, up, down, step, at, walk, setOpen: (v: boolean) => (open = v), clock: () => clock };
}

describe('the phone page in 3D scan mode, driven by a fake AR session', () => {
  it('says why a phone cannot scan, in the words of the app, and does not offer Start', async () => {
    const xr = new FakeXrSystem({ features: FEATURES });
    const t = setup();
    // a browser with no WebXR on a secure page
    const bare = new ScanRig({ xr: null, makePainter: async () => ({ painter: new FakePainter(), layer: {} as never, dispose: () => undefined }), now: () => 0, support: () => checkWorldAr({ secure: true, xr: null, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome', hasLayer: false }) });
    const ui = { lines: [] as string[], press: 'unset' as unknown };
    const m = createScan3dMode({ send: () => undefined, sendBinary: () => undefined, buffered: () => 0, isOpen: () => true, rig: bare, overlay: () => null, every: () => () => undefined, ui: { show: () => undefined, lines: (l) => (ui.lines = l), start: (_l, _e, p) => (ui.press = p), problem: () => undefined } });
    await m.enter();
    expect(ui.lines.join(' ')).toContain('Computers have no AR camera');
    expect(ui.press).toBeNull();
    expect(supportLines({ state: 'insecure', message: 'AR only works on a secure page (https). Open the app through its https address.' }).join(' ')).toMatch(/accept the certificate/);
    expect(supportLines({ state: 'ok', message: 'x' })[0]).toMatch(/can do an AR scan/);
    void xr;
    void t;
  });

  it('a full scan goes to the computer: same photos, same positions, same header, coverage agrees, memory stays small', async () => {
    const t = setup();
    await t.mode.enter();
    await t.step(20); // the phone's first message reaches the computer
    expect(t.computer.info.support?.state).toBe('ok');
    expect(t.ui.enabled).toBe(true);
    t.ui.press!(); // the Start button
    await t.step(2);
    expect(t.rig.active).not.toBeNull();
    // find the surface, tap, press Start: the walk begins
    t.at([0, 1.4, 0], CENTER);
    t.xr.session!.hit = { p: CENTER, q: [0, 0, 0, 1] };
    await t.step(2);
    t.rig.active!.place();
    await t.step(2);
    t.rig.active!.scan!.begin();
    await t.step(25);
    expect(t.computer.info.header?.target.center).toEqual(CENTER); // the dome reached the computer when the walk began

    let sawSending = false;
    let peakHeld = 0;
    for (const el of [20, 45]) {
      const dist = 1.2;
      const dAz = (0.25 * 0.033) / dist;
      for (let az = el === 45 ? 0.4 : 0; az < (el === 45 ? 0.4 : 0) + 2 * Math.PI; az += dAz) {
        const d = angleToDir(az, el, UP);
        t.at([CENTER[0] + d[0] * dist, CENTER[1] + d[1] * dist, CENTER[2] + d[2] * dist]);
        await t.step();
        const g = t.rig.active?.state().scan?.guidance ?? '';
        if (g === 'Sending photos…') sawSending = true;
        peakHeld = Math.max(peakHeld, t.mode.uploader?.held() ?? 0);
      }
    }
    expect(t.rig.kept.length).toBeGreaterThan(40);
    expect(sawSending).toBe(true); // the link is slower than the capture: automatic capture waited
    expect(peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD);
    expect(t.mode.uploader!.peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD);
    // while walking, the computer already shows live numbers
    expect(t.computer.info.status?.phase).toBe('capture');
    expect(t.computer.info.status!.kept).toBeGreaterThan(0);

    // Done: the view closes, the last photos are sent, the computer has the whole scan
    await t.rig.active!.close();
    for (let i = 0; i < 4000 && !t.mode.uploader!.state().finished; i++) await t.step();
    const ended = t.rig.ended!;
    expect(ended.error).toBeNull();
    expect(ended.blobs.length).toBe(0); // the phone did not keep the photos
    const res = t.computer.result()!;
    expect(t.computer.info.phase).toBe('complete');
    expect(res.complete).toBe(true);
    expect(res.shots.length).toBe(ended.scan!.shots.length);
    expect(res.shots.length).toBe(t.rig.kept.length);
    // photos and positions: exactly the phone's, in order
    t.rig.kept.sort((a, b) => a.index - b.index);
    res.shots.forEach((s, i) => {
      const { asset: _a, ...phoneShot } = t.rig.kept[i].shot;
      expect(s.index).toBe(i);
      expect(s.shot).toEqual(phoneShot);
      expect(Buffer.from(s.bytes).equals(Buffer.from(t.rig.kept[i].bytes))).toBe(true);
    });
    // the header is what a local scan would hold
    expect(res.header).toEqual({ v: 1, units: 'm', target: ended.scan!.target, grid: ended.scan!.grid, ...(ended.rejected ? { rejected: ended.rejected } : {}) });
    // the computer's own coverage equals the phone's
    const local = coverageOf(ended.scan!).fraction;
    expect(t.computer.recomputedCoverage()).toBeCloseTo(local, 9);
    expect(t.computer.info.status!.coverage).toBeCloseTo(local, 2);
    expect(t.mode.uploader!.state().finished).toMatchObject({ ok: true, received: res.shots.length });
  });

  it('a short disconnect in the middle of the walk loses nothing', async () => {
    const t = setup({ wire: { loss: 0, dup: 0, jitter: 60 } });
    await t.mode.enter();
    await t.step(20); // the phone's first message reaches the computer
    t.ui.press!();
    await t.step(2);
    t.at([0, 1.4, 0], CENTER);
    t.xr.session!.hit = { p: CENTER, q: [0, 0, 0, 1] };
    await t.step(2);
    t.rig.active!.place();
    await t.step(2);
    t.rig.active!.scan!.begin();
    await t.step(3);
    let cut = false;
    let cutAt = -1;
    const dist = 1.2;
    const dAz = (0.25 * 0.033) / dist;
    let i = 0;
    for (let az = 0; az < 2 * Math.PI; az += dAz, i++) {
      const d = angleToDir(az, 20, UP);
      t.at([CENTER[0] + d[0] * dist, CENTER[1] + d[1] * dist, CENTER[2] + d[2] * dist]);
      await t.step();
      if (!cut && t.mode.uploader!.state().sent >= 6) {
        cut = true;
        cutAt = i;
        t.setOpen(false);
        t.up.clear();
        t.down.clear();
        t.mode.onClose();
        t.computer.setLinkLost(true);
      }
      if (cut && i === cutAt + 90) {
        // back after about three seconds
        t.setOpen(true);
        t.computer.ready();
        t.mode.onOpen();
      }
    }
    expect(cut).toBe(true);
    expect(t.mode.uploader!.peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD); // capture waited while the link was down
    await t.rig.active!.close();
    for (let k = 0; k < 6000 && !t.mode.uploader!.state().finished; k++) await t.step();
    const res = t.computer.result()!;
    expect(res.complete).toBe(true);
    expect(res.shots.map((s) => s.index)).toEqual(res.shots.map((_, k) => k));
    expect(res.shots.length).toBe(t.rig.kept.length);
    expect(t.computer.info.linkLost).toBe(false);
  });

  it('the computer pressing Stop ends the walk like Done', async () => {
    const t = setup({ wire: { loss: 0, dup: 0, jitter: 5 } });
    await t.mode.enter();
    await t.step(20); // the phone's first message reaches the computer
    t.ui.press!();
    await t.step(2);
    t.at([0, 1.4, 0], CENTER);
    t.xr.session!.hit = { p: CENTER, q: [0, 0, 0, 1] };
    await t.step(2);
    t.rig.active!.place();
    await t.step(2);
    t.rig.active!.scan!.begin();
    await t.step(3);
    await t.walk(20, 1.2, 0.2);
    t.computer.requestStop();
    for (let k = 0; k < 3000 && !t.mode.uploader!.state().finished; k++) await t.step();
    expect(t.rig.active).toBeNull();
    expect(t.computer.info.phase).toBe('complete');
    expect(t.computer.result()!.shots.length).toBeGreaterThan(3);
  });
});
