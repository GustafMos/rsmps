import { it } from 'vitest';
import { harness } from '../../testing';
const proj = { width: 64, height: 64, lengthMode: 'absolute' as const };
for (const kind of ['rectangle', 'ellipse', 'polygon', 'star', 'ring', 'line']) {
  it('k ' + kind, async () => {
    const t = await harness();
    const out = await t.run('shape', { kind, width: 0.6, height: 0.6, thickness: 6, sides: 6, sharpness: 0.3 }, {}, { project: proj });
    const px = await t.pixels(out.image as never);
    console.log(kind, px.at(32, 32), px.at(0, 0));
  });
}
