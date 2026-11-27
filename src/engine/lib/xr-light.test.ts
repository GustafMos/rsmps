import { describe, expect, it } from 'vitest';
import { qAxisAngle } from './motion-math';
import { lightForScene, readLightEstimate, smoothLight, type WorldLight } from './xr-light';
import { buildWorldTake, sampleWorldTake, type WorldSample } from './world-take';
import { lightVector } from './gen-3d';

const light = (dir: [number, number, number], extra: Partial<WorldLight> = {}): WorldLight => ({ dir, strength: 1, ambient: 0.3, ambientColor: [1, 1, 1], ...extra });
const UPRIGHT: [number, number, number, number] = [0, 0, 0, 1];

describe('light direction: AR room to the 3D nodes\' azimuth and height', () => {
  it('light straight above: height 90', () => {
    expect(lightForScene(light([0, 1, 0]), UPRIGHT).elevation).toBeCloseTo(90, 5);
  });
  it('light from the left of the phone looking along its start direction: azimuth negative (-90), height 0', () => {
    const l = lightForScene(light([-1, 0, 0]), UPRIGHT);
    expect(l.azimuth).toBeCloseTo(-90, 5);
    expect(l.elevation).toBeCloseTo(0, 5);
    expect(lightForScene(light([1, 0, 0]), UPRIGHT).azimuth).toBeCloseTo(90, 5);
  });
  it('light behind the phone (the side the default camera looks from) is azimuth 0; a light in front of the object is 180', () => {
    expect(lightForScene(light([0, 0, 1]), UPRIGHT).azimuth).toBeCloseTo(0, 5);
    expect(Math.abs(lightForScene(light([0, 0, -1]), UPRIGHT).azimuth)).toBeCloseTo(180, 5);
  });
  it('the angles give back the same direction through the nodes\' own light vector (flip z)', () => {
    const d: [number, number, number] = [0.3, 0.7, -0.2];
    const n = Math.hypot(...d);
    const l = lightForScene(light([d[0] / n, d[1] / n, d[2] / n]), UPRIGHT);
    const v = lightVector({ lightAzimuth: l.azimuth, lightElevation: l.elevation });
    expect(v[0]).toBeCloseTo(d[0] / n, 5);
    expect(v[1]).toBeCloseTo(d[1] / n, 5);
    expect(v[2]).toBeCloseTo(-d[2] / n, 5);
  });
  it('turning the object (its twist) turns the light with it, so the shading follows the object frame', () => {
    // object turned 90 degrees about the vertical: a light at +x of the room is at the object's -z or +z side
    const l = lightForScene(light([1, 0, 0]), qAxisAngle('y', 90));
    expect(Math.abs(Math.abs(l.azimuth) - 0)).toBeLessThan(1e-4 + 180); // defined
    expect(l.elevation).toBeCloseTo(0, 5);
    expect(l.azimuth).not.toBeCloseTo(90, 0);
  });
});

describe('reading the browser\'s estimate', () => {
  const sh = (v: number) => [v, v * 0.5, v * 0.25, ...new Array(24).fill(0)];
  it('direction, strength and the ambient share from the sky average and its colour', () => {
    const l = readLightEstimate({ primaryLightDirection: { x: 0, y: 2, z: 0 }, primaryLightIntensity: { x: 1, y: 1, z: 1 }, sphericalHarmonicsCoefficients: sh(0.5) })!;
    expect(l.dir).toEqual([0, 1, 0]);
    expect(l.strength).toBeCloseTo(1, 5);
    expect(l.ambient).toBeGreaterThan(0.05);
    expect(l.ambient).toBeLessThan(0.9);
    expect(l.ambientColor[0]).toBeCloseTo(1, 5);
    expect(l.ambientColor[2]).toBeCloseTo(0.25, 5);
    // a brighter sky means more of the light is ambient
    const bright = readLightEstimate({ primaryLightDirection: { x: 0, y: 1, z: 0 }, primaryLightIntensity: { x: 1, y: 1, z: 1 }, sphericalHarmonicsCoefficients: sh(2) })!;
    expect(bright.ambient).toBeGreaterThan(l.ambient);
  });
  it('no usable main light: null', () => {
    expect(readLightEstimate(null)).toBeNull();
    expect(readLightEstimate({ primaryLightDirection: null })).toBeNull();
    expect(readLightEstimate({ primaryLightDirection: { x: 0, y: 0, z: 0 } })).toBeNull();
    expect(readLightEstimate({ primaryLightDirection: { x: NaN, y: 1, z: 0 } })).toBeNull();
  });
});

describe('smoothing', () => {
  it('moves part of the way per frame, converges, and holds the last value when the estimate is missing', () => {
    const a = light([0, 1, 0]);
    const b = light([1, 0, 0], { strength: 3 });
    let s: WorldLight | null = null;
    s = smoothLight(s, a, 0);
    expect(s).toEqual(a);
    s = smoothLight(s, b, 0.033)!;
    expect(s.dir[0]).toBeGreaterThan(0);
    expect(s.dir[0]).toBeLessThan(0.3); // one frame is a small step
    expect(Math.hypot(...s.dir)).toBeCloseTo(1, 5);
    for (let i = 0; i < 60; i++) s = smoothLight(s, b, 0.033)!;
    expect(s.dir[0]).toBeGreaterThan(0.99);
    expect(s.strength).toBeCloseTo(3, 1);
    const held = smoothLight(s, null, 0.033);
    expect(held).toBe(s);
    expect(smoothLight(null, null, 0.033)).toBeNull();
  });
});

describe('the take records the light', () => {
  const sample = (i: number, l?: WorldLight): WorldSample => ({ t: i / 30, frame: i, view: { p: [0, 1, 0], q: [0, 0, 0, 1] }, lens: [1.9, 1.07, 0, 0], object: { p: [0, 0, -2], q: [0, 0, 0, 1], scale: 1 }, ...(l ? { light: l } : {}) });
  it('a take without a light has no light tracks and plays back without one (old takes load unchanged)', () => {
    const take = buildWorldTake(Array.from({ length: 10 }, (_, i) => sample(i)), { fps: 30 })!;
    expect(Object.keys(take.tracks).some((k) => /^l[xyzsarglb]$|^lo$|^oh$/.test(k))).toBe(false);
    expect(sampleWorldTake(take, 0.1).light).toBeUndefined();
  });
  it('a light that changes is recorded, played back; none before the first estimate', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i, i < 3 ? undefined : light(i < 10 ? [-1, 0, 0] : [1, 0, 0], { ambient: i < 10 ? 0.2 : 0.6, strength: 2 })));
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(take.tracks.lx).toBeTruthy();
    expect(sampleWorldTake(take, 0).light).toBeUndefined(); // before the first estimate there was no light (live had none either)
    const mid = sampleWorldTake(take, 5 / 30).light!;
    expect(mid.dir[0]).toBeCloseTo(-1, 2);
    expect(mid.ambient).toBeCloseTo(0.2, 2);
    expect(mid.strength).toBeCloseTo(2, 2);
    const late = sampleWorldTake(take, 15 / 30).light!;
    expect(late.dir[0]).toBeCloseTo(1, 2);
    expect(late.ambient).toBeCloseTo(0.6, 2);
  });
  it('the height an object was raised is recorded too', () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({ ...sample(i), object: { p: [0, 0.3, -2] as [number, number, number], q: UPRIGHT, scale: 1, h: 0.3 } }));
    const take = buildWorldTake(samples, { fps: 30 })!;
    expect(sampleWorldTake(take, 0.1).object!.h).toBeCloseTo(0.3, 3);
  });
});
