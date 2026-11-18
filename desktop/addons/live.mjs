// "Go live" for the desktop app: the renderer records its output (picture of the viewer + the sound mix) with MediaRecorder and posts
// the pieces here; this feeds them to FFmpeg, which re-encodes to what streaming services take (H.264 + AAC in FLV) and sends it to an
// RTMP / RTMPS address. One stream at a time. The stream key never leaves this module except inside the address given to FFmpeg: it is
// removed from everything that is logged or returned to the page.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export class LiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where each service takes a stream. `{key}` is replaced by the stream key. RTMPS first; `plain` is used when this FFmpeg has no TLS. */
export const LIVE_SERVICES = {
  twitch: { label: 'Twitch', secure: 'rtmps://live.twitch.tv:443/app/{key}', plain: 'rtmp://live.twitch.tv/app/{key}' },
  youtube: { label: 'YouTube', secure: 'rtmps://a.rtmps.youtube.com:443/live2/{key}', plain: 'rtmp://a.rtmp.youtube.com/live2/{key}' },
};

/** H.264 encoders in order of preference: the software one first (same picture on every computer), then the hardware ones. */
export const H264_ENCODERS = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_mf', 'libopenh264'];

const int = (v, lo, hi, what) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw new LiveError(`${what} must be between ${lo} and ${hi}.`);
  return n;
};

/**
 * The address to stream to. `service` 'custom' takes a full rtmp:// or rtmps:// address in `url` (the key may be part of it or given
 * separately and appended); a known service takes only the key. Returns the address and the secret parts to hide in logs.
 */
export function liveTarget({ service, key, url }, hasTls = true) {
  const k = String(key ?? '').trim();
  if (service === 'custom') {
    const u = String(url ?? '').trim();
    if (!/^rtmps?:\/\/[^\s/]+\/\S*$/i.test(u)) throw new LiveError('The address must start with rtmp:// or rtmps:// and name a server and an application, like rtmp://example.com/live.');
    if (/^rtmps:/i.test(u) && !hasTls) throw new LiveError('This FFmpeg cannot open secure (rtmps) addresses. Use an rtmp:// address, or an FFmpeg built with TLS.');
    const full = k ? `${u.replace(/\/+$/, '')}/${k}` : u;
    const tail = full.split('/').pop() ?? '';
    return { url: full, secrets: [k, tail].filter((s) => s.length >= 4) };
  }
  const svc = LIVE_SERVICES[service];
  if (!svc) throw new LiveError('Unknown streaming service.');
  if (!/^[\w\-=?&.]{8,200}$/.test(k)) throw new LiveError(`Paste your ${svc.label} stream key (from the ${svc.label} creator dashboard).`);
  return { url: (hasTls ? svc.secure : svc.plain).replace('{key}', k), secrets: [k] };
}

/** Remove the stream key (and any other secret) from text that is logged or sent back to the page. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('•••');
  return out;
}

/**
 * FFmpeg arguments: the recording arrives on stdin (WebM / Matroska from MediaRecorder), is fitted into width x height at `fps`, encoded
 * as H.264 with a key frame every 2 seconds at a constant bitrate (what streaming services ask for) and AAC, and sent as FLV.
 * Without sound in the recording a silent track is added: services reject or stall on streams with no audio.
 */
export function liveArgs({ width, height, fps, videoKbps, audioKbps, hasAudio, encoder, url }) {
  const gop = fps * 2;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`;
  const video =
    encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`]
      : ['-c:v', encoder, '-g', String(gop)];
  return [
    '-hide_banner', '-loglevel', 'info', '-stats',
    '-fflags', '+genpts', '-thread_queue_size', '1024', '-i', 'pipe:0',
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']),
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    ...video,
    '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ar', '48000', '-ac', '2',
    ...(hasAudio ? [] : ['-shortest']),
    '-f', 'flv', url,
  ];
}

