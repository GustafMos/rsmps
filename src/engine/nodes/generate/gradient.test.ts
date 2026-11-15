import { expect, it } from 'vitest';
import { harness } from '../../testing';

// one harness per file: creating many exhausts the headless GPU
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());

const proj = { width: 64, height: 64 };

it('linear gradient runs through its stops left to right', async () => {
  const t = await H();
  const out = await t.run('gradient', { kind: 'linear', angle: 0, colors: [[0, 0, 0], [1, 1, 1]] }, {}, { project: proj });
  const px = await t.pixels(out.image as never);
  expect(px.at(1, 32)[0]).toBeLessThan(10);
  expect(px.at(62, 32)[0]).toBeGreaterThan(245);
  expect(Math.abs(px.at(32, 10)[0] - 128)).toBeLessThan(10);
  expect(px.at(32, 10)[3]).toBe(255);
});

it('three stops: the middle pixel has the middle colour', async () => {
  const t = await H();
  const out = await t.run('gradient', { angle: 0, colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, {}, { project: proj });
  const px = await t.pixels(out.image as never);
  const [r, g, b] = px.at(32, 32);
  expect(g).toBeGreaterThan(220);
  expect(r + b).toBeLessThan(60);
});

it('radial is symmetric around the centre; angular and diamond work', async () => {
  const t = await H();
  const radial = await t.pixels((await t.run('gradient', { kind: 'radial', colors: [[1, 1, 1], [0, 0, 0]] }, {}, { project: proj })).image as never);
  expect(radial.at(32, 32)[0]).toBeGreaterThan(240);
  expect(Math.abs(radial.at(10, 32)[0] - radial.at(53, 32)[0])).toBeLessThan(6);
  const ang = await t.pixels((await t.run('gradient', { kind: 'angular', angle: 0, colors: [[0, 0, 0], [1, 1, 1]] }, {}, { project: proj })).image as never);
  expect(ang.at(60, 33)[0]).toBeLessThan(40);
  expect(ang.at(60, 30)[0]).toBeGreaterThan(215);
  const dia = await t.pixels((await t.run('gradient', { kind: 'diamond', colors: [[1, 1, 1], [0, 0, 0]] }, {}, { project: proj })).image as never);
  expect(dia.at(32, 32)[0]).toBeGreaterThan(240);
});

it('scroll and rotate loop exactly and move', async () => {
  const t = await H();
  for (const animate of ['scroll', 'rotate']) {
    for (const kind of ['linear', 'angular', 'radial']) {
      const r = await t.loopCheck('gradient', { animate, kind, cycles: 2, repeat: 'repeat' });
      expect(r.seam, `${animate}/${kind}`).toBeLessThan(0.01);
    }
  }
  const m = await t.loopCheck('gradient', { animate: 'scroll', cycles: 1, repeat: 'mirror' });
  expect(m.seam).toBeLessThan(0.01);
  const s = await t.loopCheck('gradient', { animate: 'scroll', cycles: 1, repeat: 'repeat' });
  expect(s.motion).toBeGreaterThan(0.5);
  const r = await t.loopCheck('gradient', { animate: 'rotate', cycles: 1 });
  expect(r.motion).toBeGreaterThan(0.5);
});
