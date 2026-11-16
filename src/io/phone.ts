/**
 * Phone link, desktop side: pairs this app with a phone through the dev server's WebSocket (LAN mode only), receives the
 * phone camera over WebRTC (host candidates only: both devices are on the same network) and falls back to JPEG frames over
 * the WebSocket when WebRTC does not connect in a few seconds. Provides `Host.liveFrame` with a video element or a bitmap.
 */
import type { PhoneAddress, PhoneApi, PhoneSessionInfo, PhoneState } from './api';
import { UNREACHED_HINT, closeMessage } from '../phone/messages';
import type { PhoneProvider } from './live';
import { qrSvg } from './qr';

export const LAN_MESSAGE =
  'The phone camera needs LAN mode: run "npm run dev:lan" and open the https address it prints. Phones only allow cameras on https pages, and the app must be reachable from your network.';

const SESSION_MS = 15 * 60 * 1000;
/** No sign of the phone after this long: show the checklist. */
const UNREACHED_MS = 20_000;
const WEBRTC_TIMEOUT_MS = 4000;

export function newToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Pick the origin to put in the QR code: the page's own LAN origin if it is one, else the first address of the server. */
/**
 * The addresses to offer for the QR code. They use the protocol and PORT of the page the user is looking at (so the code always
 * points at the server that serves this very page), the host names/IPs the dev server reported, and the page's own host when it
 * is not localhost.
 */
export function buildAddresses(
  candidates: { address: string; label: string; kind: 'lan' | 'tailscale' | 'other' }[],
  page: { protocol: string; hostname: string; port: string; origin: string },
): PhoneAddress[] {
  const port = page.port ? `:${page.port}` : '';
  const out: PhoneAddress[] = candidates.map((c) => ({ url: `${page.protocol}//${c.address}${port}`, label: c.label, kind: c.kind }));
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (!local.includes(page.hostname) && !out.some((a) => a.url === page.origin)) {
    out.unshift({ url: page.origin, label: `This page's own address ${page.hostname}`, kind: /\.ts\.net$/.test(page.hostname) || /^100\./.test(page.hostname) ? 'tailscale' : 'other' });
  }
  return out;
}

export function pickOrigin(origins: string[], page: { hostname: string; origin: string }): string | null {
  if (origins.length === 0) return null;
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (!local.includes(page.hostname)) return page.origin;
  return origins[0];
}

interface Session {
  token: string;
  ws: WebSocket;
  state: PhoneState;
  pc: RTCPeerConnection | null;
  video: HTMLVideoElement;
  bitmap: ImageBitmap | null;
  frames: number;
  jpeg: boolean;
  timers: ReturnType<typeof setTimeout>[];
  expiresAt: number | null;
  detail: string;
  reached: boolean;
  /** Messages are handled strictly in order (an ICE candidate must not overtake the answer). */
  chain: Promise<void>;
}

export class PhoneLink implements PhoneApi, PhoneProvider {
  available = false;
  private origins: string[] = [];
  private candidates: { address: string; label: string; kind: 'lan' | 'tailscale' | 'other' }[] = [];
  private sessions = new Map<string, Session>();
  private listeners = new Set<(token: string, state: PhoneState, detail: string) => void>();

