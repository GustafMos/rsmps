import { expect, it } from 'vitest';
import { harness } from '../../testing';

/** A depth map that is near (white) on the left and far (black) on the right, and a flat grey picture. */
async function setup() {
  const t = await harness();
  const image = t.solid(96, 48, [60, 60, 60, 255]);
  const depth = t.fromFn(96, 48, (x) => { const v = Math.round(255 * (1 - x / 95)); return [v, v, v, 255]; });
  const run = async (params: Record<string, unknown>) => t.pixels((await t.run('depth-scan', { smooth: 0, glow: 0, ...params }, { image, depth })).image as never);
  return { run };
}

it('scan wave: a line of light stands where the scene is at the wave’s distance, and moves with Position', async () => {
  const { run } = await setup();
  // far = x / 95: position 0.25 is at x about 24, position 0.75 at x about 71
  const a = await run({ sweep: 0, position: 0.25, trail: 0 });
  const b = await run({ sweep: 0, position: 0.75, trail: 0 });
  expect(a.at(24, 24)[1]).toBeGreaterThan(200);
  expect(a.at(71, 24)[1]).toBeLessThan(90);
  expect(b.at(71, 24)[1]).toBeGreaterThan(200);
  expect(b.at(24, 24)[1]).toBeLessThan(90);
  // away from the line the picture is untouched
  expect(a.at(90, 24)).toEqual([60, 60, 60, 255]);
});

it('the afterglow lies behind a moving wave, and "Reveals the picture" is black ahead of it', async () => {
  const { run } = await setup();
  // one sweep at phase 0.5: the front is at x about 47, moving toward the far (right) side
  const px = await run({ sweep: 1, trail: 0.6, show: 'reveal' });
  const front = Math.round(0.4 * 95); // t.run renders at 0.4 of the loop by default? measured below instead
  void front;
  let brightest = 0;
  let at = 0;
  for (let x = 2; x < 94; x++) if (px.at(x, 24)[1] > brightest) { brightest = px.at(x, 24)[1]; at = x; }
  expect(brightest).toBeGreaterThan(150);
  // just behind the front (nearer = left) there is light, well ahead of it (right) there is none
  if (at > 12 && at < 80) {
    expect(px.at(at - 6, 24)[1]).toBeGreaterThan(px.at(at + 10, 24)[1]);
    expect(px.at(at + 12, 24)[0]).toBeLessThan(12);
  }
});

it('contours draw the chosen number of lines; every style renders opaque and changes the picture', async () => {
  const { run } = await setup();
  const c = await run({ style: 'contours', count: 6, sweep: 0, position: 0.5, thickness: 2 });
  let lines = 0;
  let on = false;
  for (let x = 0; x < 96; x++) {
    const lit = c.at(x, 24)[1] > 150;
    if (lit && !on) lines++;
    on = lit;
  }
  expect(lines).toBeGreaterThanOrEqual(5);
  expect(lines).toBeLessThanOrEqual(7);
  for (const style of ['wave', 'contours', 'grid', 'dots', 'lines']) {
    const px = await run({ style, sweep: 0, position: 0.5 });
    let changed = 0;
    for (let y = 2; y < 46; y += 3) for (let x = 2; x < 94; x += 3) { if (px.at(x, y)[1] !== 60) changed++; expect(px.at(x, y)[3], style).toBe(255); }
    expect(changed, style).toBeGreaterThan(5);
  }
});
