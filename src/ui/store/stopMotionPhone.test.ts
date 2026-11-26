// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Io, PhoneState } from '../../io/api';
import { PhoneStopMotionStore } from '../../io/phone-stopmotion';
import { ShotSender, type OutShot } from '../../phone/stopmotion-protocol';
import type { Shot } from '../../engine/lib/stop-motion';
import type { Editor } from './editor';
import { StopMotionController, type StopMotionEnv } from './stopMotion';

type Msg = Record<string, unknown>;
const TOKEN = 't'.repeat(32);

function setup(opts: { withCamera?: boolean } = {}) {
  const toasts: string[] = [];
  const sets: [string, string, unknown][] = [];
  const params: Record<string, unknown> = { shots: [], interval: 2, stopAfter: 0, shotSize: 'full', onion: true, onionStrength: 0.4, onionFrames: 1, fps: 12 };
  const nodes = [
    { id: 'sm', type: 'stop-motion', params },
    ...(opts.withCamera ? [{ id: 'cam', type: 'camera-in', params: {} }] : []),
  ];
  const graph = { project: { fps: 30 }, nodes, edges: opts.withCamera ? [{ id: 'e1', from: { node: 'cam', port: 'image' }, to: { node: 'sm', port: 'image' } }] : [] };
  const ed = {
    state: { graph },
    setParam: (id: string, key: string, value: unknown) => {
      sets.push([id, key, value]);
      nodes.find((n) => n.id === id)!.params[key] = value;
    },
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor;

  // the phone side of the wire: a sender whose messages go into the store, and the store's answers come back to it
  const toPhone: Msg[] = [];
  let sender: ShotSender | null = null;
  const store = new PhoneStopMotionStore({
    sendJson: (_t, m) => {
      toPhone.push(m);
      if (sender) sender.onMessage(m, 0);
    },
  });
  let phoneState: PhoneState = 'connected';
  const stateListeners = new Set<(t: string, s: PhoneState, d: string, p: 'connected') => void>();
  const phone = {
    available: true,
    stopmotion: store,
    state: () => phoneState,
    onState: (fn: (t: string, s: PhoneState, d: string, p: 'connected') => void) => (stateListeners.add(fn), () => stateListeners.delete(fn)),
  };
  const setLink = (s: PhoneState) => {
    phoneState = s;
    stateListeners.forEach((f) => f(TOKEN, s, '', 'connected'));
  };

  let n = 0;
  const added: string[] = [];
  const grab = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
  const io = {
    player: { grabNode: grab },
    library: { add: async (files: File[]) => files.map((f) => (added.push(f.name), { id: `a${++n}`, name: f.name })) },
    liveRecorder: { state: 'idle', onFinished: () => () => undefined },
    phone,
  } as unknown as Io;
  const timers: { at: number; fn: () => void }[] = [];
  let clock = 0;
  const env: StopMotionEnv = { now: () => clock, later: (ms, fn) => (timers.push({ at: clock + ms, fn }), () => undefined), wakeLock: async () => null };
  const c = new StopMotionController(ed, io, env);

  const shots = () => params.shots as Shot[];
  /** The phone says hello and starts a sender wired to the store. */
  const phoneHello = () => {
    store.phoneMode(TOKEN, true);
    store.ingest(TOKEN, { type: 'sm-hello', sid: 'phonesid1', next: 1 });
    sender = new ShotSender('phonesid1', { send: (m) => store.ingest(TOKEN, m), buffered: () => 0, isOpen: () => true }, { onChange: () => undefined, onStored: () => undefined, onFailed: () => undefined }, { chunkBytes: 4 });
    return sender;
  };
  const wait = () => new Promise((r) => setTimeout(r, 0));
  const send = async (s: ShotSender, shot: Partial<OutShot> & { n: number }) => {
    s.enqueue({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, shot.n]), mime: 'image/jpeg', w: 4, h: 3, ...shot }, 0);
    for (let i = 0; i < 5; i++) await wait();
  };
  const cmds = () => toPhone.filter((m) => m.type === 'sm-cmd').map((m) => m.cmd);
  return { c, store, shots, params, sets, toasts, added, grab, toPhone, phoneHello, send, cmds, setLink, wait, ed };
}

