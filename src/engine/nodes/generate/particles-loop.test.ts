import { expect, it } from 'vitest';
import { harness } from '../../testing';

// Own file: the headless GPU gets unstable after a few dozen renders in one process.
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const PRESETS = ['dust', 'snow', 'rain', 'sparks', 'bubbles', 'fireflies', 'confetti', 'stars'];

it('every preset loops exactly and moves', async () => {
  const t = await H();
  const size = { size: t.solid(64, 64, [0, 0, 0, 255], 1) };
  for (const preset of PRESETS) {
    for (const cycles of [3]) {
      const r = await t.loopCheck('particles', { preset, cycles, count: 150, particleSize: 5 }, size);
      expect(r.seam, `${preset} x${cycles}`).toBeLessThan(0.02);
      expect(r.motion, `${preset} x${cycles}`).toBeGreaterThan(0.02);
    }
  }
});
