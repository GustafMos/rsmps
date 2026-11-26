/**
 * Phone link, desktop side: pairs this app with a phone through the dev server's WebSocket (LAN mode only), receives the
 * phone camera over WebRTC (host candidates only: both devices are on the same network) and falls back to JPEG frames over
 * the WebSocket when WebRTC does not connect in a few seconds. Provides `Host.liveFrame` with a video element or a bitmap.
 */
import type { PhoneAddress, PhoneApi, PhoneProgress, PhoneSessionInfo, PhoneState } from './api';
import { UNREACHED_HINT, closeMessage } from '../phone/messages';
import type { PhoneProvider } from './live';
import { qrSvg } from './qr';
import { MOTION_TYPES } from '../phone/motion-protocol';
import { LINK_TYPES, parseHello, sendsVideo, type PhoneMedia, type PhoneMode } from '../phone/link-modes';
import { PhoneMotionStore } from './phone-motion';
import { PhoneScanStore } from './phone-scan';
import { PhoneStopMotionStore } from './phone-stopmotion';
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

const PROGRESS_ORDER: PhoneProgress[] = ['waiting', 'reached', 'accepted', 'connected'];

/** Progress only moves forward within one pairing. */
export function advanceProgress(cur: PhoneProgress, next: PhoneProgress): PhoneProgress {
  return PROGRESS_ORDER.indexOf(next) > PROGRESS_ORDER.indexOf(cur) ? next : cur;
}

/** The three ticks of the pairing checklist: reached the computer, code accepted, video connected (or, with no picture, the phone linked). */
export function phoneSteps(progress: PhoneProgress, state: PhoneState): [boolean, boolean, boolean] {
  if (state === 'connected') return [true, true, true];
  const at = PROGRESS_ORDER.indexOf(progress);
  return [at >= 1, at >= 2, false];
}

interface Session {
  token: string;
  progress: PhoneProgress;
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
  /** What the phone does: asked for in the link (`&mode=`), then whatever its `hello` says. */
  mode: PhoneMode;
  /** Does a camera picture flow? null until the phone's hello. */
  media: PhoneMedia | null;
}

export class PhoneLink implements PhoneApi, PhoneProvider {
  available = false;
  /** Sensor data from the phones (gyro, touch pad, location, AR), keyed by pairing token. See phone-motion.ts. */
  readonly motion = new PhoneMotionStore();
  /** Photos from phones in scan mode, and what goes back to them (statuses, preview). See phone-scan.ts. */
  readonly scan = new PhoneScanStore({
    sendJson: (token, msg) => this.sendTo(token, msg),
    sendBinary: (token, bytes) => {
      const ws = this.sessions.get(token)?.ws;
      if (ws?.readyState === WebSocket.OPEN) ws.send(bytes);
    },
    buffered: (token) => this.sessions.get(token)?.ws.bufferedAmount ?? 0,
  });
  /** Stop motion with the phone as the capture rig: stills in, settings and commands out. See phone-stopmotion.ts. */
  readonly stopmotion = new PhoneStopMotionStore({ sendJson: (token, msg) => this.sendTo(token, msg) });
  private desktopInfo: LanInfo | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private origins: string[] = [];
  private candidates: { address: string; label: string; kind: 'lan' | 'tailscale' | 'other' }[] = [];
  private sessions = new Map<string, Session>();
  private listeners = new Set<(token: string, state: PhoneState, detail: string, progress: PhoneProgress) => void>();

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

