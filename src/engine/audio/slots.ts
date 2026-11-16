/**
 * Worklet input slots for live audio sources (microphones, phone streams). Pure bookkeeping, shared by every kind of source
 * so they never collide: the lowest free slot is handed out, a source keeps its slot until it is freed.
 */
export class SlotAllocator {
  private owner = new Map<string, number>();

  constructor(readonly max: number) {}

  /** The slot of `id`, allocating the lowest free one. -1 when every slot is taken. */
  alloc(id: string): number {
    const have = this.owner.get(id);
    if (have !== undefined) return have;
    const used = new Set(this.owner.values());
    for (let s = 0; s < this.max; s++) {
      if (!used.has(s)) {
        this.owner.set(id, s);
        return s;
      }
    }
    return -1;
  }

  get(id: string): number | undefined {
    return this.owner.get(id);
  }

  free(id: string): void {
    this.owner.delete(id);
  }

  clear(): void {
    this.owner.clear();
  }

  /** { nodeId: slot } for the runner ('micSlots' message). */
  toRecord(): Record<string, number> {
    return Object.fromEntries(this.owner);
  }

  get size(): number {
    return this.owner.size;
  }
}
