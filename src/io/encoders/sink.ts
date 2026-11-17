/**
 * Where big outputs go. A video muxer that writes through a `ByteSink` never holds the file: it appends each sample as it is made and
 * puts the index (`moov`) at the END, so a 4K HAP export (more than a gigabyte) needs memory for one frame only.
 *
 *  - `MemorySink`: collects parts in memory (small files, and the web fallback). Seekable: `writeAt` patches what was written.
 *  - `FileSink`-style sinks live next to their host: File System Access writable (src/io/sinks.ts), the desktop save endpoint
 *    (src/io/sinks.ts) and a Node file (src/cli).
 *
 * A sink that cannot seek (`seekable: false`) can still be used when the final size of the media data is known up front
 * (`declaredPayload` of the muxer, exact for fixed-size frames); otherwise the muxer buffers like before.
 */

export interface ByteSink {
  /** `writeAt` is supported. */
  readonly seekable: boolean;
  /** Append at the current end. */
  write(data: Uint8Array): Promise<void> | void;
  /** Overwrite bytes that were written before (seekable sinks only). */
  writeAt?(data: Uint8Array, position: number): Promise<void> | void;
  /** All data written; the file is complete. */
  close(): Promise<void> | void;
  /** Throw the partial file away. */
  abort?(): Promise<void> | void;
}

/** Keeps everything in memory as blob parts. */
export class MemorySink implements ByteSink {
  readonly seekable = true;
  private chunks: Uint8Array[] = [];
  private starts: number[] = [];
  private size = 0;

  get bytes(): number {
    return this.size;
  }

  write(data: Uint8Array): void {
    this.starts.push(this.size);
    this.chunks.push(data);
    this.size += data.length;
  }

  /** Patches inside already written parts (the muxer only ever patches its own small header part). */
  writeAt(data: Uint8Array, position: number): void {
    let at = 0;
    while (at < data.length) {
      const i = this.starts.findIndex((s, k) => position + at >= s && position + at < s + this.chunks[k].length);
      if (i < 0) throw new Error('MemorySink: position outside the written data.');
      const part = this.chunks[i];
      const off = position + at - this.starts[i];
      const n = Math.min(data.length - at, part.length - off);
      // copy-on-write so a part the caller still holds is never modified behind its back
      const copy = part.slice();
      copy.set(data.subarray(at, at + n), off);
      this.chunks[i] = copy;
      at += n;
    }
  }

  close(): void {
    /* nothing to flush */
  }

  /** The finished file as blob parts. */
  parts(): Uint8Array[] {
    return this.chunks;
  }

  /** The finished file in one buffer (tests, small files). */
  concat(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
