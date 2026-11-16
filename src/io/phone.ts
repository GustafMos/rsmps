/**
 * Phone link, desktop side: pairs this app with a phone through the dev server's WebSocket (LAN mode only), receives the
 * phone camera over WebRTC (host candidates only: both devices are on the same network) and falls back to JPEG frames over
 * the WebSocket when WebRTC does not connect in a few seconds. Provides `Host.liveFrame` with a video element or a bitmap.
 */
import type { PhoneAddress, PhoneApi, PhoneSessionInfo, PhoneState } from './api';
import { UNREACHED_HINT, closeMessage } from '../phone/messages';
import type { PhoneProvider } from './live';
import { qrSvg } from './qr';
import { DesktopClient, isDesktop, phoneSocketUrl, type LanInfo } from './desktop';

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

/** Desktop app: the QR addresses are the candidates' own URLs (the phone server has its own port). */
export function desktopAddresses(info: Pick<LanInfo, 'candidates'>): PhoneAddress[] {
  return info.candidates.map((c) => ({ url: c.url, label: c.label, kind: c.kind }));
}

/** Words for a phone server that did not start. */
export function startFailure(info: LanInfo): { ok: false; declined?: boolean; error?: string } {
  if (info.declined) return { ok: false, declined: true, error: 'Phone connections were not allowed, so the phone cannot link. Allow them to continue.' };
  return { ok: false, error: info.error || 'The phone link could not start. Check that no other program is using the port, then try again.' };
}

/** After the last session closes the desktop server is stopped, but not instantly: "New code" closes the old one and opens another. */
export const STOP_GRACE_MS = 3000;

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
  /** The remote stream handed to the audio engine (null when none). */
  audioStream: MediaStream | null;
  /** Messages are handled strictly in order (an ICE candidate must not overtake the answer). */
  chain: Promise<void>;
}

export class PhoneLink implements PhoneApi, PhoneProvider {
  available = false;
  private desktopInfo: LanInfo | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private origins: string[] = [];
  private candidates: { address: string; label: string; kind: 'lan' | 'tailscale' | 'other' }[] = [];
  private sessions = new Map<string, Session>();
  private listeners = new Set<(token: string, state: PhoneState, detail: string) => void>();

  constructor(private desktop: DesktopClient | null = isDesktop() ? new DesktopClient() : null) {}

  /** Ask the dev server (or the desktop app) whether the phone link can work. Never throws. */
  async init(): Promise<void> {
    if (this.desktop) {
      try {
        const info = await this.desktop.lanInfo();
        this.desktopInfo = info;
        this.available = info.desktop && info.ws !== ''; // available on demand: the server starts when the user asks
      } catch {
        this.available = false;
      }
      return;
    }
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

  /** Desktop app: start the phone server (native confirmation the first time). Elsewhere the dev server is already listening. */
  async startServer(): Promise<{ ok: boolean; declined?: boolean; error?: string }> {
    if (!this.desktop) return { ok: this.available, ...(this.available ? {} : { error: LAN_MESSAGE }) };
    this.cancelStop();
    try {
      const info = await this.desktop.lanStart();
      this.desktopInfo = info;
      return info.state === 'on' && info.lan ? { ok: true } : startFailure(info);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private cancelStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  /** Desktop app: stop the server when no session is waiting or connected any more. */
  private stopIfIdle(): void {
    if (!this.desktop || this.stopTimer) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      const busy = [...this.sessions.values()].some((s) => s.state === 'waiting' || s.state === 'connected');
      if (!busy) void this.desktop?.lanStop().then((i) => (this.desktopInfo = i)).catch(() => undefined);
    }, STOP_GRACE_MS);
  }

  unavailable(): string {
    return this.available ? 'This phone session is not active any more. Make a new QR code.' : LAN_MESSAGE;
  }

  async addresses(): Promise<PhoneAddress[]> {
    if (!this.available) return [];
    if (this.desktop) {
      try {
        this.desktopInfo = await this.desktop.lanInfo(); // addresses are known while the server is off
      } catch {
        /* use the last answer */
      }
      return this.desktopInfo ? desktopAddresses(this.desktopInfo) : [];
    }
    return buildAddresses(this.candidates, location);
  }

  async createSession(opts: { address?: string } = {}): Promise<PhoneSessionInfo> {
    if (!this.available) throw new Error(LAN_MESSAGE);
    if (this.desktop && this.desktopInfo?.state !== 'on') {
      const started = await this.startServer();
      if (!started.ok) throw new Error(started.error ?? 'The phone link could not start.');
    }
    this.cancelStop();
    const origin = opts.address ?? (await this.addresses())[0]?.url ?? pickOrigin(this.origins, location);
    if (!origin) throw new Error('No network address was found for this computer, so a phone cannot reach it. Connect to Wi-Fi or a network and restart "npm run dev:lan".');
    const token = newToken();
    const url = `${origin}/phone?token=${token}`;
    const ws = new WebSocket(this.desktop && this.desktopInfo ? phoneSocketUrl(this.desktopInfo.ws, token) : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__rsmps/phone-ws?role=desktop&token=${token}`);
    ws.binaryType = 'arraybuffer';
    const expiresAt = Date.now() + SESSION_MS;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const s: Session = { token, ws, state: 'waiting', pc: null, video, bitmap: null, frames: 0, jpeg: false, timers: [], expiresAt, detail: 'Waiting for the phone: scan the QR code and open the link.', reached: false, audioStream: null, chain: Promise.resolve() };
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
      ws.onerror = () => reject(new Error(this.desktop ? 'Could not reach the phone link server on this computer.' : 'Could not reach the dev server for the phone link.'));
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
    this.stopIfIdle();
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
    if (state === 'expired') this.stopIfIdle();
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
    this.emitStream(s, null);
    if (closeSocket && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
  }

  private streamListeners = new Set<(token: string, stream: MediaStream | null) => void>();

  /**
   * The phone's sound: called with the remote WebRTC stream once it has an audio track, and with null when the session ends,
   * the phone leaves or the link falls back to JPEG frames (which carry no sound). The stream is NEVER played here: the <video>
   * used for frames stays muted, the audio engine reads the stream through Web Audio.
   */
  onStream(listener: (token: string, stream: MediaStream | null) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private emitStream(s: Session, stream: MediaStream | null): void {
    if (s.audioStream === stream) return;
    s.audioStream = stream;
    for (const l of [...this.streamListeners]) l(s.token, stream);
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
        this.emitStream(s, null);
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
    this.emitStream(s, null);
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
    pc.addTransceiver('audio', { direction: 'recvonly' }); // the phone's microphone, when it allows it
    pc.onicecandidate = (e) => e.candidate && this.send(s, { type: 'ice', candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      s.video.srcObject = stream; // muted element: it only keeps the remote stream flowing, nothing is heard from here
      void s.video.play().catch(() => undefined);
      if (stream.getAudioTracks().length) this.emitStream(s, stream);
      stream.addEventListener('addtrack', () => s.pc === pc && stream.getAudioTracks().length && this.emitStream(s, stream));
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
    this.emitStream(s, null);
    this.setDetail(s, 'Video only: the direct link did not connect, so the picture comes through this computer as still frames and the phone\'s sound is not available. Sound needs a direct connection.');
    this.send(s, { type: 'use-jpeg' });
  }
}
