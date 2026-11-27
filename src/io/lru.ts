/**
 * Byte-bounded caches. Pure data structures: what "bytes" means (GPU texture memory) and what
 * eviction does (release a texture) is decided by the owner through `onEvict`.
 */

/** Least-recently-used map bounded by a byte budget. Insertion order of a Map is the recency order. */
export class ByteLru<K, V> {
  private map = new Map<K, { value: V; bytes: number }>();
  private total = 0;
  /** Chooses what to evict instead of "least recently used": gets every key (the entry just inserted included). */
  pickVictim: ((keys: K[]) => K | undefined) | null = null;

  constructor(
    public maxBytes: number,
    private onEvict: (key: K, value: V) => void = () => {},
  ) {}

  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.map.size;
  }

  /** Change the budget and evict down to it now. */
  resize(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.trim();
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
  /** Read without changing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V, bytes: number): void {
    this.delete(key);
    this.map.set(key, { value, bytes });
    this.total += bytes;
    this.trim(key);
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.total -= e.bytes;
    this.onEvict(key, e.value);
    return true;
  }

  /** Evict oldest entries until within budget. `keep` is never evicted (the entry just inserted). */
  private trim(keep?: K): void {
    if (this.total <= this.maxBytes) return;
    if (this.pickVictim) {
      while (this.total > this.maxBytes && this.map.size > 0) {
        const key = this.pickVictim([...this.map.keys()]);
        if (key === undefined || !this.delete(key)) break;
      }
      return;
    }
    for (const key of [...this.map.keys()]) {
      if (this.total <= this.maxBytes) break;
      if (key === keep) continue;
      this.delete(key);
    }
  }

  deleteWhere(pred: (key: K, value: V) => boolean): void {
    for (const [key, e] of [...this.map]) if (pred(key, e.value)) this.delete(key);
  }

  clear(): void {
    for (const key of [...this.map.keys()]) this.delete(key);
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

interface TimedEntry<V> {
  group: string;
  start: number;
  end: number;
  value: V;
}

/**
 * Decoded video frames: LRU by bytes, but looked up by time. Each group (asset + size bucket) keeps
 * its frames sorted by start time; `find(group, t)` returns the frame whose [start, end) contains t.
 */
export class TimedFrameStore<V> {
  private lru: ByteLru<string, TimedEntry<V>>;
  private index = new Map<string, number[]>();

  constructor(maxBytes: number, private onEvict: (value: V) => void) {
    this.lru = new ByteLru<string, TimedEntry<V>>(maxBytes, (_k, e) => {
      this.removeFromIndex(e);
      this.onEvict(e.value);
    });
  }

  get bytes(): number {
    return this.lru.bytes;
  }
  get size(): number {
    return this.lru.size;
  }
  set maxBytes(n: number) {
    this.lru.resize(n);
  }

  private static key(group: string, start: number): string {
    return `${group}@${start}`;
  }

  put(group: string, start: number, end: number, bytes: number, value: V): void {
    const key = TimedFrameStore.key(group, start);
    const entry: TimedEntry<V> = { group, start, end, value };
    const had = this.lru.has(key);
    // `set` evicts the previous entry (and removes it from the index) first.
    this.lru.set(key, entry, bytes);
    if (!had || !this.index.get(group)?.includes(start)) {
      const list = this.index.get(group) ?? [];
      const at = lowerBound(list, start);
      if (list[at] !== start) list.splice(at, 0, start);
      this.index.set(group, list);
    }
  }

  find(group: string, t: number): V | undefined {
    const list = this.index.get(group);
    if (!list || list.length === 0) return undefined;
    // Largest start <= t.
    let lo = 0;
    let hi = list.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= t + 1e-9) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return undefined;
    const key = TimedFrameStore.key(group, list[best]);
    const e = this.lru.peek(key);
    if (!e || t >= e.end - 1e-9) return undefined;
    this.lru.get(key);
    return e.value;
  }

  /** Drop every frame whose group starts with `prefix`. */
  dropGroups(prefix: string): void {
    this.lru.deleteWhere((_k, e) => e.group.startsWith(prefix));
  }

  clear(): void {
    this.lru.clear();
    this.index.clear();
  }

  private removeFromIndex(e: TimedEntry<V>): void {
    const list = this.index.get(e.group);
    if (!list) return;
    const at = lowerBound(list, e.start);
    if (list[at] === e.start) list.splice(at, 1);
    if (list.length === 0) this.index.delete(e.group);
  }
}

function lowerBound(list: number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
