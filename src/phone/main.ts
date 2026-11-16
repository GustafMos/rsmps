/**
 * The phone page (served at /phone by the dev server in LAN mode). No framework.
 * Reads the pairing token from the URL, opens the camera, joins the session over a WebSocket and sends the camera to the
 * desktop with WebRTC (host candidates only). If the desktop asks for it (WebRTC did not connect), it sends JPEG frames over
 * the WebSocket instead. `?fake=1` streams a generated animation instead of the camera (for testing without a phone).
 */

import { closeMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const detailEl = $('detail');
const preview = $<HTMLVideoElement>('preview');
const switchBtn = $<HTMLButtonElement>('switch');
const resSel = $<HTMLSelectElement>('res');
const torchBtn = $<HTMLButtonElement>('torch');
const micBtn = $<HTMLButtonElement>('mic');
const meterEl = $<HTMLElement>('meter');
const meterBar = $<HTMLElement>('meterBar');
const reconnectBtn = $<HTMLButtonElement>('reconnect');

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const fake = import.meta.env.DEV && params.get('fake') === '1'; // dev only

let stream: MediaStream | null = null;
let facing: 'environment' | 'user' = 'environment';
let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let jpegTimer: ReturnType<typeof setInterval> | null = null;
let retry = 0;
let closedForGood = false;
let wake: { release(): Promise<void> } | null = null;
let torchOn = false;
let chain: Promise<void> = Promise.resolve(); // incoming messages are handled in order

const stepsEl = document.getElementById('steps') as HTMLElement;
const steps: Record<string, 'ok' | 'bad' | 'wait'> = { reached: 'wait', accepted: 'wait', video: 'wait' };
const STEP_TEXT: Record<string, string> = { reached: 'Reached your computer', accepted: 'Code accepted', video: 'Video connected' };

/** "Reached your computer / Code accepted / Video connected": which of the steps worked, so a failure says where it stopped. */
function setStep(name: keyof typeof steps, value: 'ok' | 'bad' | 'wait'): void {
  steps[name] = value;
  stepsEl.innerHTML = Object.keys(steps)
    .map((k) => `${steps[k] === 'ok' ? '✓' : steps[k] === 'bad' ? '✗' : '…'} ${STEP_TEXT[k]}`)
    .join('<br>');
}
setStep('reached', 'wait');

function status(text: string, kind: 'ok' | 'bad' | 'wait', detail = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
  detailEl.textContent = detail;
}

/* ------------------------------------------- camera ------------------------------------------- */

/** The microphone track (kept across camera switches). The page never plays any sound: the preview is muted. */
let micTrack: MediaStreamTrack | null = null;
let meterCtx: AudioContext | null = null;
let meterTimer: ReturnType<typeof setInterval> | null = null;
// Raw sound for music and MIDI: no echo cancellation, noise suppression or automatic gain; mono is enough.
const AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

/** A small input level meter on the microphone track (analysis only, nothing is routed to the speaker). */
function startMeter(): void {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  meterCtx?.close().catch(() => undefined);
  meterCtx = null;
  if (!micTrack) {
    meterEl.hidden = true;
    return;
  }
  meterEl.hidden = false;
  try {
    const ctx = new AudioContext();
    meterCtx = ctx;
    const src = ctx.createMediaStreamSource(new MediaStream([micTrack]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // not connected to ctx.destination: never audible
    const buf = new Float32Array(an.fftSize);
    meterTimer = setInterval(() => {
      void ctx.resume().catch(() => undefined);
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      meterBar.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    }, 100);
  } catch {
    meterEl.hidden = true;
  }
}

function fakeStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  let t = 0;
  const draw = () => {
    t++;
    ctx.fillStyle = `hsl(${(t * 3) % 360} 70% 40%)`;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#fff';
    ctx.fillRect(40 + ((t * 6) % 520), 120, 80, 120);
    ctx.font = '32px sans-serif';
    ctx.fillText(`fake phone ${t}`, 20, 40);
  };
  draw();
  setInterval(draw, 33); // a timer, not requestAnimationFrame: the test animation must keep running in a background tab
  const out = canvas.captureStream(30);
  // A generated 440 Hz tone as the "microphone" (test only).
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const gain = ac.createGain();
    gain.gain.value = 0.5;
    const dest = ac.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    void ac.resume().catch(() => undefined);
    document.addEventListener('pointerdown', () => void ac.resume(), { once: true });
    dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
  } catch {
    /* no Web Audio: the fake phone has no sound */
  }
  return out;
}

/** Open camera and microphone. The first call asks for both together; if one is refused the other still works (camera only, or sound only as a wireless microphone). */
async function openCamera(initial = false): Promise<void> {
  stream?.getVideoTracks().forEach((t) => t.stop()); // a phone cannot open two cameras at once
  let got: MediaStream;
  if (fake) {
    got = fakeStream();
  } else {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera on this page (it needs https).');
    const h = Number(resSel.value);
    const video: MediaTrackConstraints = { facingMode: { ideal: facing }, height: { ideal: h }, width: { ideal: Math.round((h * 16) / 9) } };
    const gum = (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c);
    try {
      got = await gum({ video, audio: initial || !micTrack ? AUDIO_CONSTRAINTS : false });
    } catch (first) {
      try {
        got = await gum({ video, audio: false }); // microphone refused: camera only
      } catch {
        try {
          got = await gum({ audio: AUDIO_CONSTRAINTS }); // camera refused: sound only
        } catch {
          throw first;
        }
      }
    }
  }
  if (got.getAudioTracks()[0] && got.getAudioTracks()[0] !== micTrack) {
    micTrack?.stop();
    micTrack = got.getAudioTracks()[0];
    startMeter();
  }
  const videoTrack = got.getVideoTracks()[0] ?? null;
  stream = new MediaStream([...(videoTrack ? [videoTrack] : []), ...(micTrack ? [micTrack] : [])]);
  micBtn.hidden = !micTrack;
  micBtn.textContent = micTrack?.enabled === false ? 'Microphone off' : 'Microphone on';
  const sub = !videoTrack ? 'Sending sound only.' : !micTrack ? 'No microphone: sending the picture only.' : '';
  if (sub) detailEl.textContent = sub;
  preview.srcObject = videoTrack ? new MediaStream([videoTrack]) : null; // picture only, and the element is muted: nothing is played
  await preview.play().catch(() => undefined);
  const track = videoTrack ?? undefined;
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
  torchBtn.hidden = !caps.torch;
  torchOn = false;
  if (pc) for (const s of pc.getSenders()) if (s.track?.kind === 'video' && track) await s.replaceTrack(track);
}

async function keepAwake(): Promise<void> {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl) wake = await wl.request('screen');
  } catch {
    /* not available or refused: the screen may dim */
  }
}

