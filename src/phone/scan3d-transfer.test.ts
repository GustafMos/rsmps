// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PhoneScan3dSession } from '../io/phone-scan3d';
import { isScan3dFrame, SCAN3D_MAX_HELD, parseShotRecord, type ScanHeader } from './scan3d-protocol';
import { Scan3dUploader } from './scan3d-sender';
import { Wire, rng, type WireOpts } from './scan3d-fake-link';

const HEADER: ScanHeader = { v: 1, units: 'm', target: { center: [0.1, 0, -2], radius: 0.5, up: [0, 1, 0], h: 0.2 }, grid: { az: 24, el: 6 }, rejected: 2 };

function makeShot(i: number) {
  return {
    t: i * 0.5,
    pos: [Math.cos(i), 0.4 + (i % 3) * 0.1, -2 + Math.sin(i)] as [number, number, number],
    quat: [0, 0, 0, 1] as [number, number, number, number],
    w: 1440,
    h: 1080,
    fx: 1100.5,
    fy: 1100.5,
    cx: 720,
    cy: 540,
    sharp: 0.5 + (i % 5) / 20,
    ...(i % 2 ? { depth: 'AAAA' + i } : {}),
  };
}

function makeJpeg(i: number, r: () => number): Uint8Array {
  const len = [900, 40_000, 131_072, 300_001, 5_000, 270_000, 70_000, 1][i % 8] + 3;
  const b = new Uint8Array(len);
  for (let k = 0; k < len; k++) b[k] = Math.floor(r() * 256);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

interface Rig {
  clock: number;
  uploader: Scan3dUploader;
  session: PhoneScan3dSession;
  up: Wire;
  down: Wire;
  open: boolean;
  log: { json?: Record<string, unknown>; bin?: Uint8Array }[];
  step(): void;
  cut(): void;
  restore(): void;
}

function rig(seed: number, o: WireOpts, sid = 1234): Rig {
  const r = rng(seed);
  const up = new Wire(r, o);
  const down = new Wire(r, o);
  const t = { clock: 0, open: true } as Rig;
  t.up = up;
  t.down = down;
  t.log = [];
  // the computer: answers go down the other wire
  t.session = new PhoneScan3dSession('tok', { sendJson: (_tok, m) => down.push(t.clock, () => t.uploader.onMessage(JSON.parse(JSON.stringify(m)), t.clock)), now: () => t.clock }, () => undefined);
  t.uploader = new Scan3dUploader(
    {
      sendJson: (m) => {
        const copy = JSON.parse(JSON.stringify(m));
        t.log.push({ json: copy });
        up.push(t.clock, () => t.session.handleJson(JSON.parse(JSON.stringify(copy))));
      },
      sendBinary: (d) => {
        expect(isScan3dFrame(d)).toBe(true);
        const copy = d.slice();
        t.log.push({ bin: copy });
        up.push(t.clock, () => t.session.handleBinary(copy.slice()));
      },
      buffered: () => 0,
      isOpen: () => t.open,
    },
    sid,
  );
  t.step = () => {
    t.clock += 20;
    up.step(t.clock);
    down.step(t.clock);
    t.uploader.tick(t.clock);
  };
  t.cut = () => {
    t.open = false;
    up.clear();
    down.clear();
    t.uploader.onClose();
    t.session.setLinkLost(true);
  };
  t.restore = () => {
    t.open = true;
    t.session.ready(); // the phone's hello makes the computer say ready again
    t.uploader.onOpen(t.clock);
  };
  return t;
}

/** Run a whole scan: the "phone" produces `n` photos as fast as the back-pressure rule allows. */
function runScan(t: Rig, n: number, r: () => number, hooks: { atStep?: (step: number, made: number) => void } = {}): { photos: Uint8Array[]; shots: ReturnType<typeof makeShot>[] } {
  const photos: Uint8Array[] = [];
  const shots: ReturnType<typeof makeShot>[] = [];
  t.session.handleJson({ type: 'scan3d-header', sid: t.uploader.sid, target: HEADER.target, grid: HEADER.grid });
  let finished = false;
  for (let step = 0; step < 400_000; step++) {
    // the phone's scan session takes a new photo only when fewer than SCAN3D_MAX_HELD are held (encoding is instant here)
    if (photos.length < n && t.uploader.held() < SCAN3D_MAX_HELD && step % 3 === 0) {
      const i = photos.length;
      photos.push(makeJpeg(i, r));
      shots.push(makeShot(i));
      t.uploader.enqueue(i, makeShot(i), photos[i], t.clock);
    }
    hooks.atStep?.(step, photos.length);
    t.step();
    if (photos.length === n && !finished) {
      finished = true;
      t.uploader.finish(HEADER, n, shots.filter((s) => s.depth).length, t.clock);
    }
    if (t.uploader.state().finished) return { photos, shots };
  }
  throw new Error(`the scan did not finish: ${JSON.stringify(t.uploader.state())} received ${t.session.info.received}`);
}

function expectScan(t: Rig, photos: Uint8Array[], shots: ReturnType<typeof makeShot>[]): void {
  const res = t.session.result()!;
  expect(res.complete).toBe(true);
  expect(res.missing).toBe(0);
  expect(res.shots.map((s) => s.index)).toEqual(photos.map((_, i) => i)); // exactly once, in order
  res.shots.forEach((s, i) => {
    expect(Buffer.from(s.bytes).equals(Buffer.from(photos[i]))).toBe(true); // bytes identical
    expect(s.shot).toEqual(shots[i]);
  });
  expect(res.header).toEqual(HEADER); // the header of the phone's scan
  expect(t.uploader.state().finished).toMatchObject({ ok: true, count: photos.length, received: photos.length });
  expect(t.uploader.state().sent).toBe(photos.length);
}

describe('3D scan transfer over a fake link', () => {
  it('a clean link: every photo arrives once, in order, byte for byte', () => {
    const r = rng(1);
    const t = rig(1, { loss: 0, dup: 0, jitter: 3 });
    const { photos, shots } = runScan(t, 9, r);
    expectScan(t, photos, shots);
    expect(t.uploader.peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD);
    expect(t.session.info.phase).toBe('complete');
  });

  it('survives lost, repeated and reordered messages', () => {
    for (const seed of [2, 3, 4]) {
      const r = rng(seed * 11);
      const t = rig(seed, { loss: 0.12, dup: 0.15, jitter: 9 });
      const { photos, shots } = runScan(t, 10, r);
      expectScan(t, photos, shots);
      expect(t.uploader.peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD);
    }
  });

  it('a disconnect in the middle, then a reconnect: nothing lost, nothing stored twice', () => {
    const r = rng(7);
    const t = rig(7, { loss: 0.05, dup: 0.1, jitter: 6 });
    let cutAt = -1;
    const { photos, shots } = runScan(t, 12, r, {
      atStep(step, made) {
        // cut the link while the sixth photo is on its way, and bring it back a few seconds later
        if (cutAt < 0 && made >= 6 && t.uploader.state().sent >= 4 && t.up.pending > 0) {
          cutAt = step;
          t.cut();
        }
        if (cutAt >= 0 && step === cutAt + 150) t.restore();
      },
    });
    expect(cutAt).toBeGreaterThan(0);
    expectScan(t, photos, shots);
    expect(t.session.info.linkLost).toBe(false);
    expect(t.uploader.peakHeld).toBeLessThanOrEqual(SCAN3D_MAX_HELD);
  });

  it('a second delivery of everything the phone ever sent changes nothing', () => {
    const r = rng(9);
    const t = rig(9, { loss: 0, dup: 0, jitter: 2 });
    const { photos, shots } = runScan(t, 6, r);
    const before = t.session.result()!;
    for (const m of t.log) {
      if (m.json) t.session.handleJson(JSON.parse(JSON.stringify(m.json)));
      else t.session.handleBinary(m.bin!.slice());
    }
    for (let i = 0; i < 50; i++) t.step();
    expectScan(t, photos, shots);
    expect(t.session.result()!.shots.length).toBe(before.shots.length);
  });

  it('a damaged photo is refused and sent again; the stored bytes are the good ones', () => {
    const r = rng(5);
    const t = rig(5, { loss: 0, dup: 0, jitter: 2 });
    // flip a byte in the first binary frame of the second photo as it travels
    let hit = false;
    const orig = t.session.handleBinary.bind(t.session);
    t.session.handleBinary = (d) => {
      const u = d instanceof Uint8Array ? d : new Uint8Array(d);
      const id = new DataView(u.buffer, u.byteOffset).getUint32(5);
      if (id === 2 && !hit) {
        hit = true;
        u[20] ^= 0xff;
      }
      orig(u);
    };
    const { photos, shots } = runScan(t, 4, r);
    expect(hit).toBe(true);
    expectScan(t, photos, shots);
  });

  it('a new scan number on the same link starts a clean scan', () => {
    const r = rng(3);
    const t = rig(3, { loss: 0, dup: 0, jitter: 1 }, 11);
    runScan(t, 3, r);
    expect(t.session.info.received).toBe(3);
    t.session.handleJson({ type: 'scan3d-header', sid: 12, target: HEADER.target, grid: HEADER.grid });
    expect(t.session.info.sid).toBe(12);
    expect(t.session.info.received).toBe(0);
  });

  it('a photo without a usable camera position is refused', () => {
    expect(parseShotRecord(makeShot(1))).not.toBeNull();
    expect(parseShotRecord({ ...makeShot(1), pos: [0, NaN, 0] })).toBeNull();
    expect(parseShotRecord({ ...makeShot(1), w: 0 })).toBeNull();
    expect(parseShotRecord({ ...makeShot(1), depth: 5 })).toBeNull();
    expect(parseShotRecord(null)).toBeNull();
  });
});