/** `frame=  120 fps= 30 ... time=00:00:04.00 bitrate=2500.1kbits/s speed=1.00x` -> numbers (null when the line is not a progress line). */
export function parseProgress(line) {
  const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?time=\s*(\d+):(\d+):([\d.]+).*?bitrate=\s*(?:([\d.]+)\s*kbits\/s|N\/A)(?:.*?speed=\s*([\d.]+|N\/A)x?)?/.exec(line);
  if (!m) return null;
  return { frames: Number(m[1]), fps: Number(m[2]), seconds: Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]), kbps: m[6] ? Number(m[6]) : 0, speed: m[7] && m[7] !== 'N/A' ? Number(m[7]) : 0 };
}

/** The last useful line FFmpeg printed, in plain words where the cause is a common one. */
export function explainFailure(log) {
  const text = log.join('\n');
  if (/Connection refused|Failed to resolve|Name or service not known|Network is unreachable|Cannot open connection|timed out/i.test(text)) return 'Could not reach the streaming server. Check the internet connection and the address.';
  if (/Server error|Error number -10053|Broken pipe|Connection reset|End of file|Input\/output error/i.test(text) && /rtmp|flv/i.test(text)) return 'The streaming server closed the connection. The stream key may be wrong or expired, or another stream is already live on it.';
  if (/Unknown encoder|Encoder .* not found/i.test(text)) return 'This FFmpeg has no H.264 encoder, which streaming needs.';
  if (/Protocol not found/i.test(text)) return 'This FFmpeg cannot open that kind of address.';
  const last = log.filter((l) => l.trim() && !/^frame=/.test(l)).pop();
  return last ? `FFmpeg stopped: ${last.trim().slice(0, 300)}` : 'FFmpeg stopped unexpectedly.';
}

/**
 * @param {{ binary: () => Promise<string | null>, spawn?: typeof nodeSpawn, probe?: (bin: string) => Promise<{ encoders: Set<string>, tls: boolean }> }} cfg
 */