/* ------------------------------------------- link -------------------------------------------- */

function send(msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function stopJpeg(): void {
  if (jpegTimer) clearInterval(jpegTimer);
  jpegTimer = null;
}

function startJpeg(): void {
  stopJpeg();
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  let busy = false;
  jpegTimer = setInterval(() => {
    if (busy || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 400_000 || !preview.videoWidth) return;
    const k = Math.min(1, 640 / Math.max(preview.videoWidth, preview.videoHeight));
    canvas.width = Math.round(preview.videoWidth * k);
    canvas.height = Math.round(preview.videoHeight * k);
    ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
    busy = true;
    const done = async (blob: Blob | null) => {
      busy = false;
      if (blob && ws?.readyState === WebSocket.OPEN) ws.send(await blob.arrayBuffer());
    };
    if (canvas instanceof OffscreenCanvas) void canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }).then(done, () => (busy = false));
    else canvas.toBlob((b) => void done(b), 'image/jpeg', 0.7);
  }, 100); // about 10 frames per second
  setStep('video', 'ok');
  status('Sending (fallback mode)', 'ok', 'Your picture goes through the computer as still frames. Keep this page open.');
}

async function onOffer(sdp: string): Promise<void> {
  pc?.close();
  pc = new RTCPeerConnection({ iceServers: [] }); // same network: host candidates only
  const peer = pc;
  peer.onicecandidate = (e) => e.candidate && send({ type: 'ice', candidate: e.candidate.toJSON() });
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      setStep('video', 'ok');
      status('Sending your camera', 'ok', 'Keep this page open. The screen stays on.');
    }
  };
  for (const track of stream?.getTracks() ?? []) peer.addTrack(track, stream!); // video and, when allowed, the microphone
  await peer.setRemoteDescription({ type: 'offer', sdp });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ type: 'answer', sdp: answer.sdp });
}

