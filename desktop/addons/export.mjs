// Streaming video export through FFmpeg for the desktop app. The renderer posts raw RGBA frames (straight alpha); this
// feeds them to the same VideoWriter the CLI uses (src/cli/encode.ts, bundled in: one implementation of the codec
// argument sets). Back-pressure: a frame request is answered only after ffmpeg accepted its bytes.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { CODECS, VideoWriter, parseCodec } from '../../src/cli/encode.ts';
import { setFfmpegBinary } from './shim-ffmpeg.mjs';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_DIM = 16384;

export class ExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const codecList = () => Object.values(CODECS).map((c) => ({ id: c.id, label: c.label, ext: c.ext, alpha: c.alpha, even: c.even, audio: true }));

/**
 * @param {{ tmpRoot: string, binary: () => Promise<string | null>, pickSavePath: (name: string, ext: string) => Promise<string | null> }} cfg
 */
export function createExportService({ tmpRoot, binary, pickSavePath }) {
  mkdirSync(tmpRoot, { recursive: true });
  const sessions = new Map();
  let sweeper = null;

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

    async start(body) {
      const bin = await binary();
      if (!bin) throw new ExportError('FFmpeg is not set up. Install the FFmpeg add-on or locate an existing FFmpeg first.', 409);
      if (sessions.size > 0) throw new ExportError('Another export is already running.', 409);
      const spec = CODECS[parseCodec(String(body?.codec ?? '')) ?? ''];
      if (!spec) throw new ExportError(`Unknown codec "${body?.codec}". Available: ${Object.keys(CODECS).join(', ')}.`);
      const width = Number(body.width), height = Number(body.height), fps = Number(body.fps);
      if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIM)) throw new ExportError('width and height must be whole numbers from 1 to 16384.');
      if (!(fps > 0 && fps <= 240)) throw new ExportError('fps must be between 0 and 240.');
      if (spec.even && (width % 2 || height % 2)) throw new ExportError(`${spec.label} needs an even width and height (got ${width}x${height}).`);
      const audio = body.audio ? { sampleRate: Number(body.audio.sampleRate), channels: Number(body.audio.channels) } : null;
      if (audio && !(audio.sampleRate >= 8000 && audio.sampleRate <= 192000 && (audio.channels === 1 || audio.channels === 2))) throw new ExportError('audio needs sampleRate 8000-192000 and channels 1 or 2.');
      const bitrateMbps = body.bitrateMbps === undefined ? 12 : Number(body.bitrateMbps);
      if (!(bitrateMbps > 0 && bitrateMbps <= 500)) throw new ExportError('bitrateMbps must be between 0 and 500.');
      setFfmpegBinary(bin);
      const dir = mkdtempSync(join(tmpRoot, 'export-'));
      const s = { id: randomBytes(8).toString('hex'), spec, width, height, fps, bitrateMbps, audio, dir, audioFile: null, writer: null, frames: 0, last: Date.now(), chain: Promise.resolve(), name: basename(String(body.name ?? 'rsmps-export')).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'rsmps-export' };
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
          s.writer ??= await VideoWriter.open({ file: join(s.dir, 'out.' + s.spec.ext), width: s.width, height: s.height, fps: s.fps, codec: s.spec, bitrateMbps: s.bitrateMbps, audio: s.audio && s.audioFile ? { file: s.audioFile, ...s.audio } : undefined });
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

    async disposeAll() {
      clearInterval(sweeper);
      for (const s of [...sessions.values()]) await drop(s);
    },
  };
}
