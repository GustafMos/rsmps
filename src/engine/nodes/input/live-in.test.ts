import { expect, it } from 'vitest';
import type { Host, LiveSource } from '../../types';
import { harness } from '../../testing';

const nullHost: Host = { assetInfo: () => null, assetFrame: async () => null };

function liveHost(t: { solid: (w: number, h: number, c: [number, number, number, number]) => { texture: GPUTexture; width: number; height: number } }, seen: LiveSource[]): Host {
  return {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = t.solid(8, 4, [255, 0, 0, 255]);
      return { texture: img.texture, width: img.width, height: img.height };
    },
  };
}

it('camera-in asks the host for the chosen device and mirrors horizontally', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const t = await harness([], liveHost(base, seen));
  // Left half red, right half blue source, mirrored: left becomes blue.
  const host: Host = {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = t.fromFn(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t2 = await harness([], host);
  const out = await t2.run('camera-in', { device: 'cam1', resolution: '1280x720', mirror: true });
  const px = await t2.pixels(out.image as never);
  expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(px.at(7, 0)).toEqual([255, 0, 0, 255]);
  expect(seen[0]).toMatchObject({ kind: 'camera', deviceId: 'cam1', width: 1280, height: 720 });
  const off = await t2.run('camera-in', { mirror: false });
  const p2 = await t2.pixels(off.image as never);
  expect(p2.at(0, 0)).toEqual([255, 0, 0, 255]);
});

it('camera-in and url-in explain themselves when the host has no live support', async () => {
  const t = await harness();
  await expect(t.run('camera-in', {})).rejects.toThrow(/not available/);
  await expect(t.run('url-in', { url: 'http://x/y.jpg' })).rejects.toThrow(/not available/);
  await expect(t.run('url-in', { url: '' })).rejects.toThrow(/address/);
});

it('url-in passes address, type and refresh to the host and keeps the stream size', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const t = await harness([], liveHost(base, seen));
  const out = await t.run('url-in', { url: 'http://cam/shot.jpg', kind: 'image', refresh: 5 });
  expect((out.image as { width: number }).width).toBe(8);
  expect(seen[0]).toMatchObject({ kind: 'url', url: 'http://cam/shot.jpg', mode: 'image', refresh: 5 });
});

it('phone-camera rotates on the GPU and asks the host for the phone session', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const host: Host = {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = base.fromFn(4, 2, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 255]));
      return { texture: img.texture, width: 4, height: 2 };
    },
  };
  const t = await harness([], host);
  await expect(t.run('phone-camera', {})).rejects.toThrow(/Not linked/);
  const out = await t.run('phone-camera', { session: 'tok', rotate: '90' });
  const im = out.image as { width: number; height: number };
  expect([im.width, im.height]).toEqual([2, 4]); // 90 degrees swaps the sides
  const px = await t.pixels(out.image as never);
  expect(px.at(1, 0)).toEqual([255, 0, 0, 255]); // the red left column ends up on the top row, right side
  expect(seen[0]).toMatchObject({ kind: 'phone', session: 'tok' });
  const plain = await t.run('phone-camera', { session: 'tok', rotate: 'auto' });
  expect((plain.image as { width: number }).width).toBe(4);
});