function connect(): void {
  if (closedForGood) return;
  ws?.close();
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__rsmps/phone-ws?role=phone&token=${encodeURIComponent(token)}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  status('Connecting to your computer…', 'wait');
  sock.onopen = () => {
    retry = 0;
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data) as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    chain = chain
      .then(async () => {
        if (msg.type === 'ready') {
          setStep('reached', 'ok');
          setStep('accepted', 'ok');
          status('Code accepted. Waiting for the computer…', 'wait');
        }
        else if (msg.type === 'offer' && msg.sdp) await onOffer(msg.sdp);
        else if (msg.type === 'ice' && msg.candidate) await pc?.addIceCandidate(msg.candidate).catch(() => undefined);
        else if (msg.type === 'use-jpeg') {
          pc?.close();
          pc = null;
          startJpeg();
        }
      })
      .catch(() => undefined);
  };
  sock.onclose = (ev) => {
    stopJpeg();
    if (sock !== ws) return;
    const why = closeMessage(ev.code);
    if (why?.final) {
      closedForGood = true;
      setStep('accepted', 'bad');
      status('Not connected', 'bad', why.text);
    } else {
      const wait = Math.min(8000, 1000 * 2 ** retry++);
      status('Connection lost. Trying again…', 'bad', `Retrying in ${Math.round(wait / 1000)} s`);
      setTimeout(connect, wait);
    }
  };
}

/* -------------------------------------------- start ------------------------------------------- */

async function start(): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    status('No valid link', 'bad', 'Scan the QR code shown on the computer.');
    return;
  }
  status('Asking for the camera…', 'wait', 'Please allow camera access.');
  try {
    await openCamera(true);
  } catch (err) {
    const name = (err as { name?: string }).name;
    status('Camera not available', 'bad', name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings, then press Reconnect.' : String((err as Error).message ?? err));
    return;
  }
  void keepAwake();
  await ping();
  connect();
}

/** First contact: tells the computer this phone reached it (before pairing), and shows whether the code is known. */
async function ping(): Promise<void> {
  try {
    const res = await fetch(`/__rsmps/ping?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    const body = (await res.json()) as { known?: boolean };
    setStep('reached', 'ok');
    if (body.known === false) detailEl.textContent = 'This code is not known to the computer. Scan the QR code currently shown in the app again.';
  } catch {
    setStep('reached', 'bad');
    detailEl.textContent = 'Could not reach the computer. Check the Wi-Fi and the certificate warning.';
  }
}

switchBtn.onclick = async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    await openCamera();
    if (jpegTimer) startJpeg();
  } catch (err) {
    status('Could not switch camera', 'bad', String((err as Error).message ?? err));
  }
};
resSel.onchange = () => void openCamera().catch(() => undefined);
micBtn.onclick = () => {
  if (!micTrack) return;
  micTrack.enabled = !micTrack.enabled;
  micBtn.textContent = micTrack.enabled ? 'Microphone on' : 'Microphone off';
};
torchBtn.onclick = async () => {
  torchOn = !torchOn;
  try {
    await stream?.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn } as MediaTrackConstraintSet] });
  } catch {
    torchOn = false;
  }
};
reconnectBtn.onclick = () => {
  closedForGood = false;
  retry = 0;
  if (!stream) void start();
  else connect();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void keepAwake();
});
window.addEventListener('online', () => {
  if (!closedForGood && ws?.readyState !== WebSocket.OPEN) connect();
});
void start();
