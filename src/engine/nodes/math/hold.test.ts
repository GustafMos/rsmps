import { describe, expect, it } from 'vitest';
import { numberAt, numberChain, numberSource } from '../../lib/util-testsource';
import { harness } from '../../testing';

describe('hold', () => {
  it('steps: updates every N frames and holds in between', async () => {
    const t = await harness([numberSource('h-ramp', (f) => f)]);
    const c = numberChain(t, 'h-ramp', 'hold', { every: 4 });
    const got: number[] = [];
    for (let f = 0; f <= 10; f++) got.push(await numberAt(t, c.graph, c.node, f));
    expect(got).toEqual([0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8]);
    const same = numberChain(t, 'h-ramp', 'hold', { every: 1 });
    expect(await numberAt(t, same.graph, same.node, 7)).toBe(7);
  });

  it('steps follow the loop when the project loops', async () => {
    const t = await harness([numberSource('h-ramp', (f) => f)]);
    const c = numberChain(t, 'h-ramp', 'hold', { every: 3 }, { project: { duration: 2, loop: true } });
    expect(await numberAt(t, c.graph, c.node, 20)).toBe(20); // frame 20 starts a new loop: updates
    expect(await numberAt(t, c.graph, c.node, 22)).toBe(0); // the held frame is frame 0 of the loop
  });

  it('trigger: samples the value at the most recent rising edge', async () => {
    const t = await harness([
      numberSource('h-ramp', (f) => f),
      numberSource('h-trig', (f) => (f === 10 || f === 11 || f === 25 ? 1 : 0)),
    ]);
    const c = numberChain(t, 'h-ramp', 'hold', { mode: 'trigger', window: 4 }, { trigger: 'h-trig' });
    expect(await numberAt(t, c.graph, c.node, 5)).toBe(0); // nothing fired yet: held since the start
    expect(await numberAt(t, c.graph, c.node, 10)).toBe(10);
    expect(await numberAt(t, c.graph, c.node, 18)).toBe(10); // 11 is not a new rising edge
    expect(await numberAt(t, c.graph, c.node, 24)).toBe(10);
    expect(await numberAt(t, c.graph, c.node, 25)).toBe(25);
    expect(await numberAt(t, c.graph, c.node, 40)).toBe(25);
  });

  it('trigger mode without a trigger wire passes the value on', async () => {
    const t = await harness([numberSource('h-ramp', (f) => f)]);
    const c = numberChain(t, 'h-ramp', 'hold', { mode: 'trigger' });
    expect(await numberAt(t, c.graph, c.node, 9)).toBe(9);
  });
});

describe('delay-value', () => {
  it('returns the number from earlier, in seconds or frames', async () => {
    const t = await harness([numberSource('d-ramp', (f) => f)]);
    const sec = numberChain(t, 'd-ramp', 'delay-value', { amount: 0.3 });
    expect(await numberAt(t, sec.graph, sec.node, 10)).toBe(7);
    const fr = numberChain(t, 'd-ramp', 'delay-value', { amount: 2, units: 'frames' });
    expect(await numberAt(t, fr.graph, fr.node, 10)).toBe(8);
    expect(await numberAt(t, fr.graph, fr.node, 1)).toBe(0); // before the start: clamps
    const none = numberChain(t, 'd-ramp', 'delay-value', { amount: 0 });
    expect(await numberAt(t, none.graph, none.node, 6)).toBe(6);
  });

  it('wraps around the loop when the project loops', async () => {
    const t = await harness([numberSource('d-ramp', (f) => f)]);
    const c = numberChain(t, 'd-ramp', 'delay-value', { amount: 3, units: 'frames' }, { project: { duration: 2, loop: true } });
    expect(await numberAt(t, c.graph, c.node, 1)).toBe(18);
    const off = numberChain(t, 'd-ramp', 'delay-value', { amount: 3, units: 'frames', loopAware: false }, { project: { duration: 2, loop: true } });
    expect(await numberAt(t, off.graph, off.node, 1)).toBe(0);
  });

  it('a static input comes back unchanged', async () => {
    const t = await harness();
    expect((await t.run('delay-value', { amount: 1 }, { value: 4.25 })).value).toBe(4.25);
  });
});
