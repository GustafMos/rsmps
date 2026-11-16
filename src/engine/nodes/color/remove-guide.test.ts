import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const NPB: [number, number, number] = [130, 200, 240];

/** a scan of a blue guide picture (rectangle) with a pencil line drawn across it and a pencil stroke on bare paper */
const blueScan = (x: number, y: number): [number, number, number, number] => {
  const inGuide = x > 20 && x < 70 && y > 20 && y < 60;
  let c: [number, number, number] = inGuide ? [...NPB] : [250, 250, 250];
  if (Math.abs(y - 40) < 2 && x > 10 && x < 80) c = [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25]; // pencil over guide
  if (Math.abs(x - 90) < 2 && y > 10 && y < 70) c = [40, 40, 40]; // pencil on paper
  return [c[0], c[1], c[2], 255];
};

describe('remove-guide', () => {
  it('blue guide goes by colour and graphite stays, over the guide and on bare paper', async () => {
    const t = await harness();
    const src = t.fromFn(100, 80, blueScan);
    const px = await t.pixels((await t.run('remove-guide', { guide: 'blue' }, { image: src })).image as never);
    expect(px.at(30, 30)[0]).toBeGreaterThan(245);
    expect(px.at(60, 55)[2]).toBeGreaterThan(245);
    expect(px.at(40, 40)[0]).toBeLessThan(110);
    expect(px.at(90, 30)[0]).toBeLessThan(110);
  });

  it('ink output makes the removed guide transparent', async () => {
    const t = await harness();
    const src = t.fromFn(100, 80, blueScan);
    const px = await t.pixels((await t.run('remove-guide', { guide: 'blue', output: 'ink' }, { image: src })).image as never);
    expect(px.at(30, 30)[3]).toBe(0);
    expect(px.at(5, 5)[3]).toBe(0);
    expect(px.at(90, 30)[3]).toBeGreaterThan(200);
  });

  it('faint guide without the original: a threshold above the printed strength removes it', async () => {
    const t = await harness();
    // faint guide grey 215 (about 16% darkness, i.e. a 20% printed picture) and a dark stroke
    const src = t.fromFn(100, 80, (x, y) => (Math.abs(y - 40) < 2 ? [50, 50, 50, 255] : x > 20 && x < 70 ? [215, 215, 215, 255] : [250, 250, 250, 255]));
    const px = await t.pixels((await t.run('remove-guide', { guide: 'faint', strength: 0.2 }, { image: src })).image as never);
    expect(px.at(30, 20)[0]).toBeGreaterThan(245);
    expect(px.at(30, 40)[0]).toBeLessThan(110);
  });

  it('faint guide with the original wired in is divided out exactly, keeping even light pencil over the guide', async () => {
    const t = await harness();
    const picture = (x: number): [number, number, number, number] => (x < 50 ? [40, 90, 200, 255] : [200, 160, 60, 255]);
    const orig = t.fromFn(100, 80, (x) => picture(x));
    const k = 0.5;
    // scan = guide (picture at 50%) x drawing; a light-grey pencil stroke (value 0.7) across the middle rows
    const src = t.fromFn(100, 80, (x, y) => {
      const p = picture(x);
      const g = [0, 1, 2].map((i) => 255 - (255 - p[i]) * k);
      const d = Math.abs(y - 40) < 2 ? 0.7 : 1;
      return [g[0] * d, g[1] * d, g[2] * d, 255];
    });
    const px = await t.pixels((await t.run('remove-guide', { guide: 'faint', strength: k }, { image: src, original: orig })).image as never);
    expect(Math.min(...px.at(20, 10).slice(0, 3))).toBeGreaterThan(240); // guide gone
    expect(Math.min(...px.at(75, 70).slice(0, 3))).toBeGreaterThan(240);
    expect(px.at(20, 40)[0]).toBeLessThan(215); // the faint pencil survived
    expect(px.at(20, 40)[0]).toBeGreaterThan(120);
  });
});