describe('Stop Motion with a linked phone: shots arrive', () => {
  it('a received still becomes Media and one shot, as one undo step, and is acknowledged', async () => {
    const t = setup();
    t.c.linkPhone('sm', TOKEN);
    const phone = t.phoneHello();
    let stored = 0;
    (phone as unknown as { hooks: { onStored(n: number): void } }).hooks.onStored = () => stored++;
    await t.send(phone, { n: 1 });
    await t.send(phone, { n: 2 });
    expect(t.shots().map((s) => s.asset)).toEqual(['a1', 'a2']);
    expect(t.shots().every((s) => s.kind === 'still')).toBe(true);
    expect(t.added).toEqual(['Stop motion shot 1.jpg', 'Stop motion shot 2.jpg']);
    expect(t.sets.filter(([, k]) => k === 'shots').length).toBe(2); // one setParam, so one undo step, per shot
    expect(stored).toBe(2);
    expect(t.c.store.get().phone).toMatchObject({ state: 'connected', received: 2 });
    expect(t.toPhone.filter((m) => m.type === 'sm-count').pop()).toEqual({ type: 'sm-count', shots: 2 });
    t.c.dispose();
  });

  it('keeps the phone waiting when no Stop Motion is chosen, and the picture arrives once it is', async () => {
    const t = setup();
    const phone = t.phoneHello(); // not linked to a node yet
    await t.send(phone, { n: 1 });
    expect(t.shots()).toEqual([]);
    expect(phone.unsent).toBe(1);
    expect(phone.waiting).toBe(true);
    t.c.linkPhone('sm', TOKEN);
    (phone as unknown as { tick(n: number): void }).tick(5000);
    for (let i = 0; i < 6; i++) await t.wait();
    phone.tick(10_000);
    for (let i = 0; i < 6; i++) await t.wait();
    expect(t.shots().length).toBe(1);
    t.c.dispose();
  });
});

