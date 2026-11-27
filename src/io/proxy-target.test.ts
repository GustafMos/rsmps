import { describe, expect, it } from 'vitest';
import { ProxyController } from './clock';
import { playbackProxyCap } from './proxy-target';

describe('playbackProxyCap', () => {
  const clip = { width: 1080, height: 1920 };
  it('a phone viewer 412 wide at pixel ratio 3 on a portrait clip: half size, not full', () => {
    // the picture fits a 412 x 460 pane with a margin: about 216 x 384 CSS pixels
    expect(playbackProxyCap({ cssWidth: 216, cssHeight: 384, dpr: 3 }, clip)).toBe(0.5);
  });
  it('the ratio is capped at 2: ratio 3 and ratio 2 give the same level', () => {
    const a = playbackProxyCap({ cssWidth: 380, cssHeight: 676, dpr: 3 }, clip);
    const b = playbackProxyCap({ cssWidth: 380, cssHeight: 676, dpr: 2 }, clip);
    expect(a).toBe(b);
    expect(a).toBe(0.75);
  });
  it('never blurrier than the screen: rounds up to the next level', () => {
    expect(playbackProxyCap({ cssWidth: 300, cssHeight: 533, dpr: 1 }, clip)).toBe(0.35); // need 0.278
    expect(playbackProxyCap({ cssWidth: 500, cssHeight: 889, dpr: 1 }, clip)).toBe(0.5); // need 0.463
  });
  it('full size at 100 % zoom or more, and when nothing is known', () => {
    expect(playbackProxyCap({ cssWidth: 1080, cssHeight: 1920, dpr: 1 }, clip)).toBe(1);
    expect(playbackProxyCap({ cssWidth: 2000, cssHeight: 3000, dpr: 1 }, clip)).toBe(1);
    expect(playbackProxyCap(null, clip)).toBe(1);
  });
  it('a tiny picture bottoms out at the smallest level', () => {
    expect(playbackProxyCap({ cssWidth: 20, cssHeight: 30, dpr: 1 }, clip)).toBe(0.25);
  });
});

describe('ProxyController ceiling', () => {
  it('starts at the ceiling and never climbs above it', () => {
    const c = new ProxyController();
    c.setCeiling(0.5);
    expect(c.proxy).toBe(0.5);
    let t = 0;
    for (let i = 0; i < 400; i++) c.report(1, 33, (t += 33)); // very cheap frames: would climb to 1 without a ceiling
    expect(c.proxy).toBe(0.5);
    c.setCeiling(1);
    for (let i = 0; i < 400; i++) c.report(1, 33, (t += 33));
    expect(c.proxy).toBe(1);
  });
  it('reset returns to the ceiling, not to full size', () => {
    const c = new ProxyController();
    c.setCeiling(0.35);
    c.forceLower();
    c.reset();
    expect(c.proxy).toBe(0.35);
  });
});
