/** A `ByteSink` over a file on disk (positioned writes), so a big export streams to the file instead of living in memory. */
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ByteSink } from '../io/encoders/sink';

export class NodeFileSink implements ByteSink {
  readonly seekable = true;
  private fd: number | null = null;
  private pos = 0;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }

  private put(data: Uint8Array, at: number): void {
    if (this.fd === null) throw new Error('The file is closed.');
    let done = 0;
    while (done < data.length) done += writeSync(this.fd, data, done, data.length - done, at + done);
  }

  write(data: Uint8Array): void {
    this.put(data, this.pos);
    this.pos += data.length;
  }

  writeAt(data: Uint8Array, position: number): void {
    this.put(data, position);
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  /** Close and delete the partial file. */
  abort(): void {
    this.close();
    rmSync(this.path, { force: true });
  }
}
