/**
 * Where an exported file that the app writes itself goes while it is being made (see src/io/encoders/sink.ts):
 *  - desktop app: straight into the file the user chose in the native Save dialog (chunks at positions through the `/__rsmps/export/file`
 *    endpoints), so a multi-gigabyte HAP export needs memory for one frame;
 *  - browsers with the File System Access API (`showSaveFilePicker`): a writable stream with seeking, same effect;
 *  - everything else: memory, with a pre-flight size estimate and a plain refusal above a safe limit.
 */
import { MemorySink, type ByteSink } from './encoders/sink';
import type { ExportedFile } from './api';
import { baseName, type FfmpegExportClient } from './desktop';
import { MEMORY_LIMIT, tooBigMessage } from './own-export';

/** Above this size the web version asks for a file with the File System Access API when the browser has it. */
export const FILE_PICKER_THRESHOLD = 192 * 1024 * 1024;

export interface OpenedSink {
  sink: ByteSink;
  kind: 'memory' | 'file-system' | 'desktop';
  /** The file the export returns, after the sink was closed. */
  result(): Promise<ExportedFile & { bytes: number }>;
  /** Throw a partial file away. */
  abort(): Promise<void>;
  /** A readable copy of what was written (memory and File System Access sinks), for the sanity check; null = not available. */
  readBack(): Promise<ArrayBuffer | null>;
}

interface WritableLike {
  write(chunk: unknown): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface FileHandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}
export type SaveFilePicker = (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandleLike>;

export interface SinkEnv {
  /** The desktop client when running in the desktop app (null / undefined in the web version). */
  desktop?: FfmpegExportClient | null;
  /** `window.showSaveFilePicker` when the browser has it. */
  picker?: SaveFilePicker | null;
}

export function browserSinkEnv(desktop: FfmpegExportClient | null | undefined): SinkEnv {
  const g = globalThis as unknown as { showSaveFilePicker?: SaveFilePicker };
  return { desktop, picker: typeof g.showSaveFilePicker === 'function' ? g.showSaveFilePicker.bind(globalThis) : null };
}

export interface SinkRequest {
  /** File name with extension. */
  name: string;
  mime: string;
  /** Estimated size of the finished file, bytes. */
  estimate: number;
  signal?: AbortSignal;
}

/** Chunks go to a file the desktop app opened. */
class DesktopSink implements ByteSink {
  readonly seekable = true;
  private pos = 0;
  constructor(private client: FfmpegExportClient, private id: string, private signal?: AbortSignal) {}
  async write(data: Uint8Array): Promise<void> {
    await this.client.fileWrite!(this.id, this.pos, data, this.signal);
    this.pos += data.length;
  }
  async writeAt(data: Uint8Array, position: number): Promise<void> {
    await this.client.fileWrite!(this.id, position, data, this.signal);
  }
  close(): void {
    /* finished by fileFinish in result() */
  }
}

class FsaSink implements ByteSink {
  readonly seekable = true;
  closed = false;
  constructor(private w: WritableLike) {}
  async write(data: Uint8Array): Promise<void> {
    await this.w.write(data as unknown as BufferSource);
  }
  async writeAt(data: Uint8Array, position: number): Promise<void> {
    await this.w.write({ type: 'write', position, data: data as unknown as BufferSource });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.w.close();
  }
  async abort(): Promise<void> {
    if (!this.closed) await this.w.abort().catch(() => undefined);
  }
}

const abortError = () => new DOMException('Save canceled', 'AbortError');

/**
 * Open the best sink for a file of about `req.estimate` bytes. Throws an AbortError when the user closes the Save dialog and a plain
 * Error when the file would not fit in memory and nothing better exists.
 */
export async function openOutputSink(env: SinkEnv, req: SinkRequest): Promise<OpenedSink> {
  const ext = req.name.includes('.') ? req.name.slice(req.name.lastIndexOf('.') + 1) : 'bin';
  const stem = req.name.includes('.') ? req.name.slice(0, req.name.lastIndexOf('.')) : req.name;

  const c = env.desktop;
  if (c?.fileStart && c.fileWrite && c.fileFinish) {
    const r = await c.fileStart({ name: stem, ext }, req.signal);
    if (!r.saved || !r.id) throw abortError();
    const id = r.id;
    const sink = new DesktopSink(c, id, req.signal);
    return {
      sink,
      kind: 'desktop',
      async result() {
        const done = await c.fileFinish!(id);
        return { name: baseName(done.path), blob: new Blob([]), savedPath: done.path, bytes: done.bytes };
      },
      abort: async () => c.fileCancel?.(id),
      readBack: async () => null,
    };
  }

  if (env.picker && req.estimate > FILE_PICKER_THRESHOLD) {
    let handle: FileHandleLike | null = null;
    try {
      handle = await env.picker({ suggestedName: req.name, types: [{ description: ext.toUpperCase(), accept: { [req.mime]: [`.${ext}`] } }] });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw abortError();
      handle = null; // no user gesture any more, blocked, or not allowed: fall back to memory
    }
    if (handle) {
      const sink = new FsaSink(await handle.createWritable());
      const h = handle;
      return {
        sink,
        kind: 'file-system',
        async result() {
          const f = await h.getFile();
          return { name: h.name, blob: new Blob([]), savedPath: h.name, bytes: f.size };
        },
        abort: () => sink.abort(),
        readBack: async () => (await h.getFile()).arrayBuffer(),
      };
    }
  }

  if (req.estimate > MEMORY_LIMIT) throw new Error(tooBigMessage(req.estimate));
  const sink = new MemorySink();
  return {
    sink,
    kind: 'memory',
    async result() {
      return { name: req.name, blob: new Blob(sink.parts() as BlobPart[], { type: req.mime }), bytes: sink.bytes };
    },
    abort: async () => undefined,
    readBack: async () => {
      const b = sink.concat();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}
