import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

const project = { width: 160, height: 120, fps: 12, duration: 2, loop: true };
const plain = { glow: 0, faces: 0, dots: 0, hot: 0, background: [0, 0, 0, 1] };

describe('hypercube', () => {
  it('draws the edges where the maths puts them', async () => {
    const t = await harness();
    // a plain cube seen straight on with no perspective: one square, its sides 0.92 / 2 / sqrt(2) of the height from the middle
    const out = await t.run('hypercube', { ...plain, dimensions: '3', speed: 0, tilt: 0, turn: 0, depth: 0, thickness: 0.03, color: [0, 1, 0, 1], colorBy: 'single' }, {}, { project });
    const px = await t.pixels(out.image as ImageValue);
    const side = Math.round((0.92 / 2 / Math.SQRT2) * 120);
    expect(px.at(80 + side, 60)[1]).toBeGreaterThan(200);
    expect(px.at(80 - side, 60)[1]).toBeGreaterThan(200);
    expect(px.at(80, 60 - side)[1]).toBeGreaterThan(200);
    expect(px.at(80, 60)[1]).toBeLessThan(10);
    expect(px.at(80 + side + 8, 60)[1]).toBeLessThan(10);
    expect(px.at(2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('stays inside the picture at the default size for every motion and dimension', async () => {
    const t = await harness();
    for (const dimensions of ['3', '4', '5', '6']) {
      for (const motion of ['tumble', 'insideOut', 'through', 'chaos']) {
        for (const seconds of [0, 0.5, 1.25]) {
          const px = await t.pixels((await t.run('hypercube', { dimensions, motion, glow: 0, background: [0, 0, 0, 1] }, {}, { project, seconds })).image as ImageValue);
          let edge = 0;
          let inside = 0;
          for (let x = 0; x < px.width; x++) edge = Math.max(edge, px.at(x, 0)[1], px.at(x, px.height - 1)[1]);
          for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) inside = Math.max(inside, px.at(x, y)[1]);
          expect(edge, `${dimensions}D ${motion} at ${seconds}s touches the edge`).toBeLessThan(40);
          expect(inside).toBeGreaterThan(120);
        }
      }
    }
  }, 60000);

  it('a clear background leaves the picture transparent around the shape', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('hypercube', { background: [0, 0, 0, 0] }, {}, { project })).image as ImageValue);
    expect(px.at(2, 2)[3]).toBe(0);
    let most = 0;
    for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) most = Math.max(most, px.at(x, y)[3]);
    expect(most).toBeGreaterThan(200);
  });

  it('colours the higher dimensions differently', async () => {
    const t = await harness();
    // straight on with no perspective every cube of the tesseract lands on the same square, so turn it into the fourth dimension
    const params = { ...plain, dimensions: '4', speed: 0, thickness: 0.02, color: [0, 1, 0, 1], color4: [1, 0, 0, 1] };
    const px = await t.pixels((await t.run('hypercube', params, {}, { project })).image as ImageValue);
    let green = 0;
    let red = 0;
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++) {
        const [r, g] = px.at(x, y);
        if (g > 150 && r < 60) green++;
        if (r > 150 && g < 60) red++;
      }
    expect(green).toBeGreaterThan(50);
    expect(red).toBeGreaterThan(20);
    // three of the four directions are green
    expect(green).toBeGreaterThan(red);
  });

  it('puts a wired picture on the faces of a cube, or behind the lines', async () => {
    const t = await harness();
    const red = t.solid(32, 32, [255, 0, 0, 255]);
    const size = t.solid(160, 120, [0, 0, 0, 255]);
    const still = { ...plain, dimensions: '3', speed: 0, tilt: 0, turn: 0, thickness: 0.004, pictureOpacity: 1 };
    const on = await t.pixels((await t.run('hypercube', { ...still, picture: 'inner' }, { image: red, size }, { project })).image as ImageValue);
    expect(on.at(80, 60)).toEqual([255, 0, 0, 255]);
    expect(on.at(4, 4)).toEqual([0, 0, 0, 255]);
    const behind = await t.pixels((await t.run('hypercube', { ...still, picture: 'behind' }, { image: red, size }, { project })).image as ImageValue);
    expect(behind.at(4, 4)).toEqual([255, 0, 0, 255]);
    // the picture keeps its own left and right on the face that looks at the viewer
    const halves = t.fromFn(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const face = await t.pixels((await t.run('hypercube', { ...still, picture: 'inner', depth: 0 }, { image: halves, size }, { project })).image as ImageValue);
    expect(face.at(65, 60)[0]).toBeGreaterThan(200);
    expect(face.at(95, 60)[2]).toBeGreaterThan(200);
  });

  it('looks the same at twice the resolution', async () => {
    const t = await harness();
    const params = { thickness: 0.03, glowSize: 0.05 };
    const a = await t.pixels((await t.run('hypercube', params, { size: t.solid(64, 48, [0, 0, 0, 255]) }, { project, seconds: 0.5 })).image as ImageValue);
    const b = await t.pixels((await t.run('hypercube', params, { size: t.solid(128, 96, [0, 0, 0, 255]) }, { project, seconds: 0.5 })).image as ImageValue);
    let sum = 0;
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++)
        for (let c = 0; c < 3; c++) {
          let m = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m += b.at(x * 2 + dx, y * 2 + dy)[c];
          sum += Math.abs(a.at(x, y)[c] - m / 4);
        }
    expect(sum / (64 * 48 * 3)).toBeLessThan(4);
  });
});
