// "Fast copy" as HAP for the desktop app: the page uploads a clip from its Media panel, the app's FFmpeg re-encodes it to HAP
// (pictures stored as the compressed textures graphics cards read directly, so the page plays them without a video decoder, see
// src/io/hap-video.ts), and the page downloads the result into Media. The browser has no HAP encoder, which is why this lives here.
//
// The page never names a path: the clip is written into a work folder this module makes, and the result is read back from it in
// pieces (HAP files are large: about 30 MB a second at 1080p, twice that for HAP Q and HAP Alpha).
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class HapConvertError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** FFmpeg's names of the three kinds of HAP it writes, with what each is for. */
export const HAP_FORMATS = {
  hap: { label: 'HAP', bytesPerPixel: 0.5 },
  hap_q: { label: 'HAP Q', bytesPerPixel: 1 },
  hap_alpha: { label: 'HAP Alpha', bytesPerPixel: 1 },
};

/** A job nobody asked about for this long is removed (the page was closed or reloaded half way). */
export const JOB_IDLE_MS = 30 * 60 * 1000;
const MAX_DIM = 16384;
/** One upload request or one download request. */
export const MAX_PIECE = 64 * 1024 * 1024;
/**
 * The largest result made, estimated before starting from the size, the length and the kind (Snappy usually makes the real file
 * smaller). The result has to travel back to the page and be stored with the project's media, so a clip that would be tens of
 * gigabytes is refused up front with advice instead of filling the disk.
 */
export const MAX_RESULT_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_JOBS = 4;

const whole = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HapConvertError(`${what} must be a whole number from ${lo} to ${hi}.`);
  return n;
};

/**
 * The size of the HAP copy: the clip scaled down (never up) so its longer side is at most `maxSide`, and both sides multiples
 * of 4, because HAP stores the picture in blocks of 4x4 pixels and FFmpeg's encoder refuses anything else. Rounding to a
 * multiple of 4 can stretch the picture by a pixel or two; that is not visible.
 */
export function hapPlan(width, height, maxSide) {
  const long = Math.max(width, height, 4);
  const k = Math.min(1, maxSide / long);
  const four = (v) => Math.max(4, Math.round((v * k) / 4) * 4);
  return { width: four(width), height: four(height) };
}

/** Estimated bytes of the result before Snappy: the blocks of every frame. */
export function hapEstimateBytes(format, width, height, frames) {
  return Math.ceil(width * height * HAP_FORMATS[format].bytesPerPixel * Math.max(1, frames));
}

/**
 * FFmpeg arguments. The first picture track and, when the clip has one, its first sound track (as uncompressed PCM: the page
 * reads that without a decoder, and next to HAP pictures its size does not matter). Phone clips stored sideways are turned
 * upright by FFmpeg on its own, so `width` x `height` is the size the clip is shown at.
 */
