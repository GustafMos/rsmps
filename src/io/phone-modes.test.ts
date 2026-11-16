/**
 * The phone link without a camera picture: the link completes from the phone's typed `hello` (scan mode, controller only, camera refused),
 * not from video frames; camera mode with a picture still waits for frames. No network: a fake WebSocket stands in for the relay.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PhoneLink } from './phone';
import { encodeChunkFrame, FRAME_PHOTO } from '../phone/scan-protocol';

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = '';
  sent: (string | Uint8Array | ArrayBuffer)[] = [];
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
  send(d: string | Uint8Array | ArrayBuffer) {
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
const links: PhoneLink[] = [];

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS;
  g.location = { protocol: 'https:', host: 'localhost:5173', hostname: 'localhost', port: '5173', origin: 'https://localhost:5173' };
  g.document = { createElement: () => ({ muted: false, playsInline: false, srcObject: null, currentTime: 0, play: async () => undefined }) };
});

afterEach(() => {
  links.length = 0;
  FakeWS.all.length = 0;
});

async function session(mode?: 'camera' | 'scan' | 'controller') {
  const link = new PhoneLink(null);
  link.available = true;
  links.push(link);
  const info = await link.createSession({ address: ORIGIN, ...(mode ? { mode } : {}) });
  const ws = FakeWS.all.at(-1)!;
  const msg = async (m: unknown) => {
    ws.onmessage!({ data: typeof m === 'string' ? m : JSON.stringify(m) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { link, info, ws, msg, token: info.token };
}

describe('mode in the pairing link', () => {
  it('scan mode adds &mode=scan after the unchanged token; the camera link is exactly as before', async () => {
    const s = await session('scan');
    expect(s.info.url).toBe(`${ORIGIN}/phone?token=${s.token}&mode=scan`);
    expect(s.token).toMatch(/^[0-9a-f]{32}$/);
    expect(s.ws.url).toContain(`role=desktop&token=${s.token}`);
    const c = await session();
    expect(c.info.url).toBe(`${ORIGIN}/phone?token=${c.token}`);
    expect((await session('controller')).info.url).toMatch(/&mode=controller$/);
    for (const x of [s, c]) x.link.close(x.token);
  });
});

describe('a link without a camera picture', () => {
  it('scan mode: no video negotiation, and the hello alone makes it connected', async () => {
    const { link, ws, msg, token } = await session('scan');
    await msg({ type: 'phone-joined' });
    expect(ws.json().some((m) => m.type === 'offer' || m.type === 'use-jpeg')).toBe(false); // no peer for a phone that sends no picture
    expect(link.state(token)).toBe('waiting');
    expect(link.progress(token)).toBe('accepted');
    await msg({ type: 'hello', v: 1, mode: 'scan', media: 'none' });
    expect(link.state(token)).toBe('connected');
    expect(link.progress(token)).toBe('connected');
    expect(link.link(token)).toEqual({ mode: 'scan', media: 'none' });
    expect(link.detail(token)).toMatch(/scan mode/);
    expect(ws.json().find((m) => m.type === 'scan-ready')).toMatchObject({ type: 'scan-ready', limits: { maxBytes: 40 * 1024 * 1024 } });
    expect(link.linked()).toBe(token);
    link.close(token);
  });

  it('controller only: connected from the hello', async () => {
    const { link, msg, token } = await session('controller');
    await msg({ type: 'phone-joined' });
    await msg({ type: 'hello', v: 1, mode: 'controller', media: 'none' });
    expect(link.state(token)).toBe('connected');
    expect(link.detail(token)).toMatch(/controller/);
    link.close(token);
  });

  it('camera refused: a camera link still completes without a picture, and the peer that was started is dropped', async () => {
    const { link, msg, token } = await session();
    await msg({ type: 'phone-joined' }); // camera mode: the computer starts the video negotiation as before
    await msg({ type: 'hello', v: 1, mode: 'camera', media: 'refused' });
    expect(link.state(token)).toBe('connected');
    expect(link.link(token)).toEqual({ mode: 'camera', media: 'refused' });
    expect(link.detail(token)).toMatch(/did not allow its camera/);
    link.close(token);
  });

  it('camera with a picture is NOT connected by the handshake: it still waits for frames', async () => {
    const { link, ws, msg, token } = await session();
    await msg({ type: 'phone-joined' });
    expect(ws.json().some((m) => m.type === 'use-jpeg' || m.type === 'offer')).toBe(true); // video negotiation started as before
    await msg({ type: 'hello', v: 1, mode: 'camera', media: 'video' });
    expect(link.state(token)).toBe('waiting');
    expect(link.progress(token)).toBe('accepted');
    link.close(token);
  });

  it('a linked camera phone can be switched to scan mode and back; the phone is asked, no second code', async () => {
    const { link, ws, msg, token } = await session();
    await msg({ type: 'phone-joined' });
    await msg({ type: 'hello', v: 1, mode: 'camera', media: 'refused' });
    expect(link.linked()).toBe(token);
    link.setMode(token, 'scan');
    expect(ws.json().filter((m) => m.type === 'mode')).toEqual([{ type: 'mode', mode: 'scan' }]);
    expect(ws.json().some((m) => m.type === 'scan-ready')).toBe(true);
    await msg({ type: 'hello', v: 1, mode: 'scan', media: 'none' });
    expect(link.link(token)).toEqual({ mode: 'scan', media: 'none' });
    expect(link.state(token)).toBe('connected');
    link.close(token);
  });

  it('linked() is null before a phone is linked, and for a closed session', async () => {
    const { link, token } = await session('scan');
    expect(link.linked()).toBeNull();
    link.close(token);
    expect(link.linked()).toBeNull();
  });

  it('bad hello messages are ignored', async () => {
    const { link, msg, token } = await session('scan');
    await msg({ type: 'hello', mode: 'fly', media: 'none' });
    await msg('not json');
    expect(link.state(token)).toBe('waiting');
    link.close(token);
  });
});

describe('scan frames on the link', () => {
  it('a binary scan chunk is routed to the scan code, not decoded as a camera frame', async () => {
    const { link, ws, msg, token } = await session('scan');
    await msg({ type: 'hello', v: 1, mode: 'scan', media: 'none' });
    const frame = encodeChunkFrame(FRAME_PHOTO, 77, 0, new Uint8Array([1, 2, 3]));
    ws.onmessage!({ data: frame.buffer });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.json().find((m) => m.type === 'scan-reject')).toMatchObject({ id: 77, code: 'unknown-id' });
    expect(link.scan.has(token)).toBe(true);
    link.close(token);
  });

  it('phone motion and camera signalling still pass the scan filter', async () => {
    const { link, msg, token } = await session('controller');
    await msg({ type: 'phone-joined' });
    await msg({ type: 'hello', v: 1, mode: 'controller', media: 'none' });
    await msg({ type: 'motion', t: 5, q: [0, 0, 0, 1] });
    expect(link.motion.has(token)).toBe(true);
    link.close(token);
  });
});
