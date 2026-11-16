import { describe, expect, it } from 'vitest';
import { harness } from '../testing';
import type { ParamDef } from '../types';

/**
 * Pipelines (compiled shaders) cannot be destroyed, so a node that bakes a varying number into its WGSL text grows the cache with
 * every slider position. This audit renders every image node once, then again with each number parameter moved: a new shader for
 * a mere number change is a bug (move the number into `uniforms`). The cache itself is also bounded (LRU).
 */
const NUMERIC_BAKED_ALLOWED: Record<string, string> = {
  // node id -> why a number legitimately selects a different shader (empty: none)
};

describe('shader cache', () => {
  it('is bounded: distinct shaders beyond the cap evict the oldest and the process keeps working', { timeout: 60_000 }, async () => {
    const t = await harness();
    const gpu = t.gpu;
    const cap = gpu.limits.pipelines;
    const before = gpu.stats().objects.pipelinesCreated;
    for (let i = 0; i < cap + 40; i++) {
      gpu.scoped(() => gpu.pass({ label: 'bounds', size: { width: 4, height: 4 }, wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(${(i / 1000).toFixed(4)}); }` }));
    }
    const st = gpu.stats();
    expect(st.objects.pipelinesCreated - before).toBe(cap + 40);
    expect(st.objects.livePipelines).toBeLessThanOrEqual(cap + 64); // render pipelines capped; compute and blit pipelines have their own small caps
    expect(st.caches.pipelineEvictions).toBeGreaterThanOrEqual(40);
    // the oldest was evicted: using it again compiles again, and still renders correctly
    const out = gpu.pass({ label: 'bounds', size: { width: 4, height: 4 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0000); }' });
    const px = await gpu.read(out, false);
    expect(px[0]).toBe(0);
    gpu.retain(out.texture);
    gpu.release(out.texture);
  });

  it('no node compiles a new shader because a number parameter changed', async () => {
    const t = await harness();
    const offenders: string[] = [];
    const measured = new Set<string>();
    for (const def of t.registry.list()) {
      if (!def.render || !Object.values(def.outputs as Record<string, { type: string }>).some((o) => o.type === 'image' || o.type === 'mask')) continue;
      const inputs: Record<string, never> = {};
      for (const [name, idef] of Object.entries(def.inputs as Record<string, { type: string; multi?: boolean }>)) {
        if (idef.type === 'image') (inputs as Record<string, unknown>)[name] = idef.multi ? [t.scene(48, 48)] : t.scene(48, 48);
        else if (idef.type === 'mask') (inputs as Record<string, unknown>)[name] = t.maskFn(48, 48, (x) => x / 48);
      }
      // Several moments of the loop: a code path that only runs inside a time window compiles when it is first reached.
      const run = async (params: Record<string, unknown>) => {
        for (const seconds of [0, 0.7, 1.3, 2.1, 3.3]) {
          try {
            await t.run(def.id, params, inputs, { seconds });
            measured.add(def.id);
          } catch {
            /* nodes that need assets, cameras or devices fail here: nothing to measure */
          }
        }
      };
      await run({});
      for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
        if (p.type !== 'number') continue;
        const hi = 'softMax' in p && p.softMax !== undefined ? p.softMax : p.max;
        const lo = p.min;
        if (hi === undefined || lo === undefined || hi <= lo) continue;
        const pick = (frac: number) => {
          let v = lo + (hi - lo) * frac;
          if (p.integer) v = Math.round(v);
          return v;
        };
        const a1 = pick(0.37);
        const a2 = pick(0.41);
        const a3 = pick(0.73);
        if (a1 === a2 || a2 === a3 || a1 === p.default || a2 === p.default || a3 === p.default) continue;
        // The first move may switch a feature on (a different shader once); further moves of the same feature must not compile again.
        await run({ [key]: a1 });
        const before = t.gpu.stats().objects.pipelinesCreated;
        await run({ [key]: a2 });
        await run({ [key]: a3 });
        const made = t.gpu.stats().objects.pipelinesCreated - before;
        if (made > 0 && !NUMERIC_BAKED_ALLOWED[def.id]) offenders.push(`${def.id}.${key} (${a1}, ${a2}, ${a3}): ${made} new shader(s)`);
      }
    }
    expect(offenders).toEqual([]);
    expect(measured.size).toBeGreaterThan(60); // the audit really ran on a large share of the nodes
  }, 600_000);
});
