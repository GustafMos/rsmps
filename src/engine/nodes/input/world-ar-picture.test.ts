import { describe, expect, it } from 'vitest';
import { addNode, createGraph } from '../../graph';
import { harness } from '../../testing';
import type { Host, ImageValue, LiveSource } from '../../types';

/** World AR Camera: the Picture output (the live camera picture, for materials and effects). */
describe('world-ar: the Picture output', () => {
  const nullHost: Host = { assetInfo: () => null, assetFrame: async () => null };
  const picture = async (host: Host) => {
    const t = await harness([], host);
    const n = addNode(createGraph('w'), t.registry, 'world-ar', { x: 0, y: 0 }, {});
    const v = (await t.evalGraph(n.graph, n.node.id, { port: 'picture' })) as ImageValue;
    return { t, v };
  };

  it('no AR view and no camera: a transparent picture, not an error', async () => {
    const { t, v } = await picture(nullHost);
    expect((await t.pixels(v)).at(1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('a camera that fails to open still gives a transparent picture', async () => {
    const { t, v } = await picture({
      ...nullHost,
      liveFrame: async () => {
        throw new Error('Camera permission was refused.');
      },
    });
    expect((await t.pixels(v)).at(1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('no AR view: the back camera through the live path, same size and not mirrored', async () => {
    const base = await harness();
    const seen: LiveSource[] = [];
    const host: Host = {
      ...nullHost,
      arCameraFrame: () => ({ session: false, access: false, frame: null }),
      async liveFrame(source) {
        seen.push(source);
        const img = base.fromFn(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
        return { texture: img.texture, width: 8, height: 4 };
      },
    };
    const { t, v } = await picture(host);
    expect(seen[0]).toMatchObject({ kind: 'camera', deviceId: '', facing: 'environment' });
    expect([v.width, v.height]).toEqual([8, 4]);
    const px = await t.pixels(v);
    expect(px.at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px.at(7, 0)).toEqual([0, 0, 255, 255]);
  });

  it('in an AR view with camera access: the AR frame at its own size, top row on top', async () => {
    const base = await harness();
    const img = base.fromFn(8, 6, (_x, y) => (y < 3 ? [0, 255, 0, 255] : [255, 255, 0, 255]));
    let asked = 0;
    const host: Host = {
      ...nullHost,
      arCameraFrame: () => (asked++, { session: true, access: true, frame: { texture: img.texture, width: 8, height: 6 } }),
      liveFrame: async () => {
        throw new Error('the device camera belongs to the AR view');
      },
    };
    const { t, v } = await picture(host);
    expect(asked).toBe(1);
    expect([v.width, v.height]).toEqual([8, 6]);
    const px = await t.pixels(v);
    expect(px.at(2, 0)).toEqual([0, 255, 0, 255]);
    expect(px.at(2, 5)).toEqual([255, 255, 0, 255]);
  });

  it('in an AR view without camera access, or before the first frame: transparent, and the device camera is left alone', async () => {
    const host = (access: boolean): Host => ({
      ...nullHost,
      arCameraFrame: () => ({ session: true, access, frame: null }),
      liveFrame: async () => {
        throw new Error('must not be asked');
      },
    });
    for (const access of [false, true]) {
      const { t, v } = await picture(host(access));
      expect((await t.pixels(v)).at(1, 1)).toEqual([0, 0, 0, 0]);
    }
  });

  it('is only made when it is asked for: the camera output alone never touches the host', async () => {
    const t = await harness([], {
      ...nullHost,
      arCameraFrame: () => {
        throw new Error('not wanted');
      },
      liveFrame: async () => {
        throw new Error('not wanted');
      },
    });
    const n = addNode(createGraph('w'), t.registry, 'world-ar', { x: 0, y: 0 }, {});
    const cam = await t.evalGraph(n.graph, n.node.id, { port: 'camera' });
    expect(cam).toBeTruthy();
  });
});
