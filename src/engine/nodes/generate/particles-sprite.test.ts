import { expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const proj = { width: 160, height: 160, lengthMode: 'absolute' as const };
const PRESETS = ['dust', 'snow', 'rain', 'sparks', 'bubbles', 'fireflies', 'confetti', 'stars'];

/** Pixels that are clearly part of a particle, as straight RGB. */
function solidPixels(data: Uint8ClampedArray): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) out.push([data[i], data[i + 1], data[i + 2]]);
  return out;
}
const alphaSum = (data: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 3; i < data.length; i += 4) s += data[i];
  return s;
};

it('a wired picture is what every type draws, in the picture\'s own colors', async () => {
  const t = await H();
  const red = t.solid(8, 8, [255, 0, 0, 255]);
  for (const preset of PRESETS) {
    const out = await t.run('particles', { preset, count: 30, particleSize: 14, soft: false }, { sprite: red }, { project: proj, seconds: 1 });
    const px = solidPixels((await t.pixels(out.image as never)).data);
    expect(px.length, preset).toBeGreaterThan(20);
    for (const [r, g, b] of px) {
      expect(r, preset).toBeGreaterThan(240);
      expect(g + b, preset).toBeLessThan(12);
    }
  }
});

it('"Color it" multiplies the picture by the particle colors; off keeps the picture', async () => {
  const t = await H();
  const white = t.solid(8, 8, [255, 255, 255, 255]);
  const params = { preset: 'confetti', count: 40, particleSize: 16, soft: false };
  const plain = solidPixels((await t.pixels((await t.run('particles', params, { sprite: white }, { project: proj, seconds: 1 })).image as never)).data);
  expect(plain.length).toBeGreaterThan(20);
  expect(plain.every(([r, g, b]) => r > 240 && g > 240 && b > 240)).toBe(true);
  const tinted = solidPixels((await t.pixels((await t.run('particles', { ...params, spriteTint: true }, { sprite: white }, { project: proj, seconds: 1 })).image as never)).data);
  expect(tinted.length).toBeGreaterThan(20);
  expect(tinted.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 60).length).toBeGreaterThan(tinted.length * 0.5); // confetti is a rainbow
});

it('the picture\'s transparency is kept: a half-empty picture covers about half as much', async () => {
  const t = await H();
  const full = t.solid(16, 16, [255, 255, 255, 255]);
  const half = t.fromFn(16, 16, (x) => (x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const params = { preset: 'snow', count: 30, particleSize: 20, soft: false, spriteTurn: 'upright' };
  const a = alphaSum((await t.pixels((await t.run('particles', params, { sprite: full }, { project: proj, seconds: 1 })).image as never)).data);
  const b = alphaSum((await t.pixels((await t.run('particles', params, { sprite: half }, { project: proj, seconds: 1 })).image as never)).data);
  expect(b / a).toBeGreaterThan(0.4);
  expect(b / a).toBeLessThan(0.6);
});

it('a wide picture stays wide when upright; "Point where it goes" turns it along the path', async () => {
  const t = await H();
  const wide = t.solid(32, 8, [255, 255, 255, 255]);
  /** Mean length of the opaque runs along rows and along columns. */
  const runs = async (spriteTurn: string, direction: number, preset = 'dust') => {
    const p = await t.pixels((await t.run('particles', { preset, direction, count: 12, particleSize: 24, spread: 0, soft: false, spriteTurn }, { sprite: wide }, { project: proj, seconds: 1 })).image as never);
    const mean = (along: 'x' | 'y') => {
      let total = 0;
      let count = 0;
      for (let a = 0; a < 160; a++) {
        let run = 0;
        for (let b = 0; b <= 160; b++) {
          const on = b < 160 && (along === 'x' ? p.at(b, a) : p.at(a, b))[3] > 128;
          if (on) run++;
          else if (run) {
            total += run;
            count++;
            run = 0;
          }
        }
      }
      return total / Math.max(1, count);
    };
    return { x: mean('x'), y: mean('y') };
  };
  const up = await runs('upright', 0);
  expect(up.x).toBeGreaterThan(up.y * 2); // the 4:1 picture is not squashed into a square
  // Dust turned to travel straight to the right: the picture's top points right, so its long side is now vertical.
  const dir = await runs('direction', 25);
  expect(dir.y).toBeGreaterThan(dir.x * 2);
  // Falling snow: the top points down, the picture is upside down and still wide.
  const fall = await runs('direction', 0, 'snow');
  expect(fall.x).toBeGreaterThan(fall.y * 2);
});

it('a picture far larger than the particles still draws (it is scaled down first) and nothing changes without a picture', async () => {
  const t = await H();
  const big = t.fromFn(512, 512, (x, y) => ((x - 256) ** 2 + (y - 256) ** 2 < 200 * 200 ? [0, 255, 0, 255] : [0, 0, 0, 0]));
  const out = await t.pixels((await t.run('particles', { preset: 'snow', count: 60, particleSize: 6 }, { sprite: big }, { project: proj, seconds: 1 })).image as never);
  let green = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] > 60 && out.data[i + 1] > out.data[i] + 60) green++;
  expect(green).toBeGreaterThan(30);
  const a = Buffer.from((await t.pixels((await t.run('particles', { preset: 'confetti' }, {}, { project: proj, seconds: 0.7 })).image as never)).data);
  const b = Buffer.from((await t.pixels((await t.run('particles', { preset: 'confetti', spriteTurn: 'spin', spriteTint: true }, {}, { project: proj, seconds: 0.7 })).image as never)).data);
  expect(a.equals(b)).toBe(true); // the picture settings do nothing until a picture is wired
});

it('picture particles loop exactly like the type (tumbling confetti, drifting snow, pointing rain)', async () => {
  const t = await H();
  const sprite = t.fromFn(12, 12, (x, y) => (x + y < 14 ? [255, 200, 0, 255] : [0, 0, 0, 0]));
  for (const preset of ['confetti', 'snow', 'rain']) {
    const r = await t.loopCheck('particles', { preset, count: 40, particleSize: 12 }, { sprite }, { frames: 16, size: 96 });
    expect(r.motion, `${preset} ${r.text}`).toBeGreaterThan(0);
    expect(r.seam, `${preset} ${r.text}`).toBeLessThanOrEqual(LOOP_SEAM_OK);
  }
});
