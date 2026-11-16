/**
 * System-RAM tier for results that were expensive to compute (see `Engine.setColdStore`). Lossless by contract: the engine serves
 * what comes back as if it had just been rendered. Bounded by a byte budget (the governor's `ramBudget` share); the least
 * recently used pixels go first, and a missing entry is simply recomputed.
 */
import type { ColdStore } from '../engine/types';
import { ByteLru } from './lru';
import { packLossless, unpackBytes, type Packed } from './pixel-codec';

export class RamColdStore implements ColdStore {
  private lru: ByteLru<string, Packed>;
  puts = 0;
  hits = 0;
  misses = 0;
  /** Bytes the entries would take uncompressed (for the compression ratio). */
  private rawBytes = 0;

  constructor(maxBytes: number) {
    this.lru = new ByteLru<string, Packed>(maxBytes, (_k, p) => {
      this.rawBytes -= p.width * p.height * 4;
    });
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  get size(): number {
    return this.lru.size;
  }

  get ratio(): number {
    return this.rawBytes > 0 ? this.lru.bytes / this.rawBytes : 1;
  }

  setMaxBytes(bytes: number): void {
    this.lru.resize(bytes);
  }

  async put(key: string, pixels: { data: Uint8Array; width: number; height: number }): Promise<boolean> {
    const packed = await packLossless(pixels.data, pixels.width, pixels.height);
    if (packed.bytes > this.lru.maxBytes * 0.5) return false; // one result may not take most of the budget
    this.lru.set(key, packed, packed.bytes);
    this.rawBytes += pixels.width * pixels.height * 4;
    this.puts++;
    return true;
  }

  async get(key: string): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    const p = this.lru.get(key);
    if (!p) {
      this.misses++;
      return null;
    }
    this.hits++;
    return { data: await unpackBytes(p), width: p.width, height: p.height };
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  delete(key: string): void {
    this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
  }
}
