/**
 * The 3D scan mode on the desktop side of the phone link: the link completes from the phone's hello (like scan and controller), the
 * photo chunks (scan magic, kind 3) go to the 3D scan code and not to the paper-scan code or the camera-frame decoder, and a lost phone
 * is noticed. No network: a fake WebSocket stands in for the relay.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PhoneLink } from './phone';
import { encodeChunkFrame } from '../phone/scan-protocol';
import { FRAME_SCAN3D } from '../phone/scan3d-protocol';

class FakeWS {
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
(FakeWS as unknown as Record<string, number>).OPEN = 1;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS;
  g.location = { protocol: 'https:', host: 'localhost:5173', hostname: 'localhost', port: '5173', origin: 'https://localhost:5173' };
  g.document = { createElement: () => ({ muted: false, playsInline: false, srcObject: null, currentTime: 0, play: async () => undefined }) };
});
afterEach(() => {
  FakeWS.all.length = 0;
});

async function session(mode?: 'scan3d' | 'camera') {
  const link = new PhoneLink(null);
  link.available = true;
  const info = await link.createSession({ address: 'https://192.168.0.5:5173', ...(mode ? { mode } : {}) });
  const ws = FakeWS.all.at(-1)!;
  const msg = async (m: unknown) => {
    ws.onmessage!({ data: JSON.stringify(m) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { link, info, ws, msg, token: info.token };
}

describe('3D scan mode on the phone link', () => {
  it('the link carries &mode=scan3d after the unchanged token', async () => {
    const { info, link, token } = await session('scan3d');
    expect(info.url).toBe(`https://192.168.0.5:5173/phone?token=${token}&mode=scan3d`);
    link.close(token);
  });

  it('the link counts as complete when the phone\'s hello arrives, and the phone is told what is allowed', async () => {
    const { link, msg, ws, token } = await session('scan3d');
    await msg({ type: 'phone-joined' });
    expect(link.state(token)).toBe('waiting');
    await msg({ type: 'hello', v: 1, mode: 'scan3d', media: 'none' });
    expect(link.state(token)).toBe('connected');
    expect(link.link(token)).toEqual({ mode: 'scan3d', media: 'none' });
    expect(link.detail(token)).toMatch(/3D scan/);
    expect(ws.json().find((m) => m.type === 'scan3d-ready')).toMatchObject({ v: 1, limits: { chunkBytes: 131072 } });
    link.close(token);
  });

  it('a linked phone can be switched to 3D scan mode: it is asked, no second code', async () => {
    const { link, msg, ws, token } = await session();
    await msg({ type: 'phone-joined' });
    await msg({ type: 'hello', v: 1, mode: 'controller', media: 'none' });
    expect(link.linked()).toBe(token);
    link.setMode(token, 'scan3d');
    expect(ws.json().filter((m) => m.type === 'mode')).toEqual([{ type: 'mode', mode: 'scan3d' }]);
    await msg({ type: 'hello', v: 1, mode: 'scan3d', media: 'none' });
    expect(link.link(token)).toEqual({ mode: 'scan3d', media: 'none' });
    link.close(token);
  });

  it('shots, status and photo chunks go to the 3D scan code only', async () => {
    const { link, ws, msg, token } = await session('scan3d');
    await msg({ type: 'hello', v: 1, mode: 'scan3d', media: 'none' });
    await msg({ type: 'scan3d-header', sid: 5, target: { center: [0, 0, -2], radius: 0.5, up: [0, 1, 0] }, grid: { az: 24, el: 6 } });
    expect(link.scan3d.info(token)!.header?.target.center).toEqual([0, 0, -2]);
    ws.onmessage!({ data: encodeChunkFrame(FRAME_SCAN3D, 9, 0, new Uint8Array([1, 2, 3])).buffer });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.json().find((m) => m.type === 'scan3d-reject')).toMatchObject({ id: 9, code: 'unknown-id' });
    expect(ws.json().some((m) => m.type === 'scan-reject')).toBe(false); // not the paper-scan code
    expect(link.scan.has(token)).toBe(false);
    link.close(token);
  });

  it('a phone that leaves is noticed (the scan keeps what arrived and waits for it to come back)', async () => {
    const { link, msg, token } = await session('scan3d');
    await msg({ type: 'hello', v: 1, mode: 'scan3d', media: 'none' });
    expect(link.scan3d.info(token)!.linkLost).toBe(false);
    await msg({ type: 'phone-left' });
    expect(link.scan3d.info(token)!.linkLost).toBe(true);
    await msg({ type: 'hello', v: 1, mode: 'scan3d', media: 'none' });
    expect(link.scan3d.info(token)!.linkLost).toBe(false);
    link.close(token);
  });
});
