import { describe, expect, it } from 'vitest';
import { animatedSource, sampleAt, sourceChain } from '../../lib/util-testsource';
import { harness } from '../../testing';

// Source brightness = 0.4 * seconds (clamped at 1): pixel value reveals which source time was shown.
const ramp = animatedSource('test-ramp', (s) => 0.4 * s);
const exp = (s: number) => Math.round(255 * Math.min(1, 0.4 * s));
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('retime', () => {
  it('speeds up, slows down and holds', async () => {
    const t = await harness([ramp]);
    const fast = sourceChain(t, 'test-ramp', 'retime', { speed: 2 });
    near(await sampleAt(t, fast.graph, fast.node, 0.5), exp(1));
    near(await sampleAt(t, fast.graph, fast.node, 1.5), exp(1)); // wrapped: 3 mod 2
    const slow = sourceChain(t, 'test-ramp', 'retime', { speed: 0.5 }, { loop: false }); // with Loop on 0.5 would become 1 (a loop needs a whole number)
    near(await sampleAt(t, slow.graph, slow.node, 1), exp(0.5));
    const hold = sourceChain(t, 'test-ramp', 'retime', { holdFps: 5 }, { loop: false });
    near(await sampleAt(t, hold.graph, hold.node, 0.1), exp(0));
    near(await sampleAt(t, hold.graph, hold.node, 0.3), exp(0.2));
    near(await sampleAt(t, hold.graph, hold.node, 0.5), exp(0.4));
  });

  it('Loop on: a speed that is not a whole number of cycles per loop is rounded, so the footage comes back with the project', async () => {
    const t = await harness([ramp]);
    const slow = sourceChain(t, 'test-ramp', 'retime', { speed: 0.5 }); // loop is on in sourceChain's default project
    near(await sampleAt(t, slow.graph, slow.node, 1), exp(1)); // 0.5 -> 1
    const fast = sourceChain(t, 'test-ramp', 'retime', { speed: 1.7 });
    near(await sampleAt(t, fast.graph, fast.node, 0.5), exp(1)); // 1.7 -> 2: half a loop is 1 s of footage... wrapped
    const pp = sourceChain(t, 'test-ramp', 'retime', { speed: 1, pingPong: true }); // there and back needs an even speed
    near(await sampleAt(t, pp.graph, pp.node, 0.5), exp(1)); // speed 2
    const stop = sourceChain(t, 'test-ramp', 'retime', { holdFps: 3.3 }); // 6.6 held frames per 2 s loop -> 7 per loop = 3.5 fps
    near(await sampleAt(t, stop.graph, stop.node, 0.5), exp(Math.floor(0.5 * 3.5) / 3.5), 2);
  });

  it('plays backwards, ping-pong and can hold the last frame', async () => {
    const t = await harness([ramp]);
    const rev = sourceChain(t, 'test-ramp', 'retime', { reverse: true });
    near(await sampleAt(t, rev.graph, rev.node, 0), exp(1.9));
    near(await sampleAt(t, rev.graph, rev.node, 0.5), exp(1.4));
    const pp = sourceChain(t, 'test-ramp', 'retime', { speed: 2, pingPong: true });
    near(await sampleAt(t, pp.graph, pp.node, 0.5), exp(1));
    near(await sampleAt(t, pp.graph, pp.node, 1.5), exp(1)); // coming back
    near(await sampleAt(t, pp.graph, pp.node, 2), exp(0)); // seam: back at the start
    const once = sourceChain(t, 'test-ramp', 'retime', { speed: 2, repeat: false });
    near(await sampleAt(t, once.graph, once.node, 1.5), exp(2));
  });

  it('is a no-op at defaults', async () => {
    const t = await harness([ramp]);
    const c = sourceChain(t, 'test-ramp', 'retime');
    near(await sampleAt(t, c.graph, c.node, 0.7), exp(0.7));
  });
});

describe('time-offset', () => {
  it('shifts time, wrapping around the loop or clamping', async () => {
    const t = await harness([ramp]);
    const wrap = sourceChain(t, 'test-ramp', 'time-offset', { offset: 0.5 });
    near(await sampleAt(t, wrap.graph, wrap.node, 0.2), exp(0.7));
    near(await sampleAt(t, wrap.graph, wrap.node, 1.8), exp(0.3));
    const back = sourceChain(t, 'test-ramp', 'time-offset', { offset: -0.5 });
    near(await sampleAt(t, back.graph, back.node, 0.2), exp(1.7));
    const flat = sourceChain(t, 'test-ramp', 'time-offset', { offset: -0.5, wrap: false });
    near(await sampleAt(t, flat.graph, flat.node, 0.2), exp(0));
    near(await sampleAt(t, flat.graph, flat.node, 1), exp(0.5));
  });
});