export function hapArgs({ input, output, format, width, height }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${width}:${height}:flags=bicubic`,
    '-c:v', 'hap', '-format', format,
    '-c:a', 'pcm_s16le',
    '-f', 'mov', output,
  ];
}

/** `frame=  120 fps= 30 ... time=00:00:04.00 ...` -> seconds done (null when the line is not a progress line). */
export function parseTime(line) {
  const m = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Why FFmpeg stopped, in plain words where the cause is a common one. */
export function explainFailure(log) {
  const text = log.join('\n');
  if (/Unknown encoder|Encoder .*not found|Error (?:while )?opening encoder|snappy/i.test(text) && /hap/i.test(text)) return 'This FFmpeg cannot write HAP (it was built without the hap encoder). Locate a fuller FFmpeg build in Plugins, Official add-ons, or use the H.264 fast copy.';
  if (/No space left on device/i.test(text)) return 'The disk is full: HAP files are large. Free some space or choose a smaller size.';
  if (/Invalid data found|moov atom not found|could not find codec parameters|does not contain any stream|matches no streams/i.test(text)) return 'FFmpeg could not read this clip.';
  const last = log.filter((l) => l.trim() && !/^frame=/.test(l.trim())).pop();
  return last ? `FFmpeg stopped: ${last.trim().slice(0, 300)}` : 'FFmpeg stopped unexpectedly.';
}

/**
 * @param {{ tmpRoot: string, binary: () => Promise<string | null>, spawn?: typeof nodeSpawn, probe?: (bin: string) => Promise<boolean> }} cfg
 */
export function createHapConvertService({ tmpRoot, binary, spawn = nodeSpawn, probe = probeHapEncoder }) {
  mkdirSync(tmpRoot, { recursive: true });
  /** id -> { id, dir, input, output, format, plan, duration, state, uploaded, seconds, bytes, error, proc, log, last } */
  const jobs = new Map();
  let sweeper = null;

  const drop = (j) => {
    jobs.delete(j.id);
    j.dropped = true;
    try {
      j.proc?.kill();
    } catch {
      /* gone */
    }
    rmSync(j.dir, { recursive: true, force: true });
  };
  const need = (id) => {
    const j = jobs.get(id);
    if (!j) throw new HapConvertError('Unknown or finished conversion.', 404);
    j.last = Date.now();
    return j;
  };
  const view = (j) => {
    const fraction = j.state === 'done' ? 1 : j.state === 'running' && j.duration > 0 ? Math.max(0, Math.min(0.99, j.seconds / j.duration)) : 0;
    return { id: j.id, state: j.state, fraction, bytes: j.bytes, width: j.plan.width, height: j.plan.height, error: j.error };
  };

  return {
    jobs,

    /** What is possible here: is there an FFmpeg, and can it write HAP (only builds with libsnappy can; small "essentials" builds often cannot). */
    async info() {
      const bin = await binary();
      if (!bin) return { available: false, hap: false };
      let hap = false;
      try {
        hap = await probe(bin);
      } catch {
        hap = false;
      }
      return { available: true, hap };
    },

    /** Open a job. `width`, `height`: the clip as shown; `maxSide`: longest side of the copy; `duration` (s) and `fps`: for progress and the size estimate. */
    async start(body) {
      const bin = await binary();
      if (!bin) throw new HapConvertError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      const format = String(body?.format ?? '');
      if (!Object.hasOwn(HAP_FORMATS, format)) throw new HapConvertError(`Unknown HAP kind "${format}". Available: ${Object.keys(HAP_FORMATS).join(', ')}.`);
      const width = whole(body.width, 1, MAX_DIM, 'Width');
      const height = whole(body.height, 1, MAX_DIM, 'Height');
      const maxSide = whole(body.maxSide ?? MAX_DIM, 16, MAX_DIM, 'The size');
      const duration = Number(body.duration);
      const fps = Number(body.fps);
      if (!(duration >= 0 && duration < 24 * 3600)) throw new HapConvertError('The length of the clip is needed.');
      if (!(fps > 0 && fps <= 240)) throw new HapConvertError('The frame rate of the clip is needed.');
      if (!(await probe(bin).catch(() => false))) throw new HapConvertError('This FFmpeg cannot write HAP (it was built without the hap encoder). Locate a fuller FFmpeg build in Plugins, Official add-ons, or use the H.264 fast copy.', 409);
      const plan = hapPlan(width, height, maxSide);
      const estimate = hapEstimateBytes(format, plan.width, plan.height, Math.ceil(duration * fps));
      if (estimate > MAX_RESULT_BYTES) {
        throw new HapConvertError(`This clip would become a HAP file of about ${(estimate / 1024 ** 3).toFixed(1)} GB, which is more than this can handle (${MAX_RESULT_BYTES / 1024 ** 3} GB). Choose a smaller size, trim the clip first, or use the H.264 fast copy.`);
      }
      if (jobs.size >= MAX_JOBS) throw new HapConvertError('Too many conversions are open. Wait for one to finish.', 409);
      // the extension only helps FFmpeg guess the container; anything odd becomes a neutral one
      const ext = /^[a-z0-9]{1,5}$/.test(String(body.ext ?? '').toLowerCase()) ? String(body.ext).toLowerCase() : 'bin';
      const dir = mkdtempSync(join(tmpRoot, 'hap-'));
      const j = { id: randomBytes(8).toString('hex'), bin, dir, input: join(dir, `in.${ext}`), output: join(dir, 'out.mov'), format, plan, duration, state: 'uploading', uploaded: 0, seconds: 0, bytes: 0, error: null, proc: null, log: [], last: Date.now(), dropped: false };
      jobs.set(j.id, j);
      sweeper ??= setInterval(() => jobs.forEach((x) => Date.now() - x.last > JOB_IDLE_MS && drop(x)), 60_000);
      sweeper.unref?.();
      return { id: j.id, width: plan.width, height: plan.height, estimate };
    },

    /** The next piece of the clip, in order. */
    chunk(id, buf) {
      const j = need(id);
      if (j.state !== 'uploading') throw new HapConvertError('The clip was already handed over.', 409);
      if (buf.byteLength === 0 || buf.byteLength > MAX_PIECE) throw new HapConvertError(`A piece is 1 byte to ${MAX_PIECE / 1048576} MB.`, 413);
      try {
        appendFileSync(j.input, buf);
      } catch (err) {
        drop(j);
        throw new HapConvertError(/ENOSPC/.test(String(err?.code)) ? 'The disk is full.' : `The clip could not be stored for converting: ${String(err?.message ?? err)}`, 500);
      }
      j.uploaded += buf.byteLength;
      return { bytes: j.uploaded };
    },

    /** The whole clip is here: start FFmpeg. Answers at once; ask `status` for progress. */
    run(id) {
      const j = need(id);
      if (j.state !== 'uploading') throw new HapConvertError('This conversion was already started.', 409);
      if (j.uploaded === 0) throw new HapConvertError('The clip is empty.');
      const fail = (message) => {
        if (j.state !== 'running') return;
        j.state = 'error';
        j.error = message;
        j.proc = null;
      };
      j.state = 'running';
      let proc;
      try {
        proc = spawn(j.bin, hapArgs({ input: j.input, output: j.output, format: j.format, width: j.plan.width, height: j.plan.height }), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch (err) {
        fail(`FFmpeg could not start: ${String(err?.message ?? err)}`);
        return view(j);
      }
      j.proc = proc;
      let partial = '';
      proc.stderr.on('data', (d) => {
        partial += d.toString();
        const lines = partial.split(/\r|\n/);
        partial = lines.pop() ?? '';
        for (const line of lines) {
          const t = parseTime(line);
          if (t !== null && /frame=/.test(line)) j.seconds = t;
          else if (line.trim()) {
            j.log.push(line);
            if (j.log.length > 60) j.log.shift();
          }
        }
      });
      proc.on('error', (err) => fail(`FFmpeg could not start: ${String(err?.message ?? err)}`));
      proc.on('close', (code) => {
        if (j.dropped || j.state !== 'running') return;
        if (partial.trim() && parseTime(partial) === null) j.log.push(partial);
        if (code !== 0) return fail(explainFailure(j.log));
        try {
          j.bytes = statSync(j.output).size;
        } catch {
          j.bytes = 0;
        }
        if (j.bytes === 0) return fail('FFmpeg wrote an empty file.');
        j.proc = null;
        j.state = 'done';
        rmSync(j.input, { force: true }); // the source copy is not needed any more: give the disk space back early
      });
      return view(j);
    },

    status(id) {
      return view(need(id));
    },

    /** Bytes [at, at + length) of the finished file. */
    read(id, at, length) {
      const j = need(id);
      if (j.state !== 'done') throw new HapConvertError(j.state === 'error' ? (j.error ?? 'The conversion failed.') : 'The conversion has not finished.', 409);
      if (!Number.isInteger(at) || at < 0 || at >= j.bytes) throw new HapConvertError('That position is outside the file.');
      if (!Number.isInteger(length) || length < 1 || length > MAX_PIECE) throw new HapConvertError(`A piece is 1 byte to ${MAX_PIECE / 1048576} MB.`);
      const n = Math.min(length, j.bytes - at);
      const buf = Buffer.allocUnsafe(n);
      const fd = openSync(j.output, 'r');
      try {
        let done = 0;
        while (done < n) {
          const got = readSync(fd, buf, done, n - done, at + done);
          if (got <= 0) throw new HapConvertError('The converted file could not be read.', 500);
          done += got;
        }
      } finally {
        closeSync(fd);
      }
      return buf;
    },

    /** Stop (kills FFmpeg when it runs) and delete the work folder. Also the normal end after the page has the file. */
    cancel(id) {
      const j = jobs.get(id);
      if (j) drop(j);
      return { canceled: true };
    },

    /** App quit: no FFmpeg left running, no work folders left behind. */
    disposeAll() {
      clearInterval(sweeper);
      sweeper = null;
      for (const j of [...jobs.values()]) drop(j);
    },
  };
}

/** Does this FFmpeg have the `hap` encoder? (One short run, remembered per binary.) */
const probed = new Map();
export function probeHapEncoder(bin, spawn = nodeSpawn) {
  let p = probed.get(bin);
  if (!p) {
    p = new Promise((resolve) => {
      let out = '';
      try {
        const proc = spawn(bin, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.on('error', () => resolve(false));
        proc.on('close', () => resolve(hasHapEncoder(out)));
      } catch {
        resolve(false);
      }
    });
    probed.set(bin, p);
  }
  return p;
}

/** True when the text `ffmpeg -encoders` prints lists a video encoder named exactly `hap`. */
export function hasHapEncoder(text) {
  return /^\s*V[.A-Z]{5}\s+hap\s/m.test(String(text));
}
