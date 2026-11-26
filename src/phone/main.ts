/**
 * The phone page (served at /phone by the dev server in LAN mode). No framework.
 * Reads the pairing token from the URL, opens the camera, joins the session over a WebSocket and sends the camera to the
 * desktop with WebRTC (host candidates only). If the desktop asks for it (WebRTC did not connect), it sends JPEG frames over
 * the WebSocket instead. `?fake=1` streams a generated animation instead of the camera (for testing without a phone).
 *
 * Modes (see link-modes.ts): `camera` (default), `scan` (photograph printed sheets, scan-mode.ts), `controller` (motion / touch only) and
 * `stopmotion` (the phone is the capture rig for the Stop Motion node: stopmotion.ts, stopmotion-view.ts; it also sends the live camera).
 * The link completes with a typed `hello {mode, media}` message, so it does not need camera or microphone frames: a refused camera or
 * "Controller only" still links.
 */

import { closeMessage } from './messages';
import { createMotion } from './motion';
import { modeFromSearch, parseModeMsg, thirdStepLabel, type PhoneMedia, type PhoneMode } from './link-modes';
import { createScanMode } from './scan-mode';
import { isScanFrame } from './scan-protocol';
import { createScan3dMode } from './scan3d';
import { createStopMotionPhone } from './stopmotion';
import { browserStillEnv, captureStill, makeThumb, setCameraLock } from './stopmotion-camera';
import { createStopMotionView } from './stopmotion-view';

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

