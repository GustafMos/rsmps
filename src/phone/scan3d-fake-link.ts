/** Test support: a small deterministic random source and a one-way pipe that loses, repeats and reorders messages (used by the 3D scan link tests). */

/** A small deterministic random source (so a failing run can be repeated). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WireOpts {
  loss: number;
  dup: number;
  jitter: number;
}

/** A one-way pipe that can lose, repeat and reorder what it carries. */
export class Wire {
  private q: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  constructor(private r: () => number, public o: WireOpts) {}
  push(now: number, fn: () => void): void {
    if (this.r() < this.o.loss) return;
    const copies = this.r() < this.o.dup ? 2 : 1;
    for (let i = 0; i < copies; i++) this.q.push({ at: now + 1 + Math.floor(this.r() * this.o.jitter), seq: this.seq++, fn });
  }
  step(now: number): void {
    const due = this.q.filter((m) => m.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.q = this.q.filter((m) => m.at > now);
    for (const m of due) m.fn();
  }
  clear(): void {
    this.q = [];
  }
  get pending(): number {
    return this.q.length;
  }
}