  async createSession(opts: { address?: string; mode?: PhoneMode } = {}): Promise<PhoneSessionInfo> {
    if (!this.available) throw new Error(LAN_MESSAGE);
    if (this.desktop && this.desktopInfo?.state !== 'on') {
      const started = await this.startServer();
      if (!started.ok) throw new Error(started.error ?? 'The phone link could not start.');
    }
    this.cancelStop();
    const origin = opts.address ?? (await this.addresses())[0]?.url ?? pickOrigin(this.origins, location);
    if (!origin) throw new Error('No network address was found for this computer, so a phone cannot reach it. Connect to Wi-Fi or a network and restart "npm run dev:lan".');
    const token = newToken();
    const mode: PhoneMode = opts.mode ?? 'camera';
    const url = `${origin}/phone?token=${token}${mode === 'camera' ? '' : `&mode=${mode}`}`;
    const ws = new WebSocket(this.desktop && this.desktopInfo ? phoneSocketUrl(this.desktopInfo.ws, token) : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__rsmps/phone-ws?role=desktop&token=${token}`);
    ws.binaryType = 'arraybuffer';
    const expiresAt = Date.now() + SESSION_MS;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const s: Session = { token, progress: 'waiting', ws, state: 'waiting', pc: null, video, bitmap: null, frames: 0, jpeg: false, timers: [], expiresAt, detail: 'Waiting for the phone: scan the QR code and open the link.', reached: false, audioStream: null, chain: Promise.resolve(), mode, media: null };
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

  progress(token: string): PhoneProgress {
    return this.sessions.get(token)?.progress ?? 'waiting';
  }

  expiresAt(token: string): number | null {
    return this.sessions.get(token)?.expiresAt ?? null;
  }

  /** The newest session with a phone linked right now (any mode), for reuse: a second QR code is not needed. */
  linked(): string | null {
    const live = [...this.sessions.values()].filter((s) => s.state === 'connected');
    return live.length ? live[live.length - 1].token : null;
  }

  /** What the phone of this session does and whether it sends a picture (null for an unknown token). */
  link(token: string): { mode: PhoneMode; media: PhoneMedia | null } | null {
    const s = this.sessions.get(token);
    return s ? { mode: s.mode, media: s.media } : null;
  }

  /** Ask a linked phone to change what it does (for example into scan mode). The phone answers with a new hello. */
  setMode(token: string, mode: PhoneMode): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.mode = mode;
    if (mode !== 'camera' && mode !== 'stopmotion') this.dropPeer(s); // stop motion keeps the live picture
    this.send(s, { type: 'mode', mode });
    if (mode === 'scan') this.scan.phoneIsScanning(token);
  }

  onState(listener: (token: string, state: PhoneState, detail: string, progress: PhoneProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(token: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    this.teardown(s);
    this.sessions.delete(token);
    this.motion.drop(token);
    this.scan.drop(token);
    this.stopmotion.drop(token);
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
    for (const l of [...this.listeners]) l(s.token, s.state, s.detail, s.progress);
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

  private sendTo(token: string, msg: unknown): void {
    const s = this.sessions.get(token);
    if (s) this.send(s, msg);
  }

  /** Stop receiving a camera picture (the phone no longer sends one). */
  private dropPeer(s: Session): void {
    s.pc?.close();
    s.pc = null;
    s.jpeg = false;
    s.video.srcObject = null;
    s.bitmap = null;
    this.emitStream(s, null);
  }

  private markFrame(s: Session): void {
    s.frames++;
    if (s.state !== 'connected') {
      s.detail = 'Video connected';
      s.progress = 'connected';
      this.setState(s, 'connected');
    }
  }

  private async onMessage(s: Session, ev: MessageEvent): Promise<void> {
    if (ev.data instanceof ArrayBuffer) {
      if (PhoneScanStore.handlesBinary(ev.data)) {
        this.scan.ingestBinary(s.token, ev.data); // a photo chunk from scan mode (starts with the scan magic, never FF D8)
        return;
      }
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
    if (msg.type && MOTION_TYPES.has(msg.type)) {
      this.motion.ingest(s.token, msg); // sensor frames from the phone (never touches the video state)
      return;
    }
    if (PhoneStopMotionStore.handles(msg.type)) {
      this.stopmotion.ingest(s.token, msg); // stop motion: stills, settings, status
      return;
    }
    if (PhoneScanStore.handles(msg.type)) {
      this.scan.ingestJson(s.token, msg); // photo transfer, status and preview messages (scan mode)
      return;
    }
    if (msg.type && LINK_TYPES.has(msg.type)) {
      await this.onHello(s, msg);
      return;
    }
    switch (msg.type) {
      case 'registered':
        if (typeof msg.expiresAt === 'number') s.expiresAt = msg.expiresAt;
        break;
      case 'reached':
        s.reached = true;
        s.progress = advanceProgress(s.progress, 'reached');
        if (typeof msg.expiresAt === 'number') s.expiresAt = msg.expiresAt;
        this.setDetail(s, 'Your phone reached this computer. Waiting for it to open the camera...');
        break;
      case 'phone-joined':
        s.reached = true;
        s.progress = advanceProgress(s.progress, 'accepted');
        if (s.mode === 'camera' || s.mode === 'stopmotion') {
          this.setDetail(s, 'Code accepted. Connecting the video...');
          await this.startPeer(s);
        } else this.setDetail(s, 'Code accepted. Waiting for the phone to say what it does...');
        break;
      case 'phone-left':
        if (this.scan.has(s.token)) this.scan.session(s.token).active = false;
        this.stopmotion.phoneLeft(s.token);
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

  /**
   * The phone's typed handshake: its mode and whether a picture will flow. Without a picture (scan mode, controller only, camera refused)
   * the handshake IS the link: the state becomes 'connected' here, not when frames arrive.
   */
  private async onHello(s: Session, msg: { type?: string }): Promise<void> {
    const h = parseHello(msg);
    if (!h) return;
    s.reached = true;
    s.progress = advanceProgress(s.progress, 'accepted');
    s.mode = h.mode;
    s.media = h.media;
    if (this.stopmotion.has(s.token) || h.mode === 'stopmotion') this.stopmotion.phoneMode(s.token, h.mode === 'stopmotion');
    if (sendsVideo(h)) {
      if (!s.pc && !s.jpeg) {
        if (s.state === 'connected') {
          s.state = 'waiting'; // the link was complete without a picture: now wait for frames again
          s.progress = 'accepted';
        }
        this.setDetail(s, 'Code accepted. Connecting the video...');
        await this.startPeer(s);
      }
      this.emit(s);
      return;
    }
    this.dropPeer(s);
    s.progress = 'connected';
    s.detail = h.mode === 'scan' ? 'Phone linked in scan mode (no camera picture).' : h.mode === 'controller' ? 'Phone linked as a controller (no camera picture).' : h.media === 'refused' ? 'Phone linked, but it did not allow its camera: no picture.' : 'Phone linked without a camera picture.';
    if (s.state === 'connected') this.emit(s);
    else this.setState(s, 'connected');
    if (h.mode === 'scan') this.scan.phoneIsScanning(s.token);
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
