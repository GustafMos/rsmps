import type { Engine, EvalRequest, EvalResult } from '../engine/engine';

/**
 * Serialises every `engine.evaluate` made by src/io (player, exporter, one-off evaluations).
 * The engine's temp-texture scopes (`gpu.begin/end`) are a shared stack, so two overlapping
 * evaluations could recycle each other's textures. One at a time, in request order.
 */
export class EvalGate {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private engine: Engine) {}

  evaluate(req: EvalRequest): Promise<EvalResult> {
    const run = this.tail.then(() => this.engine.evaluate(req));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Like evaluate, but a texture result is RETAINED inside the gated step, before any other evaluation can start (a later
   * evaluation evicts and recycles cached results). The caller owns that reference: pass the result to `drop` when done.
   */
  evaluateHeld(req: EvalRequest): Promise<EvalResult> {
    const run = this.tail.then(async () => {
      const res = await this.engine.evaluate(req);
      const v = res.value;
      if (v && typeof v === 'object' && 'texture' in v) this.engine.gpu.retain(v.texture);
      return res;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Give back the reference taken by evaluateHeld. */
  drop(res: EvalResult): void {
    const v = res.value;
    if (v && typeof v === 'object' && 'texture' in v) this.engine.gpu.release(v.texture);
  }

  /** Set the engine's result-cache budget (bytes of texture memory); returns the previous one. */
  setCacheBudget(bytes: number): number {
    const prev = this.engine.cacheBudget;
    this.engine.cacheBudget = bytes;
    return prev;
  }

  /** Run `fn` after every queued evaluation has finished and before any later one starts. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Drop the engine cache at a moment when no evaluation is running. */
  clearEngine(): Promise<void> {
    return this.exclusive(() => this.engine.clear());
  }
}
