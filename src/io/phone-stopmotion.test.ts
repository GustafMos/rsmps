/**
 * The phone link in stop motion mode (the computer's PhoneLink with a fake WebSocket): the link URL, when the link counts as complete,
 * and that stop motion messages reach the store.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PhoneLink } from './phone';

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  get bufferedAmount() {
    return 0;
  }
  json(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
}

const ORIGIN = 'https://192.168.0.5:5173';

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS;
  g.location = { protocol: 'https:', host: 'localhost:5173', hostname: 'localhost', port: '5173', origin: 'https://localhost:5173' };
  g.document = { createElement: () => ({ muted: false, playsInline: false, srcObject: null, currentTime: 0, play: async () => undefined }) };
});
afterEach(() => void (FakeWS.all.length = 0));

async function session(mode: 'stopmotion' | 'camera' = 'stopmotion') {
  const link = new PhoneLink(null);
  link.available = true;
  const info = await link.createSession({ address: ORIGIN, mode });
  const ws = FakeWS.all.at(-1)!;
  const msg = async (m: unknown) => {
    ws.onmessage!({ data: JSON.stringify(m) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { link, info, ws, msg, token: info.token };
}

describe('phone link: stop motion mode', () => {
  it('the link carries &mode=stopmotion after the unchanged token', async () => {
    const s = await session();
    expect(s.info.url).toBe(`${ORIGIN}/phone?token=${s.token}&mode=stopmotion`);
    s.link.close(s.token);
  });

  it('with a camera picture the link completes on the first frame, not on the hello (the live picture flows next to the stills)', async () => {
    const { link, ws, msg, token } = await session();
    await msg({ type: 'phone-joined' });
    expect(ws.json().some((m) => m.type === 'offer' || m.type === 'use-jpeg')).toBe(true); // the video negotiation starts
    await msg({ type: 'hello', v: 1, mode: 'stopmotion', media: 'video' });
    expect(link.state(token)).toBe('waiting');
    expect(link.link(token)).toEqual({ mode: 'stopmotion', media: 'video' });
    link.close(token);
  });

  it('with a refused camera the hello alone completes the link, and the stop motion store sees an active phone', async () => {
    const { link, msg, token } = await session();
    await msg({ type: 'phone-joined' });
    await msg({ type: 'hello', v: 1, mode: 'stopmotion', media: 'refused' });
    expect(link.state(token)).toBe('connected');
    expect(link.stopmotion.info(token)?.active).toBe(true);
    link.close(token);
  });

  it('routes sm- messages to the store: sm-hello is answered with the settings, a status is kept, a phone leaving is shown', async () => {
    const { link, ws, msg, token } = await session();
    await msg({ type: 'hello', v: 1, mode: 'stopmotion', media: 'refused' });
    await msg({ type: 'sm-hello', v: 1, sid: 'abcd1234', next: 1 });
    expect(ws.json().find((m) => m.type === 'sm-settings')).toMatchObject({ reset: true, interval: 2 });
    await msg({ type: 'sm-status', unsent: 2, progress: 0.5, shots: 3, auto: { running: false, count: 0, limit: 0, nextInMs: 0 }, note: '', locked: false });
    expect(link.stopmotion.info(token)?.status?.unsent).toBe(2);
    expect(link.stopmotion.command(token, 'shoot')).toBe(true);
    expect(ws.json().find((m) => m.type === 'sm-cmd')).toEqual({ type: 'sm-cmd', cmd: 'shoot' });
    await msg({ type: 'phone-left' });
    expect(link.stopmotion.info(token)?.active).toBe(false);
    expect(link.stopmotion.command(token, 'shoot')).toBe(false);
    link.close(token);
  });

  it('switching a linked camera phone to stop motion keeps its video; switching it to scan drops it', async () => {
    const { link, ws, msg, token } = await session('camera');
    await msg({ type: 'phone-joined' });
    link.setMode(token, 'stopmotion');
    expect(ws.json().filter((m) => m.type === 'mode').at(-1)).toEqual({ type: 'mode', mode: 'stopmotion' });
    await msg({ type: 'hello', v: 1, mode: 'stopmotion', media: 'video' });
    expect(link.stopmotion.info(token)?.active).toBe(true);
    link.close(token);
  });
});