describe('Stop Motion with a linked phone: the computer drives the phone', () => {
  it('Take picture is the remote shutter: it sends the command, grabs nothing here, and the shot appears when it arrives', async () => {
    const t = setup({ withCamera: true });
    t.c.linkPhone('sm', TOKEN);
    const phone = t.phoneHello();
    expect(await t.c.take('sm')).toBe(true);
    expect(t.cmds()).toEqual(['shoot']);
    expect(t.grab).not.toHaveBeenCalled();
    expect(t.c.store.get().phone.asked).toBe(true);
    expect(t.shots()).toEqual([]);
    await t.send(phone, { n: 1 });
    expect(t.shots().length).toBe(1);
    expect(t.c.store.get().phone.asked).toBe(false);
    t.c.dispose();
  });

  it('Undo last removes the last shot and tells the phone which one went', async () => {
    const t = setup();
    t.c.linkPhone('sm', TOKEN);
    const phone = t.phoneHello();
    await t.send(phone, { n: 1 });
    await t.send(phone, { n: 2 });
    t.c.undoLast('sm');
    expect(t.shots().map((s) => s.asset)).toEqual(['a1']);
    expect(t.toPhone.filter((m) => m.type === 'sm-removed').pop()).toEqual({ type: 'sm-removed', sid: 'phonesid1', n: 2 });
    expect(phone.unsent).toBe(0);
    t.c.dispose();
  });

  it('the phone Undo removes the very shot it means, even when it is not the last one in the node', async () => {
    const t = setup();
    t.c.linkPhone('sm', TOKEN);
    const phone = t.phoneHello();
    await t.send(phone, { n: 1 });
    await t.send(phone, { n: 2 });
    t.c.hold('sm', 0, 2); // the animator edited the strip meanwhile
    t.c.move('sm', 0, 1); // shot 1 is now second: [a2, a1]
    phone.undo(1, 0);
    await t.wait();
    expect(t.shots().map((s) => s.asset)).toEqual(['a2']);
    t.c.dispose();
  });

  it('Auto shoot from the computer runs on the phone: the command goes out and the phone status drives the button', async () => {
    const t = setup({ withCamera: true });
    t.c.linkPhone('sm', TOKEN);
    t.phoneHello();
    t.c.startAuto('sm');
    expect(t.cmds()).toEqual(['auto-start']);
    expect(t.grab).not.toHaveBeenCalled(); // no local timer, no local grab
    t.store.ingest(TOKEN, { type: 'sm-status', unsent: 0, progress: null, shots: 3, auto: { running: true, count: 3, limit: 10, nextInMs: 1500 }, note: '', locked: false });
    expect(t.c.store.get().auto).toMatchObject({ running: true, count: 3, limit: 10 });
    t.c.stopAuto();
    expect(t.cmds()).toEqual(['auto-start', 'auto-stop']);
    t.store.ingest(TOKEN, { type: 'sm-status', unsent: 0, progress: null, shots: 3, auto: { running: false, count: 3, limit: 10, nextInMs: 0 }, note: '', locked: false });
    expect(t.c.store.get().auto.running).toBe(false);
    t.c.dispose();
  });

  it('settings: the node goes to the phone, and a change on the phone goes into the node', async () => {
    const t = setup();
    t.c.linkPhone('sm', TOKEN);
    t.phoneHello();
    t.c.syncPhoneSettings();
    expect(t.toPhone.filter((m) => m.type === 'sm-settings').pop()).toMatchObject({ maxSide: 0, onion: true, interval: 2 });
    t.ed.setParam('sm', 'shotSize', '1080');
    t.c.syncPhoneSettings();
    expect(t.toPhone.filter((m) => m.type === 'sm-settings').pop()).toMatchObject({ maxSide: 1080 });
    t.store.ingest(TOKEN, { type: 'sm-set', patch: { onion: false, interval: 5, maxSide: 720 } });
    expect(t.params).toMatchObject({ onion: false, interval: 5, shotSize: '720' });
    expect(t.toPhone.filter((m) => m.type === 'sm-settings').pop()).toMatchObject({ onion: false, interval: 5, maxSide: 720 });
    t.c.dispose();
  });
});

describe('Stop Motion with a linked phone: the link drops', () => {
  it('shows it, stops the remote auto shoot, and shooting here works again', async () => {
    const t = setup({ withCamera: true });
    t.c.linkPhone('sm', TOKEN);
    t.phoneHello();
    t.store.ingest(TOKEN, { type: 'sm-status', unsent: 0, progress: null, shots: 0, auto: { running: true, count: 1, limit: 0, nextInMs: 900 }, note: '', locked: false });
    expect(t.c.store.get().auto.running).toBe(true);
    t.setLink('disconnected');
    expect(t.c.store.get().phone.state).toBe('dropped');
    expect(t.c.store.get().auto.running).toBe(false);
    expect(t.toasts.some((m) => /phone is not connected/.test(m))).toBe(true);
    expect(await t.c.take('sm')).toBe(true); // local grab, no command to the phone
    expect(t.grab).toHaveBeenCalledTimes(1);
    expect(t.cmds()).toEqual([]);
    expect(t.shots().length).toBe(1);
    t.setLink('connected');
    expect(t.c.store.get().phone.state).toBe('connected');
    t.c.dispose();
  });

  it('a picture that was on the way when the link dropped is delivered after the reconnect, once', async () => {
    const t = setup();
    t.c.linkPhone('sm', TOKEN);
    const phone = t.phoneHello();
    phone.enqueue({ n: 1, bytes: new Uint8Array(40).fill(9), mime: 'image/jpeg', w: 4, h: 3 }, 0);
    await t.wait();
    phone.onClose();
    t.setLink('disconnected');
    t.setLink('connected');
    t.store.ingest(TOKEN, { type: 'sm-hello', sid: 'phonesid1', next: 2 });
    phone.onOpen(10);
    for (let i = 0; i < 8; i++) await t.wait();
    expect(t.shots().length).toBe(1);
    expect(phone.unsent).toBe(0);
    t.c.dispose();
  });
});