describe('freeze', () => {
  it('holds one frame forever', async () => {
    const t = await harness([ramp]);
    const c = sourceChain(t, 'test-ramp', 'freeze', { at: 1 });
    for (const s of [0, 0.5, 1.9]) near(await sampleAt(t, c.graph, c.node, s), exp(1));
  });
});

describe('echo', () => {
  it('blends earlier frames in, weighted by decay', async () => {
    const t = await harness([ramp]);
    const c = sourceChain(t, 'test-ramp', 'echo', { count: 1, spacing: 0.1, decay: 1 }, { loop: false });
    // average of now (0.8) and 0.1 earlier (0.7)
    near(await sampleAt(t, c.graph, c.node, 0.8), (exp(0.8) + exp(0.7)) / 2, 1.5);
    const weighted = sourceChain(t, 'test-ramp', 'echo', { count: 2, spacing: 0.2, decay: 0.5 }, { loop: false });
    const w = [1, 0.5, 0.25];
    const expected = (w[0] * exp(1) + w[1] * exp(0.8) + w[2] * exp(0.6)) / 1.75;
    near(await sampleAt(t, weighted.graph, weighted.node, 1), expected, 2);
  });

  it('lighten keeps the brightest faded echo and does nothing without echoes', async () => {
    const t = await harness([animatedSource('test-dim', (s) => 0.8 - 0.3 * s)]);
    const c = sourceChain(t, 'test-dim', 'echo', { count: 1, spacing: 0.2, decay: 0.5, style: 'lighten' }, { loop: false });
    // now = 0.8-0.3 = 0.5, earlier = 0.62 * 0.5 = 0.31 -> brightest is now
    near(await sampleAt(t, c.graph, c.node, 1), Math.round(255 * 0.5), 2);
    const none = sourceChain(t, 'test-dim', 'echo', { count: 0 });
    near(await sampleAt(t, none.graph, none.node, 1), Math.round(255 * 0.5), 1);
  });

  it('wraps the trail around the loop when the project loops', async () => {
    const t = await harness([ramp]);
    const looped = sourceChain(t, 'test-ramp', 'echo', { count: 1, spacing: 0.2, decay: 1 }, { loop: true });
    // at t = 0 the previous echo comes from the end of the loop (1.8)
    near(await sampleAt(t, looped.graph, looped.node, 0), (exp(0) + exp(1.8)) / 2, 2);
    const flat = sourceChain(t, 'test-ramp', 'echo', { count: 1, spacing: 0.2, decay: 1 }, { loop: false });
    near(await sampleAt(t, flat.graph, flat.node, 0), exp(0), 1);
  });
});

describe('frame-blend', () => {
  it('averages neighbouring frames (a linear ramp stays put)', async () => {
    const t = await harness([ramp]);
    const c = sourceChain(t, 'test-ramp', 'frame-blend', { radius: 2, shape: 'box' }, { loop: false });
    near(await sampleAt(t, c.graph, c.node, 1), exp(1), 2);
  });

  it('smooths a flickering source and wraps at the loop', async () => {
    const flicker = animatedSource('test-flicker', (s) => (Math.round(s * 10) % 2 ? 0.8 : 0.2));
    const t = await harness([flicker]);
    const c = sourceChain(t, 'test-flicker', 'frame-blend', { radius: 1, shape: 'box' }, { loop: true });
    // frame 5 (odd) = 0.8, neighbours 0.2, 0.2 -> mean 0.4
    near(await sampleAt(t, c.graph, c.node, 0.5), Math.round(255 * 0.4), 2);
    // frame 0: neighbours are frame 19 (odd, 0.8) and frame 1 (0.8): mean (0.2 + 0.8 + 0.8)/3 = 0.6
    near(await sampleAt(t, c.graph, c.node, 0), Math.round(255 * 0.6), 2);
    const none = sourceChain(t, 'test-flicker', 'frame-blend', { radius: 0 });
    near(await sampleAt(t, none.graph, none.node, 0.5), Math.round(255 * 0.8), 1);
  });
});
