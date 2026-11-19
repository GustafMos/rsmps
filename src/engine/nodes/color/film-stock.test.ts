import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { FILM_STOCKS, layerResponse } from './film-stock.node';

it('every stock keeps middle grey at middle grey, rises steadily and rolls off toward white', () => {
  for (const st of Object.values(FILM_STOCKS)) {
    for (const g of st.g) {
      expect(layerResponse(1, g, st.lat)).toBeCloseTo(0.18, 5);
      let prev = -1;
      for (let stops = -8; stops <= 6; stops += 0.5) {
        const v = layerResponse(Math.pow(2, stops), g, st.lat);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
      expect(layerResponse(1e-4, g, st.lat)).toBeLessThan(0.001);
      expect(layerResponse(1e4, g, st.lat)).toBe(1);
    }
  }
});

it('film stock: grey stays near grey, slide film is harder than negative, black-and-white has no colour, strength 0 is off', async () => {
  const t = await harness();
  const src = t.fromFn(4, 1, (x) => [[119, 119, 119, 255], [200, 60, 50, 255], [40, 40, 40, 255], [235, 235, 235, 255]][x] as [number, number, number, number]);
  const neg = await t.pixels((await t.run('film-stock', { stock: 'daylight250' }, { image: src })).image as never);
  const slide = await t.pixels((await t.run('film-stock', { stock: 'slideVivid' }, { image: src })).image as never);
  const bw = await t.pixels((await t.run('film-stock', { stock: 'bw400' }, { image: src })).image as never);
  expect(Math.abs(neg.at(0, 0)[1] - 119)).toBeLessThan(8);
  expect(slide.at(2, 0)[1]).toBeLessThan(neg.at(2, 0)[1]); // deeper shadows
  expect(slide.at(3, 0)[1]).toBeGreaterThan(neg.at(3, 0)[1]); // brighter whites
  const red = bw.at(1, 0);
  expect(red[0]).toBe(red[1]);
  expect(red[1]).toBe(red[2]);
  expect((await t.run('film-stock', { strength: 0 }, { image: src })).image).toBe(src);
});