  /** Ask the dev server whether LAN mode is on. Never throws. */
  async init(): Promise<void> {
    try {
      const res = await Promise.race([fetch('/__rsmps/lan-info', { cache: 'no-store' }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
      const info = (await res.json()) as { lan?: boolean; origins?: string[]; candidates?: { address: string; label: string; kind: 'lan' | 'tailscale' | 'other' }[] };
      this.available = info.lan === true;
      this.origins = Array.isArray(info.origins) ? info.origins : [];
      this.candidates = Array.isArray(info.candidates) ? info.candidates : [];
    } catch {
      this.available = false; // not a dev server in LAN mode (plain dev, build or hosted page)
    }
  }

  unavailable(): string {
    return this.available ? 'This phone session is not active any more. Make a new QR code.' : LAN_MESSAGE;
  }

  async addresses(): Promise<PhoneAddress[]> {
    if (!this.available) return [];
    return buildAddresses(this.candidates, location);
  }

  async createSession(opts: { address?: string } = {}): Promise<PhoneSessionInfo> {
    if (!this.available) throw new Error(LAN_MESSAGE);
    const origin = opts.address ?? (await this.addresses())[0]?.url ?? pickOrigin(this.origins, location);
    if (!origin) throw new Error('No network address was found for this computer, so a phone cannot reach it. Connect to Wi-Fi or a network and restart "npm run dev:lan".');
    const token = newToken();
    const url = `${origin}/phone?token=${token}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__rsmps/phone-ws?role=desktop&token=${token}`);
    ws.binaryType = 'arraybuffer';
    const expiresAt = Date.now() + SESSION_MS;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const s: Session = { token, ws, state: 'waiting', pc: null, video, bitmap: null, frames: 0, jpeg: false, timers: [], expiresAt, detail: 'Waiting for the phone: scan the QR code and open the link.', reached: false, chain: Promise.resolve() };
    this.sessions.set(token, s);
    s.timers.push(setTimeout(() => s.state === 'waiting' && this.setState(s, 'expired'), SESSION_MS));
    s.timers.push(setTimeout(() => !s.reached && s.state === 'waiting' && this.setDetail(s, UNREACHED_HINT), UNREACHED_MS));
    ws.onmessage = (ev) => {
      s.chain = s.chain.then(() => this.onMessage(s, ev)).catch(() => undefined);
    };
    ws.onclose = (ev) => {
      const why = closeMessage(ev.code);
      if (why) s.detail = why.text;
      if (ev.code === 4408 && s.state === 'waiting') this.setState(s, 'expired');
      else if (s.state === 'connected' || s.state === 'waiting') this.setState(s, 'disconnected');
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the dev server for the phone link.'));
    });
    return { token, url, qrSvg: qrSvg(url), expiresAt };
  }

  state(token: string): PhoneState {
    return this.sessions.get(token)?.state ?? 'expired';
  }

  detail(token: string): string {
    return this.sessions.get(token)?.detail ?? 'This phone session is not active any more. Make a new QR code.';
  }

  expiresAt(token: string): number | null {
    return this.sessions.get(token)?.expiresAt ?? null;
  }

  onState(listener: (token: string, state: PhoneState, detail: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(token: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    this.teardown(s);
    this.sessions.delete(token);
    this.setState(s, 'disconnected');
  }

  /* ------------------------------------- PhoneProvider ------------------------------------- */

  source(token: string): { video: HTMLVideoElement | null; bitmap: ImageBitmap | null; version: number; state: PhoneState } | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    const hasVideo = !s.jpeg && s.video.srcObject !== null;
    // `frames` counts presented frames; the playhead covers browsers/tabs where frame callbacks do not fire.
    const version = s.frames + (hasVideo ? Math.round(s.video.currentTime * 1000) : 0);
    return { video: hasVideo ? s.video : null, bitmap: s.bitmap, version, state: s.state };
  }

  /* --------------------------------------- internals --------------------------------------- */

  private setState(s: Session, state: PhoneState): void {
    if (s.state === state) return;
    s.state = state;
    if (state === 'expired') s.detail = 'This code expired. Make a new QR code.';
    if (state === 'disconnected' && !s.detail.startsWith('The computer') && s.detail === 'Video connected') s.detail = 'The phone disconnected. Open the link on it again.';
    if (state === 'expired' || state === 'disconnected') this.teardown(s, state === 'expired');
    this.emit(s);
  }

  private emit(s: Session): void {
    for (const l of [...this.listeners]) l(s.token, s.state, s.detail);
  }

  private setDetail(s: Session, text: string): void {
    if (s.detail === text) return;
    s.detail = text;
    this.emit(s);
  }

  private teardown(s: Session, closeSocket = true): void {
    s.timers.forEach(clearTimeout);
    s.timers = [];
    s.pc?.close();
    s.pc = null;
    if (closeSocket && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
  }

  private send(s: Session, msg: unknown): void {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg));
  }

  private markFrame(s: Session): void {
    s.frames++;
    if (s.state !== 'connected') {
      s.detail = 'Video connected';
      this.setState(s, 'connected');
    }
  }

  private async onMessage(s: Session, ev: MessageEvent): Promise<void> {
    if (ev.data instanceof ArrayBuffer) {
      // A JPEG frame (WebRTC fallback).
      try {
        const bmp = await createImageBitmap(new Blob([ev.data], { type: 'image/jpeg' }));
        const old = s.bitmap;
        s.bitmap = bmp;
        if (old) setTimeout(() => old.close(), 500); // an upload may still be reading it
        this.markFrame(s);
      } catch {
        /* a damaged frame: wait for the next one */
      }
      return;
    }
    let msg: { type?: string; sdp?: string; candidate?: RTCIceCandidateInit; from?: string; expiresAt?: number | null };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'registered':
        if (typeof msg.expiresAt === 'number') s.expiresAt = msg.expiresAt;
        break;
      case 'reached':
        s.reached = true;
        if (typeof msg.expiresAt === 'number') s.expiresAt = msg.expiresAt;
        this.setDetail(s, 'Your phone reached this computer. Waiting for it to open the camera...');
        break;
      case 'phone-joined':
        s.reached = true;
        this.setDetail(s, 'Code accepted. Connecting the video...');
        await this.startPeer(s);
        break;
      case 'phone-left':
        s.pc?.close();
        s.pc = null;
        this.setState(s, 'disconnected');
        break;
      case 'answer':
        if (s.pc && msg.sdp) await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => undefined);
        break;
      case 'ice':
        if (s.pc && msg.candidate) await s.pc.addIceCandidate(msg.candidate).catch(() => undefined);
        break;
      case 'expired':
        this.setState(s, 'expired');
        break;
    }
  }

  private async startPeer(s: Session): Promise<void> {
    s.pc?.close();
    s.jpeg = false;
    s.video.srcObject = null;
    if (s.state === 'disconnected') {
      s.state = 'waiting';
      this.emit(s);
    }
    if (typeof RTCPeerConnection === 'undefined') {
      this.send(s, { type: 'use-jpeg' });
      s.jpeg = true;
      return;
    }
    // No STUN/TURN: both devices are on the same network, host candidates are enough.
    const pc = new RTCPeerConnection({ iceServers: [] });
    s.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = (e) => e.candidate && this.send(s, { type: 'ice', candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      s.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void s.video.play().catch(() => undefined);
      const v = s.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      const tick = () => {
        if (s.pc !== pc) return;
        this.markFrame(s);
        v.requestVideoFrameCallback!(tick);
      };
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(tick);
      else s.timers.push(setInterval(() => this.markFrame(s), 33) as unknown as ReturnType<typeof setTimeout>);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.markFrame(s);
      if (pc.connectionState === 'failed') this.useJpeg(s);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send(s, { type: 'offer', sdp: offer.sdp });
    s.timers.push(
      setTimeout(() => {
        if (s.pc === pc && pc.connectionState !== 'connected' && s.frames === 0) this.useJpeg(s);
      }, WEBRTC_TIMEOUT_MS),
    );
  }

  /** WebRTC did not deliver: ask the phone for JPEG frames over the WebSocket instead. */
  private useJpeg(s: Session): void {
    if (s.jpeg) return;
    s.jpeg = true;
    s.pc?.close();
    s.pc = null;
    s.video.srcObject = null;
    this.setDetail(s, 'The direct video link did not connect; using the slower fallback through this computer.');
    this.send(s, { type: 'use-jpeg' });
  }
}