const motion = createMotion({ send: (m) => send(m), fake });
let mode: PhoneMode = modeFromSearch(location.search);
/** Is a camera picture going to the computer? Only camera mode with a working camera sends one. */
let media: PhoneMedia = mode === 'camera' ? 'video' : 'none';
const scan = createScanMode({
  send: (m) => send(m),
  sendBinary: (d) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(d);
  },
  buffered: () => ws?.bufferedAmount ?? 0,
  isOpen: () => ws?.readyState === WebSocket.OPEN,
});
const scan3d = createScan3dMode({
  send: (m) => send(m),
  sendBinary: (d) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(d);
  },
  buffered: () => ws?.bufferedAmount ?? 0,
  isOpen: () => ws?.readyState === WebSocket.OPEN,
});
/** Stop motion capture rig: shots go to the computer over the same socket (stopmotion-protocol.ts). */
const smHost = {
  video: document.getElementById('smVideo') as HTMLVideoElement,
  track: () => stream?.getVideoTracks()[0] ?? null,
};
const smStill = browserStillEnv(smHost.video, smHost.track);
const sm = createStopMotionPhone({
  send: (m) => send(m),
  isOpen: () => ws?.readyState === WebSocket.OPEN,
  buffered: () => ws?.bufferedAmount ?? 0,
  now: () => performance.now(),
  later: (ms, fn) => {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
  wakeLock: async () => {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      const lock = wl ? await wl.request('screen') : null;
      return lock ? () => void lock.release().catch(() => undefined) : null;
    } catch {
      return null;
    }
  },
  still: (maxSide) => captureStill(smStill, maxSide),
  thumb: (still) => makeThumb(new Blob([still.bytes as BlobPart], { type: still.mime })),
  lock: (on) => setCameraLock(smHost.track(), on),
  newSid: () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 12),
});
const smView = createStopMotionView(sm, { switchCamera: () => switchBtn.click(), close: () => void setMode('camera') });
const stepsEl = document.getElementById('steps') as HTMLElement;
const steps: Record<string, 'ok' | 'bad' | 'wait'> = { reached: 'wait', accepted: 'wait', video: 'wait' };
const STEP_TEXT: Record<string, string> = { reached: 'Reached your computer', accepted: 'Code accepted', video: 'Video connected' };
const controlsEl = $<HTMLElement>('controls');
const modeButtons: Partial<Record<PhoneMode, HTMLButtonElement>> = {
  camera: $<HTMLButtonElement>('modeCamera'),
  scan: $<HTMLButtonElement>('modeScan'),
  controller: $<HTMLButtonElement>('modeController'),
  stopmotion: $<HTMLButtonElement>('modeStopmotion'),
};
/** Modes that show the camera and send it to the computer as the live picture. */
const showsCamera = (m: PhoneMode): boolean => m === 'camera' || m === 'stopmotion';

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
  smView.setStream(stream);
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
  // sensor frames are disposable: when the socket is backed up (JPEG fallback on a slow network) the latest one matters, not the queue
  const sensor = (msg as { type?: string }).type === 'motion' || (msg as { type?: string }).type === 'touch' || (msg as { type?: string }).type === 'ar';
  if (sensor && ws && ws.bufferedAmount > 150_000) return;
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
    motion.onOpen(); // the computer learns which sensors this phone has
    sendHello();
    scan.onOpen();
    scan3d.onOpen();
    if (mode === 'stopmotion') sm.onOpen();
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      if (ev.data instanceof ArrayBuffer && isScanFrame(ev.data)) scan.onBinary(ev.data); // a preview chunk
      return;
    }
    let msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit; mode?: string };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (scan.onMessage(msg)) return;
    if (scan3d.onMessage(msg)) return; // 3D scan: answers to photos, limits, Stop
    if (mode === 'stopmotion' && sm.onMessage(msg)) return;
    chain = chain
      .then(async () => {
        if (msg.type === 'ready') {
          setStep('reached', 'ok');
          setStep('accepted', 'ok');
          status(showsCamera(mode) && media === 'video' ? 'Code accepted. Waiting for the computer…' : mode === 'scan' ? 'Linked: scan mode' : mode === 'scan3d' ? 'Linked: 3D scan' : mode === 'controller' ? 'Controller linked' : 'Linked without a picture', showsCamera(mode) && media === 'video' ? 'wait' : 'ok');
          if (media !== 'video') setStep('video', 'ok');
        }
        else if (msg.type === 'mode') {
          const m = parseModeMsg(msg);
          if (m) await setMode(m.mode);
        } else if (msg.type === 'offer' && msg.sdp && showsCamera(mode) && stream) await onOffer(msg.sdp);
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
    if (sock === ws) scan.onClose(); // an upload in progress waits for the reconnect and resumes
    if (sock === ws) scan3d.onClose();
    if (sock === ws && mode === 'stopmotion') sm.onClose(); // shots on the way are kept and resumed
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

/** Say what this phone is doing, so the computer can show it as linked without waiting for a picture. */
function sendHello(): void {
  send({ type: 'hello', v: 1, mode, media });
}

function showMode(): void {
  (Object.keys(modeButtons) as PhoneMode[]).forEach((m) => modeButtons[m]?.setAttribute('aria-pressed', String(m === mode)));
  const cam = mode === 'camera';
  preview.hidden = !showsCamera(mode); // in stop motion it stays under the capture screen (the fallback frames are taken from it)
  controlsEl.hidden = !cam;
  smView.show(mode === 'stopmotion');
  document.body.classList.toggle('has-camera', cam);
  STEP_TEXT.video = thirdStepLabel(mode, media);
  setStep('video', steps.video);
}

function stopCameraStream(): void {
  stream?.getVideoTracks().forEach((t) => t.stop());
  stream = null;
  preview.srcObject = null;
  pc?.close();
  pc = null;
  stopJpeg();
}

/** Switch what the phone does (by the user, or because the computer asked). Always ends with a new hello. */
async function setMode(next: PhoneMode): Promise<void> {
  const same = next === mode;
  mode = next;
  if (!showsCamera(mode)) {
    stopCameraStream();
    media = 'none';
  }
  if (mode !== 'stopmotion') sm.leave();
  if (mode === 'scan') {
    status('Scan mode', 'ok', 'Photograph each printed sheet. Photos go to your computer.');
    await scan.enter();
  } else {
    scan.leave();
  }
  if (mode === 'scan3d') {
    status('3D scan mode (experimental)', 'ok', 'Photos and camera positions go to your computer.');
    await scan3d.enter();
  } else scan3d.leave();
  if (showsCamera(mode) && (!same || !stream)) {
    if (mode === 'stopmotion' && Number(resSel.value) < 1080) resSel.value = '1080'; // the live picture and the fallback still
    status('Asking for the camera…', 'wait', 'Please allow camera access.');
    try {
      await openCamera(true);
      media = 'video';
      status('Camera on', 'wait', 'Connecting the picture to your computer…');
    } catch (err) {
      media = 'refused';
      const name = (err as { name?: string }).name;
      status('Linked without a picture', 'ok', name === 'NotAllowedError' ? 'Camera permission was denied, so no picture is sent. Motion and touch still work. Allow the camera in the browser settings and press Camera to try again.' : String((err as Error).message ?? err));
    }
  } else if (mode === 'controller') {
    status('Controller linked', 'ok', 'No picture is sent. Use Start motion below for gyroscope and touch.');
  }
  showMode();
  if (mode === 'stopmotion') sm.enter();
  if (ws?.readyState === WebSocket.OPEN) {
    sendHello();
    if (mode === 'stopmotion') sm.onOpen(); // after the hello: the computer learns the mode first
    if (media !== 'video') setStep('video', 'ok'); // the typed handshake is the link: no picture is needed
  }
}

async function start(): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    status('No valid link', 'bad', 'Scan the QR code shown on the computer.');
    return;
  }
  showMode();
  if (mode === 'scan') {
    status('Scan mode', 'wait', 'Connecting to your computer…');
    await scan.enter();
  } else if (mode === 'controller') {
    status('Controller', 'wait', 'Connecting to your computer…');
  } else if (mode === 'scan3d') {
    status('3D scan mode (experimental)', 'wait', 'Connecting to your computer…');
    await scan3d.enter();
  } else {
    if (mode === 'stopmotion') resSel.value = '1080';
    status('Asking for the camera…', 'wait', 'Please allow camera access.');
    try {
      await openCamera(true);
      media = 'video';
    } catch (err) {
      // a refused camera must not stop the link: it completes without a picture (motion, touch and the controller still work)
      media = 'refused';
      const name = (err as { name?: string }).name;
      status('Camera not available', 'bad', name === 'NotAllowedError' ? 'Camera permission was denied. Linking without a picture; allow the camera in the browser settings and press Camera to send it.' : String((err as Error).message ?? err));
    }
  }
  showMode();
  if (mode === 'stopmotion') sm.enter();
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
  if (!stream && mode === 'camera') void start();
  else connect();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void keepAwake();
  void scan.visibility(document.visibilityState === 'visible');
});
window.addEventListener('online', () => {
  if (!closedForGood && ws?.readyState !== WebSocket.OPEN) connect();
});
for (const m of Object.keys(modeButtons) as PhoneMode[]) modeButtons[m]!.onclick = () => void setMode(m).catch((err) => status('Could not switch', 'bad', String((err as Error).message ?? err)));
$('scanExit').onclick = () => void setMode('camera');
void start();