it('camera-in gives a transparent picture of the canvas size while the AR view owns the camera, and works as before after', async () => {
  const base = await harness();
  let blocked = true;
  let asked = 0;
  const host: Host = {
    ...nullHost,
    liveBlocked: (s) => blocked && s.kind === 'camera',
    async liveFrame() {
      asked++;
      const img = base.solid(8, 4, [255, 0, 0, 255]);
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t = await harness([], host);
  const out = await t.run('camera-in', { mirror: false });
  const img = out.image as { width: number; height: number };
  expect(asked).toBe(0);
  const px = await t.pixels(out.image as never);
  expect(px.at(Math.floor(img.width / 2), Math.floor(img.height / 2))).toEqual([0, 0, 0, 0]);
  blocked = false;
  const back = await t.run('camera-in', { mirror: false });
  expect(asked).toBe(1);
  expect((await t.pixels(back.image as never)).at(0, 0)).toEqual([255, 0, 0, 255]);
});

it('a Webcam under a foreground still renders while blocked: the foreground stands over nothing', async () => {
  const base = await harness();
  const host: Host = { ...nullHost, liveBlocked: (s) => s.kind === 'camera', liveFrame: async () => { throw new Error('must not be asked'); } };
  const t = await harness([], host);
  const cam = await t.run('camera-in', {});
  const top = base.solid(4, 4, [0, 255, 0, 255]);
  const out = await t.run('merge', {}, { background: cam.image as never, foreground: top as never });
  const px = await t.pixels(out.image as never);
  const w = (out.image as { width: number }).width;
  const h = (out.image as { height: number }).height;
  expect(px.at(Math.floor(w / 2), Math.floor(h / 2))[1]).toBeGreaterThan(0);
});

it('camera-in without a zoom of its own crops and enlarges about the centre; a camera that zooms itself is not zoomed twice', async () => {
  const base = await harness();
  const band = (x: number): [number, number, number, number] => (x < 4 ? [255, 0, 0, 255] : x < 12 ? [0, 255, 0, 255] : [0, 0, 255, 255]);
  let native = false;
  const host: Host = {
    ...nullHost,
    async liveFrame() {
      const img = base.fromFn(16, 4, (x) => band(x));
      return { texture: img.texture, width: 16, height: 4, nativeZoom: native };
    },
  };
  const t = await harness([], host);
  const plain = await t.pixels((await t.run('camera-in', { mirror: false })).image as never);
  expect(plain.at(1, 1)).toEqual([255, 0, 0, 255]);
  const zoomed = await t.pixels((await t.run('camera-in', { mirror: false, zoom: 2 })).image as never);
  expect(zoomed.at(1, 1)).toEqual([0, 255, 0, 255]); // the centre half fills the picture
  expect(zoomed.at(14, 1)).toEqual([0, 255, 0, 255]);
  const below = await t.pixels((await t.run('camera-in', { mirror: false, zoom: 0.5 })).image as never);
  expect(below.at(1, 1)).toEqual([255, 0, 0, 255]); // never below 1x
  native = true;
  const twice = await t.pixels((await t.run('camera-in', { mirror: false, zoom: 2 })).image as never);
  expect(twice.at(1, 1)).toEqual([255, 0, 0, 255]);
});

it('camera-in without the new params renders as before and asks the camera for nothing', async () => {
  const base = await harness();
  const seen: LiveSource[] = [];
  const host: Host = {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = base.fromFn(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t = await harness([], host);
  const px = await t.pixels((await t.run('camera-in', { device: 'cam1', mirror: true })).image as never);
  expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(px.at(7, 0)).toEqual([255, 0, 0, 255]);
  const c = (seen[0] as { controls?: Record<string, unknown> }).controls ?? {};
  expect(c.frameRate).toBeUndefined();
  expect(c.zoom).toBe(1);
  expect(c.exposureComp).toBe(0);
});

it('camera-in turns Frame rate into the rate to ask for, and Match project into the project rate', async () => {
  const base = await harness();
  const seen: LiveSource[] = [];
  const host: Host = {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = base.solid(8, 4, [255, 0, 0, 255]);
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t = await harness([], host);
  await t.run('camera-in', { frameRate: '60' });
  await t.run('camera-in', { frameRate: 'project' });
  await t.run('camera-in', { frameRate: 'auto', cameraExtra: '{"torch":true,"focus":"manual"}', focusDistance: 0.25 });
  const rates = seen.map((s) => (s as { controls: { frameRate?: number } }).controls.frameRate);
  expect(rates[0]).toBe(60);
  expect(rates[1]).toBeGreaterThan(0);
  expect(rates[2]).toBeUndefined();
  expect((seen[2] as unknown as { controls: Record<string, unknown> }).controls).toMatchObject({ torch: true, focus: 'manual', focusDistance: 0.25 });
});

it('camera-in gives a transparent picture before the first visit of a camera that takes turns, and the held picture after', async () => {
  let held = false;
  const base = await harness();
  const host: Host = {
    ...nullHost,
    liveWaiting: () => !held,
    async liveFrame() {
      if (!held) return null;
      const img = base.solid(8, 4, [0, 255, 0, 255]);
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t = await harness([], host);
  const before = await t.run('camera-in', { mirror: false });
  const px0 = await t.pixels(before.image as never);
  expect(px0.at(0, 0)).toEqual([0, 0, 0, 0]);
  held = true;
  const after = await t.run('camera-in', { mirror: false });
  expect((await t.pixels(after.image as never)).at(0, 0)).toEqual([0, 255, 0, 255]);
});

it('camera-in still says it is waiting when no turns are involved', async () => {
  const t = await harness([], { ...nullHost, async liveFrame() { return null; } });
  await expect(t.run('camera-in', {})).rejects.toThrow(/Waiting for the camera/);
});

it('camera-in passes its Take turns settings to the host', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const t = await harness([], liveHost(base, seen));
  await t.run('camera-in', { clash: 'stop', role: 'visited', every: 9, settle: 2 });
  expect(seen[0]).toMatchObject({ turns: { clash: 'stop', role: 'visited', every: 9, settle: 2 } });
  await t.run('camera-in', {});
  expect(seen[1]).toMatchObject({ turns: { clash: 'turns', role: 'auto', every: 5, settle: 3 } });
});
