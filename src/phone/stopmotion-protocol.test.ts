// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PhoneStopMotionStore } from '../io/phone-stopmotion';
import { crc32 } from './scan-protocol';
import { DEFAULT_SETTINGS, MAX_QUEUE, ShotReceiver, ShotSender, cleanPatch, parseSettings, parseStatus, type ReceivedShot, type SinkResult } from './stopmotion-protocol';

type Msg = Record<string, unknown>;

function pic(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

/** A pretend WebSocket pair with loss, duplicates, reordering and a switch for "the connection is down". */
class Link {
  open = true;
  loss = 0;
  dup = 0;
  shuffle = false;
  /** Called for each message on its way; return a changed copy to damage it. */
  tamper: ((m: Msg, dir: 'up' | 'down') => Msg) | null = null;
  up: Msg[] = [];
  down: Msg[] = [];
  private seed = 12345;
  private rnd() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 2 ** 32;
  }
  fromPhone = (m: Msg) => void (this.open && this.up.push(m));
  fromComputer = (m: Msg) => void (this.open && this.down.push(m));
  /** Deliver everything in flight, both ways, until quiet. */
  flush(toComputer: (m: Msg) => void, toPhone: (m: Msg) => void, rounds = 200): void {
    for (let r = 0; r < rounds && (this.up.length || this.down.length); r++) {
      for (const [q, deliver, dir] of [
        [this.up, toComputer, 'up'],
        [this.down, toPhone, 'down'],
      ] as const) {
        let batch = q.splice(0);
        if (this.shuffle) batch = batch.map((m) => [this.rnd(), m] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
        for (let m of batch) {
          if (this.loss && this.rnd() < this.loss) continue;
          if (this.tamper) m = this.tamper(m, dir);
          deliver(m);
          if (this.dup && this.rnd() < this.dup) deliver(m);
        }
      }
    }
  }
}

function rig(opts: { chunkBytes?: number; sink?: (s: ReceivedShot) => Promise<SinkResult>; maxQueue?: number } = {}) {
  const link = new Link();
  const added: { n: number; bytes: Uint8Array; asset: string }[] = [];
  const removed: string[] = [];
  const stored: number[] = [];
  const failed: [number, string][] = [];
  let assets = 0;
  const receiver = new ShotReceiver(
    link.fromComputer,
    () => ({
      add:
        opts.sink ??
        (async (s) => {
          const asset = `a${++assets}`;
          added.push({ n: s.n, bytes: s.bytes, asset });
          return { ok: true, asset };
        }),
      remove: (a) => void removed.push(a),
    }),
  );
  const sender = new ShotSender(
    'sidaaaa1',
    { send: link.fromPhone, buffered: () => 0, isOpen: () => link.open },
    { onChange: () => undefined, onStored: (n) => void stored.push(n), onFailed: (n, r) => void failed.push([n, r]) },
    { chunkBytes: opts.chunkBytes ?? 1000, window: 4, stallMs: 1000, maxQueue: opts.maxQueue },
  );
  let now = 0;
  const route = (m: Msg) => {
    if (m.type === 'sm-begin') receiver.onBegin(m);
    else if (m.type === 'sm-chunk') receiver.onChunk(m);
    else if (m.type === 'sm-undo') receiver.onUndo(m);
  };
  /** One pass of the network, then a clock step, until the phone has nothing left (or the budget is spent). */
  async function settle(steps = 400) {
    for (let i = 0; i < steps; i++) {
      link.flush(route, (m) => void sender.onMessage(m, now));
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      link.flush(route, (m) => void sender.onMessage(m, now));
      if (!sender.unsent && !link.up.length && !link.down.length) return;
      now += 250;
      sender.tick(now);
    }
  }
  return { link, receiver, sender, added, removed, stored, failed, settle, now: () => now, step: (ms: number) => ((now += ms), sender.tick(now)), route };
}

describe('stop motion transfer: reliable still delivery', () => {
  it('delivers every shot once, in order, with identical bytes (clean link)', async () => {
    const r = rig();
    const sizes = [1, 999, 1000, 1001, 5555];
    sizes.forEach((n, i) => expect(r.sender.enqueue({ n: i + 1, bytes: pic(n, i + 1), mime: 'image/jpeg', w: 4, h: 3 }, 0)).toBe(i < MAX_QUEUE));
    await r.settle();
    for (let i = MAX_QUEUE; i < sizes.length; i++) {
      r.sender.enqueue({ n: i + 1, bytes: pic(sizes[i], i + 1), mime: 'image/jpeg', w: 4, h: 3 }, r.now());
      await r.settle();
    }
    expect(r.added.map((a) => a.n)).toEqual([1, 2, 3, 4, 5]);
    r.added.forEach((a, i) => expect(Array.from(a.bytes)).toEqual(Array.from(pic(sizes[i], i + 1))));
    expect(r.stored).toEqual([1, 2, 3, 4, 5]);
  });

  it('survives loss, duplicates and reordering in both directions', async () => {
    const r = rig();
    r.link.loss = 0.25;
    r.link.dup = 0.3;
    r.link.shuffle = true;
    const want = [pic(7000, 1), pic(3500, 2), pic(1200, 3)];
    want.forEach((b, i) => r.sender.enqueue({ n: i + 1, bytes: b, mime: 'image/jpeg', w: 4, h: 3 }, 0));
    await r.settle(2000);
    expect(r.added.map((a) => a.n)).toEqual([1, 2, 3]); // exactly once and in order
    r.added.forEach((a, i) => expect(Array.from(a.bytes)).toEqual(Array.from(want[i])));
    expect(r.stored).toEqual([1, 2, 3]);
    expect(r.sender.unsent).toBe(0);
  });

  it('repeats nothing in the project when the phone sends the same shot twice', async () => {
    const r = rig();
    const shot = { n: 1, bytes: pic(2500, 9), mime: 'image/jpeg', w: 4, h: 3 };
    r.sender.enqueue(shot, 0);
    await r.settle();
    // a second sender (page reloaded with the same ids is not possible, but a retransmitted begin is): the receiver answers stored and adds nothing
    r.receiver.onBegin({ type: 'sm-begin', sid: 'sidaaaa1', n: 1, size: 2500, chunks: 3, crc: ((crc32(shot.bytes) >>> 0).toString(16)).padStart(8, '0'), mime: 'image/jpeg', w: 4, h: 3 });
    expect(r.link.down.some((m) => m.type === 'sm-stored')).toBe(true); // answered at once
    await r.settle(5);
    expect(r.added.length).toBe(1);
  });

  it('resumes after the connection drops in the middle of a picture', async () => {
    const r = rig();
    r.sender.enqueue({ n: 1, bytes: pic(30_000, 4), mime: 'image/jpeg', w: 4, h: 3 }, 0);
    // let a few chunks through, then cut the connection
    r.link.flush(r.route, (m) => void r.sender.onMessage(m, r.now()));
    r.link.flush(r.route, (m) => void r.sender.onMessage(m, r.now()));
    r.link.flush(r.route, (m) => void r.sender.onMessage(m, r.now()));
    r.link.open = false;
    r.sender.onClose();
    r.link.up.length = 0;
    r.link.down.length = 0;
    expect(r.added.length).toBe(0);
    const before = r.sender.sentChunks;
    expect(before).toBeGreaterThan(0);
    r.link.open = true;
    r.sender.onOpen(r.now());
    await r.settle();
    expect(r.added.length).toBe(1);
    expect(Array.from(r.added[0].bytes)).toEqual(Array.from(pic(30_000, 4)));
    // 30 chunks in all: after the reconnect only the rest (plus a little overlap), not the whole picture again
    expect(r.sender.sentChunks - before).toBeLessThan(30);
  });

  it('holds at most MAX_QUEUE pictures that are not stored yet (back-pressure)', async () => {
    const r = rig();
    for (let i = 1; i <= MAX_QUEUE; i++) expect(r.sender.enqueue({ n: i, bytes: pic(2000, i), mime: 'image/jpeg', w: 1, h: 1 }, 0)).toBe(true);
    expect(r.sender.full).toBe(true);
    expect(r.sender.enqueue({ n: 99, bytes: pic(10, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0)).toBe(false);
    expect(r.sender.unsent).toBe(MAX_QUEUE);
    await r.settle();
    expect(r.sender.full).toBe(false);
    expect(r.sender.enqueue({ n: 4, bytes: pic(10, 1), mime: 'image/jpeg', w: 1, h: 1 }, r.now())).toBe(true);
  });

  it('never pushes more than the window of chunks without an answer', () => {
    const r = rig({ chunkBytes: 100 });
    r.sender.enqueue({ n: 1, bytes: pic(5000, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    r.receiver.onBegin(r.link.up.shift()!); // begin arrives, the answer is held back
    r.sender.onMessage(r.link.down.shift()!, 0); // ack 0: the first window goes out
    expect(r.sender.sentChunks).toBe(4);
    r.sender.tick(100); // nothing new has been answered: still only the window
    expect(r.sender.sentChunks).toBe(4);
  });

  it('an Undo while the picture is on the way removes that very shot and keeps the others in order', async () => {
    const r = rig();
    r.sender.enqueue({ n: 1, bytes: pic(2500, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    r.sender.enqueue({ n: 2, bytes: pic(9000, 2), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    r.sender.enqueue({ n: 3, bytes: pic(2500, 3), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    // shot 1 goes through, shot 2 is half way: undo shot 2 now
    for (let i = 0; i < 30 && !r.stored.includes(1); i++) {
      r.link.flush(r.route, (m) => void r.sender.onMessage(m, r.now()), 1);
      await new Promise((x) => setTimeout(x, 0));
    }
    expect(r.stored).toContain(1);
    r.link.flush(r.route, (m) => void r.sender.onMessage(m, r.now()), 1); // shot 2 is now half way
    expect(r.sender.pending()).toEqual([2, 3]);
    r.sender.undo(2, r.now());
    await r.settle();
    expect(r.added.map((a) => a.n)).toEqual([1, 3]);
    expect(r.removed).toEqual([]); // 2 was never stored: nothing to take out of the project
  });

  it('an Undo of a shot that is already in the project takes exactly that shot out', async () => {
    const r = rig();
    r.sender.enqueue({ n: 1, bytes: pic(1500, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    r.sender.enqueue({ n: 2, bytes: pic(1500, 2), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    await r.settle();
    expect(r.added.map((a) => a.asset)).toEqual(['a1', 'a2']);
    r.sender.undo(2, r.now());
    await r.settle();
    expect(r.removed).toEqual(['a2']);
    expect(r.receiver.shotOfAsset('a1')).toEqual({ sid: 'sidaaaa1', n: 1 });
  });

  it('an Undo that arrives while the computer is still saving the picture removes it right after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const removed: string[] = [];
    const sent: Msg[] = [];
    const rcv = new ShotReceiver((m) => sent.push(m), () => ({
      add: async () => (await gate, { ok: true, asset: 'slow1' }),
      remove: (a) => void removed.push(a),
    }));
    const bytes = pic(10, 1);
    rcv.onBegin({ type: 'sm-begin', sid: 'sidaaaa1', n: 1, size: 10, chunks: 1, crc: (crc32(bytes) >>> 0).toString(16).padStart(8, '0'), mime: 'image/jpeg', w: 1, h: 1 });
    rcv.onChunk({ type: 'sm-chunk', sid: 'sidaaaa1', n: 1, seq: 0, data: btoa(String.fromCharCode(...bytes)) });
    rcv.onUndo({ type: 'sm-undo', sid: 'sidaaaa1', n: 1 });
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toEqual(['slow1']);
    expect(sent.map((m) => m.type)).toContain('sm-removed');
    expect(sent.map((m) => m.type)).not.toContain('sm-stored');
  });

  it('a picture damaged on the way is refused and sent again', async () => {
    const r = rig();
    let hit = false;
    r.link.tamper = (m, dir) => {
      if (dir === 'up' && m.type === 'sm-chunk' && m.seq === 1 && !hit) {
        hit = true;
        const d = String(m.data);
        return { ...m, data: (d[0] === 'A' ? 'B' : 'A') + d.slice(1) }; // same length, different bytes
      }
      return m;
    };
    const bytes = pic(4000, 5);
    r.sender.enqueue({ n: 1, bytes, mime: 'image/jpeg', w: 1, h: 1 }, 0);
    await r.settle();
    expect(hit).toBe(true);
    expect(r.added.length).toBe(1);
    expect(Array.from(r.added[0].bytes)).toEqual(Array.from(bytes));
  });

  it('waits and keeps the picture while the computer has no Stop Motion to put it in', async () => {
    let ready = false;
    let assets = 0;
    const r = rig({ sink: async () => (ready ? { ok: true, asset: `a${++assets}` } : { ok: false, code: 'no-target', reason: 'none' }) });
    r.sender.enqueue({ n: 1, bytes: pic(1500, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    await r.settle(30);
    expect(r.sender.unsent).toBe(1);
    expect(r.sender.waiting).toBe(true);
    ready = true;
    await r.settle(100);
    expect(r.sender.unsent).toBe(0);
    expect(assets).toBe(1);
  });

  it('gives up on a picture the computer refuses for good and says why', async () => {
    const r = rig({ sink: async () => ({ ok: false, code: 'too-big', reason: 'too big' }) });
    r.sender.enqueue({ n: 1, bytes: pic(100, 1), mime: 'image/jpeg', w: 1, h: 1 }, 0);
    await r.settle(20);
    expect(r.failed).toEqual([[1, 'too big']]);
    expect(r.sender.unsent).toBe(0);
  });

  it('refuses a begin that is not valid or is too big', () => {
    const sent: Msg[] = [];
    const rcv = new ShotReceiver((m) => sent.push(m), () => null, {}, { maxBytes: 1000 });
    rcv.onBegin({ type: 'sm-begin', sid: 'sidaaaa1', n: 1, size: 5000, chunks: 5, crc: '00000000', mime: 'image/jpeg' });
    rcv.onBegin({ type: 'sm-begin', sid: 'sidaaaa1', n: 2, size: 50, chunks: 1, crc: 'zz', mime: 'image/jpeg' });
    rcv.onBegin({ type: 'sm-begin', sid: 'sidaaaa1', n: 3, size: 50, chunks: 1, crc: '00000000', mime: 'text/html' });
    expect(sent.map((m) => m.code)).toEqual(['too-big', 'bad', 'bad']);
  });
});

describe('stop motion settings sync', () => {
  it('cleans values and ignores nonsense', () => {
    expect(cleanPatch({ interval: 0.01, stopAfter: -5, onionFrames: 9, maxSide: 999, onionStrength: 4, onion: 'yes' })).toEqual({ interval: 0.2, stopAfter: 0, onionFrames: 3, onionStrength: 1 });
    expect(parseSettings({ type: 'sm-settings', rev: 3, maxSide: 720 })).toMatchObject({ rev: 3, maxSide: 720, interval: DEFAULT_SETTINGS.interval });
    expect(parseSettings({ type: 'sm-settings', rev: -1 })).toBeNull();
    expect(parseStatus({ type: 'sm-status', unsent: 2, auto: { running: true, count: 4 } })).toMatchObject({ unsent: 2, auto: { running: true, count: 4 } });
  });

  it('flows computer to phone and phone to computer, the higher revision wins', () => {
    const toPhone: Msg[] = [];
    const store = new PhoneStopMotionStore({ sendJson: (_t, m) => void toPhone.push(m) });
    const patches: object[] = [];
    store.onPatch('t', (p) => void patches.push(p));
    store.ingest('t', { type: 'sm-hello', sid: 'sidaaaa1' });
    const first = parseSettings(toPhone[0])!;
    expect(first.rev).toBeGreaterThan(0);
    expect(toPhone[0].reset).toBe(true);
    store.setSettings('t', { maxSide: 1080, interval: 5 });
    const second = parseSettings(toPhone[toPhone.length - 1])!;
    expect(second).toMatchObject({ maxSide: 1080, interval: 5 });
    expect(second.rev).toBeGreaterThan(first.rev);
    // the same values again change nothing and send nothing
    const n = toPhone.length;
    store.setSettings('t', { maxSide: 1080, interval: 5 });
    expect(toPhone.length).toBe(n);
    // a change made on the phone arrives as a patch for the controller
    store.ingest('t', { type: 'sm-set', patch: { onion: false, interval: 3 } });
    expect(patches).toEqual([{ onion: false, interval: 3 }]);
  });
});
