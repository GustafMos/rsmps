// Streaming video export through FFmpeg for the desktop app. The renderer posts raw RGBA frames (straight alpha); this
// feeds them to the same VideoWriter the CLI uses (src/cli/encode.ts, bundled in: one implementation of the codec
// argument sets). Back-pressure: a frame request is answered only after ffmpeg accepted its bytes.
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { CODECS, VideoWriter, parseCodec, availableEncoders, requireEncoder, ffmpegStillFile, ffmpegSoundFile } from '../../src/cli/encode.ts';
import { wantedPresent } from '../../src/io/ffmpeg-encoders.ts';
import { ALL_ENCODERS, minSizeMessage, rowById } from '../../src/io/export-codecs.ts';
import { setFfmpegBinary } from './shim-ffmpeg.mjs';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_DIM = 16384;
/** One write request of a file the app writes itself (a HAP frame of 8K is about 33 MB; a large audio chunk is smaller). */
const MAX_CHUNK = 256 * 1024 * 1024;
const MAX_POSITION = 2 ** 50;

export class ExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const codecList = () => Object.values(CODECS).map((c) => ({ id: c.id, label: c.label, ext: c.ext, alpha: c.alpha, even: c.even, audio: c.audio.length > 0 }));

/**
 * @param {{ tmpRoot: string, binary: () => Promise<string | null>, pickSavePath: (name: string, ext: string) => Promise<string | null> }} cfg
 */
