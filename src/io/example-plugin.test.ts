import { expect, it } from 'vitest';
import { harness } from '../engine/testing';
import { collectDefs } from './plugins';

it('the shipped example plugin registers and renders on the real GPU', async () => {
  // @ts-expect-error plain JS file without types
  const mod = (await import('../../public/plugins/example-glitch.js')) as Record<string, unknown>;
  const defs = collectDefs(mod);
  expect(defs.map((d) => d.id)).toEqual(['example/glitch']);
  const t = await harness();
  t.registry.registerModule({ default: defs });
  const src = t.fromFn(64, 64, (x) => [x * 4, 0, 0, 255]);
  const out = await t.run('example/glitch', { amount: 20, bands: 8 }, { image: src });
  const px = await t.pixels(out.image as never);
  const ref = await t.pixels(src);
  let differing = 0;
  for (let y = 0; y < 64; y++) if (px.at(10, y)[0] !== ref.at(10, y)[0]) differing++;
  expect(differing).toBeGreaterThan(0); // some bands moved
  expect(differing).toBeLessThan(64); // not all
});
