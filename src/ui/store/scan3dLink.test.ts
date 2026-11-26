// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('./editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { addNode, createGraph } = await import('../../engine/graph');
const { LinkedScanRun, linkPhoneForScan3d, phoneLinkBlockedReason, linkedScanMessage } = await import('./scan3dLink');
const { PhoneScan3dStore } = await import('../../io/phone-scan3d');
const { Scan3dUploader } = await import('../../phone/scan3d-sender');
const { Wire, rng } = await import('../../phone/scan3d-fake-link');
import { isScanData, normalizeScan } from '../../engine/lib/scan-data';
import type { Io } from '../../io/api';

const registry = new Registry();
registerBuiltins(registry);

const TARGET = { center: [0, 0, -2] as [number, number, number], radius: 0.5, up: [0, 1, 0] as [number, number, number] };
const GRID = { az: 24, el: 6 };

function shot(i: number) {
  const az = (i / 24) * Math.PI * 2;
  return { t: i, pos: [Math.cos(az) * 1.2, 0.5, -2 + Math.sin(az) * 1.2] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], w: 1080, h: 1920, fx: 1500, fy: 1500, cx: 540, cy: 960, sharp: 0.9 };
}
function jpeg(i: number): Uint8Array {
  const b = new Uint8Array(3000 + i);
  b.fill(i + 1);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

function setup(o: { linked?: string | null } = {}) {
  const adds: File[][] = [];
  let nextAsset = 1;
  const store = new PhoneScan3dStore({ sendJson: (token, m) => sent.push({ token, m }) });
  const sent: { token: string; m: Record<string, unknown> }[] = [];
  const setMode = vi.fn();
  const createSession = vi.fn(async (opts?: { mode?: string }) => ({ token: 'newtoken', url: 'https://x/phone?token=newtoken', qrSvg: '<svg/>', expiresAt: 0, mode: opts?.mode }));
  const io = {
    registry,
    library: {
      list: () => [],
      add: async (files: File[]) => {
        adds.push(files);
        return files.map((f) => ({ id: `asset${nextAsset++}`, name: f.name }));
      },
    },
    player: { getState: () => ({ seconds: 0 }) },
    phone: { available: true, scan3d: store, linked: () => o.linked ?? null, setMode, createSession, startServer: vi.fn(async () => ({ ok: true })) },
  } as unknown as Io;
  const ed = new Editor(io);
  const r = addNode(createGraph('t'), registry, 'scan-3d', { x: 0, y: 0 });
  ed.loadGraph(r.graph);
  const toasts: string[] = [];
  ed.toast = ((text: string) => void toasts.push(text)) as never;
  const nodeScan = () => ed.state.graph.nodes.find((n) => n.id === r.node.id)!.params.scan;
  return { io, ed, store, nodeId: r.node.id, adds, setMode, createSession, toasts, nodeScan, sent };
}

/** The phone side, over a clean link: send `n` photos of a scan, and (when `done`) the final message. */
function phoneSends(store: InstanceType<typeof PhoneScan3dStore>, token: string, n: number, opts: { done: boolean; kept?: number; sid?: number } = { done: true }): void {
  let clock = 0;
  const sid = opts.sid ?? 77;
  const down = new Wire(rng(1), { loss: 0, dup: 0, jitter: 2 });
  const up = new Wire(rng(2), { loss: 0, dup: 0, jitter: 2 });
  const sess = store.session(token);
  const real = (store as unknown as { deps: { sendJson: (t: string, m: Record<string, unknown>) => void } }).deps;
  const orig = real.sendJson;
  real.sendJson = (t, m) => {
    orig(t, m);
    down.push(clock, () => up_.onMessage(JSON.parse(JSON.stringify(m)), clock));
  };
  const up_ = new Scan3dUploader(
    {
      sendJson: (m) => up.push(clock, () => store.ingestJson(token, JSON.parse(JSON.stringify(m)))),
      sendBinary: (d) => {
        const c = d.slice();
        up.push(clock, () => store.ingestBinary(token, c));
      },
      buffered: () => 0,
      isOpen: () => true,
    },
    sid,
  );
  store.ingestJson(token, { type: 'scan3d-header', sid, target: TARGET, grid: GRID });
  store.ingestJson(token, { type: 'scan3d-status', sid, phase: 'capture', kept: opts.kept ?? n, sent: 0, rejected: 1, coverage: 0.4, grid: GRID, cells: new Array(144).fill(1), guidance: 'Walk on.', depth: false, depthShots: 0, picture: { width: 1080, height: 1920 }, sending: false });
  for (let i = 0; i < n; i++) {
    up_.enqueue(i, shot(i), jpeg(i), clock);
    for (let k = 0; k < 400 && up_.held() > 0; k++) {
      clock += 5;
      up.step(clock);
      down.step(clock);
      up_.tick(clock);
    }
  }
  if (opts.done) {
    up_.finish({ v: 1, units: 'm', target: TARGET, grid: GRID, rejected: 1 }, n, 0, clock);
    for (let k = 0; k < 100; k++) {
      clock += 5;
      up.step(clock);
      down.step(clock);
      up_.tick(clock);
    }
  }
  real.sendJson = orig;
  void sess;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('receiving a scan from a linked phone', () => {
  it('writes the node and Media as ONE undo step, and the scan is the same shape a local scan has', async () => {
    const t = setup();
    const before = t.nodeScan();
    const undoable = t.ed.state.canUndo;
    const run = new LinkedScanRun(t as never, t.nodeId, 'tok');
    run.start();
    phoneSends(t.store, 'tok', 6);
    await flush();
    await flush();
    expect(run.outcome).not.toBeNull();
    expect(run.outcome!.how).toBe('done');
    expect(t.adds.length).toBe(1); // one batch into Media
    expect(t.adds[0].map((f) => f.name)).toEqual(['Scan photo 001.jpg', 'Scan photo 002.jpg', 'Scan photo 003.jpg', 'Scan photo 004.jpg', 'Scan photo 005.jpg', 'Scan photo 006.jpg']);
    expect(Buffer.from(await t.adds[0][3].arrayBuffer()).equals(Buffer.from(jpeg(3)))).toBe(true);
    const scan = t.nodeScan();
    expect(isScanData(scan)).toBe(true);
    const n = normalizeScan(scan);
    expect(n.shots.length).toBe(6);
    expect(n.shots.map((s) => s.asset)).toEqual(['asset1', 'asset2', 'asset3', 'asset4', 'asset5', 'asset6']);
    expect(n.target).toEqual({ ...TARGET });
    expect(n.grid).toEqual(GRID);
    expect(n.rejected).toBe(1);
    expect(n.shots[2].pos).toEqual(shot(2).pos);
    expect(t.toasts.at(-1)).toMatch(/^Scan saved from the phone: 6 photos, coverage \d+%/);
    // one undo step takes the whole scan out of the node again
    t.ed.undo();
    expect(t.nodeScan()).toEqual(before);
    expect(t.ed.state.canUndo).toBe(undoable);
    run.dispose();
  });

  it('a dropped link keeps the partial scan and says how many photos arrived', async () => {
    const t = setup();
    let fire: (() => void) | null = null;
    const run = new LinkedScanRun(t as never, t.nodeId, 'tok', { graceMs: 30_000, setTimer: (fn) => ((fire = fn), 1), clearTimer: () => ((fire = null), undefined) });
    run.start();
    phoneSends(t.store, 'tok', 5, { done: false, kept: 8 });
    t.store.linkLost('tok', true);
    expect(fire).not.toBeNull(); // waiting for the phone to come back
    expect(run.outcome).toBeNull();
    expect(t.nodeScan()).toBeFalsy(); // nothing written yet: nothing to undo
    // the phone comes back in time: the wait is over, nothing is written
    t.store.linkLost('tok', false);
    expect(fire).toBeNull();
    t.store.linkLost('tok', true);
    fire!();
    await flush();
    await flush();
    expect(run.outcome!.how).toBe('lost');
    expect(run.outcome!.photos).toBe(5);
    expect(run.outcome!.phoneKept).toBe(8);
    expect(run.outcome!.message).toContain('The link to the phone was lost. Kept the 5 photos that arrived of the 8 the phone took');
    const n = normalizeScan(t.nodeScan());
    expect(n.shots.length).toBe(5); // usable: a valid scan with its dome
    expect(n.target.center).toEqual(TARGET.center);
    t.ed.undo();
    expect(t.nodeScan()).toBeFalsy();
    run.dispose();
  });

  it('"Keep what arrived" writes the photos that are here without waiting', async () => {
    const t = setup();
    const run = new LinkedScanRun(t as never, t.nodeId, 'tok');
    run.start();
    phoneSends(t.store, 'tok', 4, { done: false, kept: 4 });
    const out = await run.keepWhatArrived();
    expect(out!.how).toBe('kept');
    expect(out!.photos).toBe(4);
    expect(normalizeScan(t.nodeScan()).shots.length).toBe(4);
    // a second press does not write again
    expect(await run.keepWhatArrived()).toBe(out);
    expect(t.adds.length).toBe(1);
    run.dispose();
  });

  it('with no photos nothing is written and the words say so', async () => {
    const t = setup();
    const run = new LinkedScanRun(t as never, t.nodeId, 'tok');
    run.start();
    expect(await run.keepWhatArrived()).toBeNull();
    expect(t.toasts.at(-1)).toBe('No photos arrived from the phone, so nothing was saved.');
    expect(t.adds.length).toBe(0);
    run.dispose();
  });

  it('the message words', () => {
    expect(linkedScanMessage({ how: 'done', photos: 1, phoneKept: 1, missing: 0 }, 0.5, 'Not enough')).toContain('1 photo, coverage 50%');
    expect(linkedScanMessage({ how: 'kept', photos: 3, phoneKept: 3, missing: 0 }, null, 'Fine')).toBe('Stopped before the phone finished. Kept the 3 photos that arrived. Fine. Undo takes it out of the node again.');
  });
});

describe('linking the phone', () => {
  it('reuses a phone that is already linked: it is switched to 3D scan mode and no second QR code is made', async () => {
    const t = setup({ linked: 'abc' });
    const l = await linkPhoneForScan3d(t.io);
    expect(l).toEqual({ token: 'abc', reused: true });
    expect(t.setMode).toHaveBeenCalledWith('abc', 'scan3d');
    expect(t.createSession).not.toHaveBeenCalled();
  });
  it('otherwise makes a link that opens the phone page in 3D scan mode', async () => {
    const t = setup();
    const l = await linkPhoneForScan3d(t.io, 'https://192.168.1.5:5174');
    expect(l.reused).toBe(false);
    expect(l.token).toBe('newtoken');
    expect(t.createSession).toHaveBeenCalledWith({ address: 'https://192.168.1.5:5174', mode: 'scan3d' });
    expect(t.setMode).not.toHaveBeenCalled();
  });
  it('says plainly when there is no phone link in this version', () => {
    expect(phoneLinkBlockedReason({ phone: { available: false } } as never)).toMatch(/desktop app, or the web version started with npm run dev:lan/);
    expect(phoneLinkBlockedReason({ phone: { available: true, scan3d: {} } } as never)).toBeNull();
  });
});
