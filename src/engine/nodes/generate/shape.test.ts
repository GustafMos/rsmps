import { expect, it } from 'vitest';
import { harness } from '../../testing';

const proj = { width: 64, height: 64, lengthMode: 'absolute' as const };
const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());

async function draw(params: Record<string, unknown>) {
  const t = await H();
  const out = await t.run('shape', { fill: RED, ...params }, {}, { project: proj });
  return t.pixels(out.image as never);
}

it('every shape fills its centre, leaves the corner transparent', async () => {
  for (const kind of ['rectangle', 'ellipse', 'polygon', 'star', 'ring']) {
    const px = await draw({ kind, width: 0.6, height: 0.6, thickness: 6, sides: 6, sharpness: 0.3 });
    if (kind !== 'ring' && kind !== 'star') expect(px.at(32, 32), kind).toEqual([255, 0, 0, 255]);
    if (kind === 'star') expect(px.at(32, 34)[3], kind).toBe(255);
    if (kind === 'ring') {
      expect(px.at(32, 32)[3], kind).toBe(0);
      expect(px.at(32, 14)[3], kind).toBe(255);
    }
    expect(px.at(0, 0)[3], kind).toBe(0);
  }
});

it('rectangle size and rounded corners', async () => {
  const px = await draw({ kind: 'rectangle', width: 0.5, height: 0.25, cornerRadius: 0 });
  expect(px.at(20, 28)[3]).toBe(255); // inside 16..48 x 24..40
  expect(px.at(20, 20)[3]).toBe(0);
  expect(px.at(10, 32)[3]).toBe(0);
  const round = await draw({ kind: 'rectangle', width: 0.5, height: 0.5, cornerRadius: 12 });
  expect(round.at(16, 16)[3]).toBe(0); // corner pixel cut
  expect(round.at(32, 16)[3]).toBe(255);
});

it('ellipse is a circle for equal width and height', async () => {
  const px = await draw({ kind: 'ellipse', width: 0.5, height: 0.5 });
  expect(px.at(32, 17)[3]).toBe(255);
  expect(px.at(32, 14)[3]).toBe(0);
  expect(px.at(17, 32)[3]).toBe(255);
  expect(px.at(22, 22)[3]).toBe(255);
  expect(px.at(17, 17)[3]).toBe(0); // outside the circle on the diagonal
});

it('polygon: a triangle points up; rotation moves it', async () => {
  const up = await draw({ kind: 'polygon', sides: 3, width: 0.8, height: 0.8 });
  expect(up.at(32, 14)[3]).toBeGreaterThan(200); // near the apex, centred
  expect(up.at(14, 14)[3]).toBe(0);
  expect(up.at(14, 44)[3]).toBeGreaterThan(200); // base corner
  const flipped = await draw({ kind: 'polygon', sides: 3, width: 0.8, height: 0.8, rotation: 180 });
  expect(flipped.at(14, 24)[3]).toBeGreaterThan(200);
  expect(flipped.at(32, 50)[3]).toBeGreaterThan(200);
});

it('line is a thick capsule along the rotation axis', async () => {
  const px = await draw({ kind: 'line', width: 0.8, thickness: 8 });
  expect(px.at(32, 32)[3]).toBe(255);
  expect(px.at(10, 32)[3]).toBe(255);
  expect(px.at(32, 40)[3]).toBe(0);
  const diag = await draw({ kind: 'line', width: 0.8, thickness: 8, rotation: 90 });
  expect(diag.at(32, 10)[3]).toBe(255);
  expect(diag.at(10, 32)[3]).toBe(0);
});

it('stroke is centred on the edge; soft edge feathers', async () => {
  const t = await H();
  const out = await t.run('shape', { kind: 'rectangle', width: 0.5, height: 0.5, cornerRadius: 0, fill: RED, stroke: BLUE, strokeWidth: 6 }, {}, { project: proj });
  const px = await t.pixels(out.image as never);
  expect(px.at(32, 32)).toEqual([255, 0, 0, 255]);
  expect(px.at(16, 32)).toEqual([0, 0, 255, 255]); // on the edge (x = 16)
  expect(px.at(14, 32)).toEqual([0, 0, 255, 255]); // outside half of the stroke
  expect(px.at(10, 32)[3]).toBe(0);
  const soft = await draw({ kind: 'ellipse', width: 0.6, height: 0.6, soft: 10 });
  expect(soft.at(32, 32)[3]).toBe(255);
  const edge = soft.at(32, 13)[3];
  expect(edge).toBeGreaterThan(20);
  expect(edge).toBeLessThan(235);
});

it('alpha fill stays premultiplied-correct', async () => {
  const px = await draw({ kind: 'rectangle', fill: [1, 1, 1, 0.5] });
  const [r, , , a] = px.at(32, 32);
  expect(Math.abs(a - 128)).toBeLessThan(3);
  expect(r).toBeGreaterThan(250);
});

it('lengths scale with unit', async () => {
  const t = await H();
  const p = { kind: 'rectangle', width: 0.5, height: 0.5, cornerRadius: 10, fill: RED, stroke: BLUE, strokeWidth: 4 };
  const a = await t.run('shape', p, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
  const b = await t.run('shape', p, { size: t.solid(128, 128, [0, 0, 0, 255], 2) });
  expect(await t.diff(a.image as never, (await t.run('shape', p, { size: t.solid(64, 64, [0, 0, 0, 255], 1) })).image as never)).toBe(0);
  const pa = await t.pixels(a.image as never);
  const pb = await t.pixels(b.image as never);
  expect(pb.at(33, 33)).toEqual(pa.at(16, 16));
  expect(pb.at(64, 64)).toEqual(pa.at(32, 32));
  expect(Math.abs(pb.at(32, 70)[2] - pa.at(16, 35)[2])).toBeLessThan(30);
});
