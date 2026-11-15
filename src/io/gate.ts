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
}