export function createLiveService({ binary, spawn = nodeSpawn, probe = probeFfmpegLive }) {
  /** @type {null | { id: string, proc: import('node:child_process').ChildProcess, secrets: string[], started: number, bytes: number, log: string[], progress: ReturnType<typeof parseProgress>, error: string | null, ended: boolean, chain: Promise<void>, settings: object }} */
  let session = null;
  let last = null; // the state of the stream that ended last, so the page can show why

  const view = (s) =>
    s
      ? { id: s.id, live: !s.ended, seconds: s.progress?.seconds ?? 0, wallSeconds: Math.round((Date.now() - s.started) / 1000), bytes: s.bytes, fps: s.progress?.fps ?? 0, kbps: s.progress?.kbps ?? 0, speed: s.progress?.speed ?? 0, error: s.error, settings: s.settings }
      : null;

  const finish = (s, error) => {
    if (s.ended) return;
    s.ended = true;
    if (error && !s.error) s.error = error;
    last = view(s);
    if (session === s) session = null;
  };

  return {
    services: () => Object.entries(LIVE_SERVICES).map(([id, s]) => ({ id, label: s.label })),
    get active() {
      return !!session;
    },
    status: () => ({ current: view(session), last }),

    async start(body) {
      if (session) throw new LiveError('A stream is already running. Stop it first.', 409);
      const bin = await binary();
      if (!bin) throw new LiveError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      const width = int(body.width, 160, 3840, 'Width');
      const height = int(body.height, 90, 2160, 'Height');
      const fps = int(body.fps, 5, 60, 'Frame rate');
      const videoKbps = int(body.videoKbps, 200, 51000, 'Video bitrate');
      const audioKbps = int(body.audioKbps ?? 160, 32, 320, 'Audio bitrate');
      const caps = await probe(bin);
      const encoder = H264_ENCODERS.find((e) => caps.encoders.has(e));
      if (!encoder) throw new LiveError('This FFmpeg has no H.264 encoder, which streaming needs. Install the FFmpeg add-on, or locate an FFmpeg with libx264.', 409);
      const target = liveTarget({ service: String(body.service ?? ''), key: body.key, url: body.url }, caps.tls);
      const args = liveArgs({ width: width - (width % 2), height: height - (height % 2), fps, videoKbps, audioKbps, hasAudio: body.hasAudio === true, encoder, url: target.url });
      const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      const s = { id: randomBytes(8).toString('hex'), proc, secrets: target.secrets, started: Date.now(), bytes: 0, log: [], progress: null, error: null, ended: false, chain: Promise.resolve(), settings: { service: String(body.service), width, height, fps, videoKbps, audioKbps, encoder } };
      session = s;
      last = null;
      let partial = '';
      proc.stderr.on('data', (d) => {
        partial += d.toString();
        const lines = partial.split(/\r|\n/);
        partial = lines.pop() ?? '';
        for (const raw of lines) {
          const line = redact(raw, s.secrets);
          const p = parseProgress(line);
          if (p) s.progress = p;
          else if (line.trim()) {
            s.log.push(line);
            if (s.log.length > 60) s.log.shift();
          }
        }
      });
      proc.stdin.on('error', () => undefined); // reported through the exit
      proc.on('error', (err) => finish(s, `FFmpeg could not start: ${redact(err.message, s.secrets)}`));
      proc.on('close', (code) => finish(s, s.stopping || code === 0 ? null : explainFailure(s.log)));
      return { id: s.id, encoder, secure: /^rtmps:/i.test(target.url) };
    },

    /** One piece of the recording, in order. Answered when FFmpeg has taken it, so the page cannot run ahead of the encoder. */
    async chunk(id, buf) {
      const s = session;
      if (!s || s.id !== id) {
        const why = last && last.id === id ? (last.error ?? 'The stream has ended.') : 'Unknown or finished stream.';
        throw new LiveError(why, 410);
      }
      if (!buf.byteLength) return { bytes: s.bytes };
      s.chain = s.chain.then(
        () =>
          new Promise((resolve) => {
            if (s.ended || !s.proc.stdin.writable) return resolve();
            s.bytes += buf.byteLength;
            if (s.proc.stdin.write(buf)) resolve();
            else s.proc.stdin.once('drain', resolve);
          }),
      );
      return s.chain.then(() => {
        if (s.ended) throw new LiveError(s.error ?? 'The stream has ended.', 410);
        return { bytes: s.bytes };
      });
    },

    /** End the stream: FFmpeg gets the end of the recording and a few seconds to send what is left. */
    async stop(id) {
      const s = session;
      if (!s || (id && s.id !== id)) return { stopped: false, ...this.status() };
      s.stopping = true;
      await s.chain.catch(() => undefined);
      try {
        s.proc.stdin.end();
      } catch {
        /* already closed */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            s.proc.kill();
          } catch {
            /* gone */
          }
          resolve();
        }, 5000);
        s.proc.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        if (s.ended) {
          clearTimeout(timer);
          resolve();
        }
      });
      finish(s, null);
      return { stopped: true, ...this.status() };
    },

    /** App quit: do not leave an FFmpeg streaming behind. */
    dispose() {
      if (!session) return;
      session.stopping = true;
      try {
        session.proc.kill();
      } catch {
        /* gone */
      }
      finish(session, null);
    },
  };
}

/** Which H.264 encoders this FFmpeg has and whether it can open rtmps:// (two short runs, cached per binary). */
const probed = new Map();
export function probeFfmpegLive(bin) {
  let p = probed.get(bin);
  if (!p) {
    const run = (args) =>
      new Promise((resolve) => {
        let out = '';
        try {
          const proc = nodeSpawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
          proc.stdout.on('data', (d) => (out += d.toString()));
          proc.on('error', () => resolve(''));
          proc.on('close', () => resolve(out));
        } catch {
          resolve('');
        }
      });
    p = Promise.all([run(['-hide_banner', '-encoders']), run(['-hide_banner', '-protocols'])]).then(([enc, proto]) => ({
      encoders: new Set(H264_ENCODERS.filter((e) => new RegExp(`\\s${e}\\s`).test(enc))),
      tls: /^\s*rtmps\s*$/m.test(proto),
    }));
    probed.set(bin, p);
  }
  return p;
}