export function createExportService({ tmpRoot, binary, pickSavePath }) {
  mkdirSync(tmpRoot, { recursive: true });
  const sessions = new Map();
  /** Files the app writes itself: id -> { fd, path, last }. The path only ever comes from the native Save dialog, never from the page. */
  const files = new Map();
  let sweeper = null;

  const dropFile = (f, remove) => {
    files.delete(f.id);
    try {
      closeSync(f.fd);
    } catch {
      /* already closed */
    }
    if (remove) {
      try {
        unlinkSync(f.path);
      } catch {
        /* already gone */
      }
    }
  };
  const needFile = (id) => {
    const f = files.get(id);
    if (!f) throw new ExportError('Unknown or finished file.', 404);
    f.last = Date.now();
    return f;
  };
  const tmpWork = () => mkdtempSync(join(tmpRoot, 'convert-'));
  const leaf = (v, d) => basename(String(v ?? d)).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || d;

  const drop = async (s) => {
    sessions.delete(s.id);
    try {
      await s.writer?.abort();
    } catch {
      /* already gone */
    }
    rmSync(s.dir, { recursive: true, force: true });
  };
  const need = (id) => {
    const s = sessions.get(id);
    if (!s) throw new ExportError('Unknown or finished export.', 404);
    s.last = Date.now();
    return s;
  };
  const sequential = (s, fn) => (s.chain = s.chain.then(fn, fn));

  return {
    sessions,
    codecs: codecList,

    /** Wanted encoders the installed FFmpeg has (asked once per binary), or null when there is no FFmpeg or it could not be asked. */
    async encoders() {
      const bin = await binary();
      if (!bin) return null;
      setFfmpegBinary(bin);
      try {
        const all = await availableEncoders();
        return all.size > 0 ? wantedPresent(all, ALL_ENCODERS) : null;
      } catch {
        return null;
      }
    },

    async start(body) {
      const bin = await binary();
      if (!bin) throw new ExportError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      if (sessions.size > 0) throw new ExportError('Another export is already running.', 409);
      const spec = CODECS[parseCodec(String(body?.codec ?? '')) ?? ''];
      if (!spec) throw new ExportError(`Unknown codec "${body?.codec}". Available: ${Object.keys(CODECS).join(', ')}.`);
      const width = Number(body.width), height = Number(body.height), fps = Number(body.fps);
      if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIM)) throw new ExportError('width and height must be whole numbers from 1 to 16384.');
      if (!(fps > 0 && fps <= 240)) throw new ExportError('fps must be between 0 and 240.');
      try {
        setFfmpegBinary(bin);
        await requireEncoder(spec);
      } catch (err) {
        throw new ExportError(String(err?.message ?? err), 409);
      }
      const small = minSizeMessage(spec.label, spec.minSize, width, height);
      if (small) throw new ExportError(small);
      if (spec.even && (width % 2 || height % 2)) throw new ExportError(`${spec.label} needs an even width and height (got ${width}x${height}).`);
      const audio = body.audio ? { sampleRate: Number(body.audio.sampleRate), channels: Number(body.audio.channels) } : null;
      if (audio && !(audio.sampleRate >= 8000 && audio.sampleRate <= 192000 && (audio.channels === 1 || audio.channels === 2))) throw new ExportError('audio needs sampleRate 8000-192000 and channels 1 or 2.');
      const bitrateMbps = body.bitrateMbps === undefined ? 12 : Number(body.bitrateMbps);
      if (!(bitrateMbps > 0 && bitrateMbps <= 500)) throw new ExportError('bitrateMbps must be between 0 and 500.');
      setFfmpegBinary(bin);
      const dir = mkdtempSync(join(tmpRoot, 'export-'));
      const s = { id: randomBytes(8).toString('hex'), spec, width, height, fps, bitrateMbps, allKeys: body.allKeys === true, audio, dir, audioFile: null, writer: null, frames: 0, last: Date.now(), chain: Promise.resolve(), name: basename(String(body.name ?? 'rsmps-export')).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'rsmps-export' };
      sessions.set(s.id, s);
      sweeper ??= setInterval(() => sessions.forEach((x) => Date.now() - x.last > SESSION_IDLE_MS && void drop(x)), 60_000).unref();
      return { id: s.id, ext: spec.ext, alpha: spec.alpha, even: spec.even, frameBytes: width * height * 4 };
    },

    /** Raw f32le interleaved PCM; allowed once, before the first frame. */
    async audio(id, buf) {
      const s = need(id);
      if (!s.audio) throw new ExportError('This export was started without audio.');
      if (s.writer || s.frames) throw new ExportError('Audio must be uploaded before the first frame.', 409);
      if (s.audioFile) throw new ExportError('Audio was already uploaded.', 409);
      if (buf.byteLength === 0 || buf.byteLength % (4 * s.audio.channels)) throw new ExportError('Audio must be f32le interleaved samples.');
      s.audioFile = join(s.dir, 'audio.f32');
      writeFileSync(s.audioFile, buf);
      return { bytes: buf.byteLength };
    },

    /** One or more whole frames of RGBA (width*height*4 bytes each). Resolves after ffmpeg accepted them. */
    async frame(id, buf) {
      const s = need(id);
      const size = s.width * s.height * 4;
      if (buf.byteLength === 0 || buf.byteLength % size) throw new ExportError(`A frame is ${size} bytes (RGBA, ${s.width}x${s.height}); got ${buf.byteLength}.`);
      return sequential(s, async () => {
        try {
          s.writer ??= await VideoWriter.open({ file: join(s.dir, 'out.' + s.spec.ext), width: s.width, height: s.height, fps: s.fps, codec: s.spec, bitrateMbps: s.bitrateMbps, allKeys: s.allKeys, audio: s.audio && s.audioFile ? { file: s.audioFile, ...s.audio } : undefined });
          for (let o = 0; o < buf.byteLength; o += size) {
            await s.writer.write(new Uint8ClampedArray(buf.buffer, buf.byteOffset + o, size));
            s.frames++;
          }
          return { frames: s.frames };
        } catch (err) {
          await drop(s);
          throw new ExportError(String(err?.message ?? err), 500);
        }
      });
    },

    /** Finishes the file, asks where to save it (native dialog, via pickSavePath) and copies it there. */
    async finish(id) {
      const s = need(id);
      return sequential(s, async () => {
        try {
          if (!s.writer) throw new ExportError('No frames were sent.');
          await s.writer.finish();
          const bytes = statSync(join(s.dir, 'out.' + s.spec.ext)).size;
          const target = await pickSavePath(s.name, s.spec.ext);
          if (!target) return { saved: false, canceled: true, bytes, frames: s.frames };
          copyFileSync(join(s.dir, 'out.' + s.spec.ext), target);
          return { saved: true, path: target, bytes, frames: s.frames };
        } catch (err) {
          throw err instanceof ExportError ? err : new ExportError(String(err?.message ?? err), 500);
        } finally {
          await drop(s);
        }
      });
    },

    async cancel(id) {
      const s = sessions.get(id);
      if (s) await drop(s);
      return { canceled: true };
    },

    /* ---- files the app writes itself (HAP and other big outputs): native Save dialog, then chunks at positions ---- */

    files,

    async fileStart(body) {
      const ext = String(body?.ext ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
      if (!ext) throw new ExportError('ext is needed.');
      const target = await pickSavePath(leaf(body?.name, 'rsmps-export'), ext);
      if (!target) return { saved: false, canceled: true };
      let fd;
      try {
        fd = openSync(target, 'w');
      } catch (err) {
        throw new ExportError(`Cannot write ${basename(target)}: ${String(err?.message ?? err)}`, 500);
      }
      const f = { id: randomBytes(8).toString('hex'), fd, path: target, bytes: 0, last: Date.now() };
      files.set(f.id, f);
      sweeper ??= setInterval(() => files.forEach((x) => Date.now() - x.last > SESSION_IDLE_MS && dropFile(x, true)), 60_000).unref();
      return { saved: true, id: f.id, path: target };
    },

    fileWrite(id, at, buf) {
      const f = needFile(id);
      if (!Number.isInteger(at) || at < 0 || at > MAX_POSITION) throw new ExportError('A whole, positive position is needed.');
      if (buf.byteLength === 0 || buf.byteLength > MAX_CHUNK) throw new ExportError(`A write is 1 byte to ${MAX_CHUNK / 1048576} MB.`);
      try {
        let done = 0;
        while (done < buf.byteLength) done += writeSync(f.fd, buf, done, buf.byteLength - done, at + done);
        f.bytes = Math.max(f.bytes, at + buf.byteLength);
        return { bytes: f.bytes };
      } catch (err) {
        dropFile(f, true);
        throw new ExportError(String(err?.message ?? err), 500);
      }
    },

    fileFinish(id) {
      const f = needFile(id);
      const bytes = statSync(f.path).size;
      dropFile(f, false);
      return { saved: true, path: f.path, bytes };
    },

    fileCancel(id) {
      const f = files.get(id);
      if (f) dropFile(f, true);
      return { canceled: true };
    },

    /* ---- one file through FFmpeg, returned to the page (pictures: DPX, JPEG 2000; sound: MP3, Opus, Vorbis, ALAC, AAC) ---- */

    async still(q, buf) {
      const bin = await binary();
      if (!bin) throw new ExportError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      const row = rowById(String(q.codec ?? ''));
      if (!row || row.kind !== 'still' || !row.encoders.length) throw new ExportError(`"${q.codec}" is not an FFmpeg picture format.`);
      const width = Number(q.width), height = Number(q.height);
      if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIM)) throw new ExportError('width and height must be whole numbers from 1 to 16384.');
      if (buf.byteLength !== width * height * 4) throw new ExportError(`A picture is ${width * height * 4} bytes (RGBA, ${width}x${height}); got ${buf.byteLength}.`);
      setFfmpegBinary(bin);
      const dir = tmpWork();
      try {
        const out = join(dir, 'out.' + row.ext);
        await ffmpegStillFile(row.id, buf, width, height, out);
        return readFileSync(out);
      } catch (err) {
        throw err instanceof ExportError ? err : new ExportError(String(err?.message ?? err), 500);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async sound(q, buf) {
      const bin = await binary();
      if (!bin) throw new ExportError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      const row = rowById(String(q.codec ?? ''));
      if (!row || row.kind !== 'audio') throw new ExportError(`"${q.codec}" is not a sound format.`);
      const rate = Number(q.rate), channels = Number(q.channels);
      if (!(rate >= 8000 && rate <= 192000 && (channels === 1 || channels === 2))) throw new ExportError('rate needs 8000-192000 and channels 1 or 2.');
      if (buf.byteLength === 0 || buf.byteLength % (4 * channels)) throw new ExportError('Sound must be f32le interleaved samples.');
      setFfmpegBinary(bin);
      const dir = tmpWork();
      try {
        const pcm = join(dir, 'in.f32');
        writeFileSync(pcm, buf);
        const out = join(dir, 'out.' + row.ext);
        await ffmpegSoundFile(row.id, pcm, rate, channels, out);
        return readFileSync(out);
      } catch (err) {
        throw err instanceof ExportError ? err : new ExportError(String(err?.message ?? err), 500);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async disposeAll() {
      clearInterval(sweeper);
      for (const s of [...sessions.values()]) await drop(s);
      for (const f of [...files.values()]) dropFile(f, true);
    },
  };
}
