/**
 * The owner's real AR project (trimmed: SDF Scene group, hologram Material, World AR Camera holding a recorded take) through the real
 * engine: with Ground shadow on, the scene played back from the take shows a shadow on the placed surface plane under the spheres,
 * in the right place while the camera moves, and over the camera clip (a plain colour stands in for it) it darkens the picture.
 * The hologram is semi-transparent, so its shadow is half as strong as a solid object's (gen-material.ts `materialShadowFactor`).
 * With a room light in the moment and "Match room light" on, the shadow falls the way the room's light does.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { addNode, connect } from '../../engine/graph';
import { PATH_SEP, updateNodeAtPath } from '../../engine/group';
import { cameraBasis } from '../../engine/lib/gen-camera';
import { lightVector } from '../../engine/lib/gen-3d';
import { spunRotation } from '../../engine/lib/gen-common';
import { sampleWorldTake, type WorldMoment, type WorldTake } from '../../engine/lib/world-take';
import { writePng } from '../../engine/lib/gen-3d-testutil';
import { harness, type Harness } from '../../engine/testing';
import type { CameraValue, GraphDoc, ImageValue, NodeInstance } from '../../engine/types';
import { stampWorldAr, worldArNodeIds } from './engine-source';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sdf-ar-hologram.json', import.meta.url), 'utf8')) as GraphDoc;
const GROUP = 'g_mwyokc0s3s8';
const AR = 'n_mwysivm611d';
const CANVAS = { width: 480, height: 270 };
const FPS = 24;

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

/** The scene with its animation cut (the spheres stand still) and the shadow set. */
function scene(render: Record<string, unknown>, arParams: Record<string, unknown> = {}): GraphDoc {
  let g = structuredClone(fixture);
  g = updateNodeAtPath(g, GROUP, (n) => {
    const data = n.params as unknown as { edges: { from: { node: string } }[] };
    return { ...n, params: { ...n.params, edges: data.edges.filter((e) => e.from.node !== 'n_mwysdf7r2k0' && e.from.node !== 'n_mwysffal5i8') } as never };
  });
  g = updateNodeAtPath(g, `${GROUP}${PATH_SEP}render`, (n) => ({ ...n, params: { ...n.params, ...render } }));
  g = updateNodeAtPath(g, AR, (n) => ({ ...n, params: { ...n.params, ...arParams } }));
  return g;
}

const px = async (img: ImageValue) => h.pixels(img);

/** Pixel of a scene point under a perspective camera of this canvas (null when behind it). */
function toPixel(cam: CameraValue, p: [number, number, number]): [number, number] | null {
  const b = cameraBasis(cam);
  const rel = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const d = (a: readonly number[]) => rel[0] * a[0] + rel[1] * a[1] + rel[2] * a[2];
  const z = d(b.forward);
  if (z <= 1e-6) return null;
  const short = Math.min(CANVAS.width, CANVAS.height);
  const fovTan = Math.tan((cam.fov * Math.PI) / 360);
  const ux = d(b.right) / z / fovTan + cam.shift[0] * 2;
  const uy = d(b.up) / z / fovTan + cam.shift[1] * 2;
  return [CANVAS.width / 2 + (ux * short) / 2, CANVAS.height / 2 - (uy * short) / 2];
}

const SPHERES: [number, number, number][] = [
  [-0.435, 0.025, 0.288],
  [0.149, 0.262, -0.371],
];
const worldCentres = (): [number, number, number][] => {
  // the scene is turned by the group's own Tilt / Turn / Roll (exposed on the group node)
  const gp = fixture.nodes.find((n) => n.id === GROUP)!.params as Record<string, number>;
  const R = spunRotation({ rotX: gp.rotX, rotY: gp.rotY, rotZ: gp.rotZ, spinX: 0, spinY: 0, spinZ: 0 }, 0);
  return SPHERES.map((c) => [R[0] * c[0] + R[1] * c[1] + R[2] * c[2], R[3] * c[0] + R[4] * c[1] + R[5] * c[2], R[6] * c[0] + R[7] * c[1] + R[8] * c[2]]);
};

describe('the owner\'s AR project with Ground shadow', () => {
  const take = (fixture.nodes.find((n) => n.id === AR)!.params as { take: WorldTake }).take;

  it('the World AR Camera carries the surface: ground = -lift under the object (raised objects: further down)', async () => {
    const g = scene({});
    const cam = (await h.engine.evaluate({ graph: g, node: AR, port: 'camera', seconds: 1, canvas: CANVAS, proxy: 1, quality: 'preview' })).value as CameraValue;
    expect(cam.ground).toBeCloseTo(-1, 5); // Lift 1, nothing raised
    // an object raised 30 cm above the floor (Object size 0.5 m: 1 scene unit = 0.25 m): its floor is 1.2 scene units further down
    const m = sampleWorldTake(take, 1);
    const moment: WorldMoment = { ...m, object: { ...m.object!, h: 0.3 } };
    const raised = (await h.engine.evaluate({ graph: stampWorldAr(g, worldArNodeIds(g), moment), node: AR, port: 'camera', canvas: CANVAS, proxy: 1, quality: 'preview' })).value as CameraValue;
    expect(raised.ground).toBeCloseTo(-1 - 0.3 / (m.object!.scale * 0.25), 4);
  }, 120000);

  it('with the toggle on, the shadow is on the placed surface under both spheres, at several moments of the take; off: none', async () => {
    const on = scene({ groundShadow: true, groundStrength: 1, groundSoftness: 0.2 });
    const off = scene({ groundShadow: false });
    const C = worldCentres();
    const L = lightVector({ lightAzimuth: -35, lightElevation: 40 });
    let checked = 0;
    for (const t of [0.5, 2, 3.5]) {
      const res = (c: GraphDoc, node: string, port: string) => h.engine.evaluate({ graph: c, node, port, seconds: t, canvas: CANVAS, proxy: 1, quality: 'preview' });
      const cam = (await res(on, AR, 'camera')).value as CameraValue;
      const img = await px((await res(on, GROUP, 'image')).value as ImageValue);
      const none = await px((await res(off, GROUP, 'image')).value as ImageValue);
      let shadowPixels = 0;
      let nonePixels = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] > 20 && img.data[i - 3] + img.data[i - 2] + img.data[i - 1] === 0) shadowPixels++;
        if (none.data[i] > 20 && none.data[i - 3] + none.data[i - 2] + none.data[i - 1] === 0) nonePixels++;
      }
      expect(nonePixels, `t=${t}: no shadow without the toggle`).toBe(0);
      for (const c of C) {
        // where the shadow of the sphere's centre falls on the surface plane
        const k = (c[1] - cam.ground!) / L[1];
        const s: [number, number, number] = [c[0] - L[0] * k, cam.ground!, c[2] - L[2] * k];
        const p = toPixel(cam, s);
        if (!p || p[0] < 4 || p[1] < 4 || p[0] > CANVAS.width - 4 || p[1] > CANVAS.height - 4) continue;
        const a = img.data[(Math.round(p[1]) * CANVAS.width + Math.round(p[0])) * 4 + 3];
        const rgb = img.data[(Math.round(p[1]) * CANVAS.width + Math.round(p[0])) * 4] + img.data[(Math.round(p[1]) * CANVAS.width + Math.round(p[0])) * 4 + 1];
        // the pixel is either the sphere itself (it covers its own shadow) or a transparent-black shadow: never empty. The hologram is
        // semi-transparent: its shadow is about half dark (strength 1 x 0.5), not black
        if (rgb === 0) {
          expect(a, `t=${t} sphere at ${c}: shadow alpha at ${p}`).toBeGreaterThan(40);
          expect(a).toBeLessThan(160);
        } else expect(a).toBeGreaterThan(0);
        checked++;
      }
      expect(shadowPixels, `t=${t}: some transparent-black shadow pixels`).toBeGreaterThan(200);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 180000);

  it('over the camera clip (stand-in colour) the shadow darkens the picture only under the objects\' shadow', async () => {
    let g = scene({ groundShadow: true, groundStrength: 1, groundSoftness: 0.2 });
    const bg = addNode(g, h.registry, 'solid', { x: 0, y: 300 }, { color: [0.8, 0.7, 0.6, 1] });
    const merge = addNode(bg.graph, h.registry, 'merge', { x: 400, y: 0 });
    g = connect(merge.graph, h.registry, { node: bg.node.id, port: 'image' }, { node: merge.node.id, port: 'background' });
    g = connect(g, h.registry, { node: GROUP, port: 'image' }, { node: merge.node.id, port: 'foreground' });
    const out = await px((await h.engine.evaluate({ graph: g, node: merge.node.id, seconds: 2, canvas: CANVAS, proxy: 1, quality: 'preview' })).value as ImageValue);
    writePng('arshadow-owner-project.png', out, false);
    const want = [204, 178, 153];
    let darker = 0;
    let same = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      const d = want[0] - out.data[i];
      if (d > 20 && Math.abs(out.data[i] / want[0] - out.data[i + 1] / want[1]) < 0.05) darker++; // darker, same hue: a shadow, not an object
      if (Math.abs(d) <= 2) same++;
    }
    expect(darker).toBeGreaterThan(200);
    expect(same).toBeGreaterThan(out.data.length / 4 / 2); // most of the picture is untouched (no horizon, no floor tint)
  }, 120000);

  it('a room light in the moment moves the shadow; "Match room light" off keeps the scene\'s own light', async () => {
    const m = sampleWorldTake(take, 2);
    const lit = (dir: [number, number, number]): WorldMoment => ({ ...m, light: { dir, strength: 1, ambient: 0.4, ambientColor: [1, 0.9, 0.8] } });
    const shadowCentre = async (g: GraphDoc, moment: WorldMoment): Promise<number> => {
      const stamped = stampWorldAr(g, worldArNodeIds(g), moment);
      const img = await px((await h.engine.evaluate({ graph: stamped, node: GROUP, canvas: CANVAS, proxy: 1, quality: 'preview' })).value as ImageValue);
      let sx = 0;
      let n = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3] > 20 && img.data[i] + img.data[i + 1] + img.data[i + 2] === 0) {
          sx += x;
          n++;
        }
      }
      return n ? sx / n : NaN;
    };
    const on = scene({ groundShadow: true, groundStrength: 1 });
    const camOut = (await h.engine.evaluate({ graph: stampWorldAr(on, worldArNodeIds(on), lit([0, 1, 0])), node: AR, port: 'camera', canvas: CANVAS, proxy: 1, quality: 'preview' })).value as CameraValue;
    expect(camOut.light!.elevation).toBeGreaterThan(88); // light straight above the placed object (the placed surface is a hair off level)
    const left = await shadowCentre(on, lit([-0.8, 0.6, 0]));
    const right = await shadowCentre(on, lit([0.8, 0.6, 0]));
    expect(Math.abs(left - right), `${left} vs ${right}`).toBeGreaterThan(20);
    // switched off: both moments render with the scene's own light, so the shadow stays where it is
    const fixed = scene({ groundShadow: true, groundStrength: 1 }, { matchLight: false });
    const a = await shadowCentre(fixed, lit([-0.8, 0.6, 0]));
    const b = await shadowCentre(fixed, lit([0.8, 0.6, 0]));
    expect(Math.abs(a - b)).toBeLessThan(1);
    // outputs for wiring by hand
    const outs = await h.engine.evaluate({ graph: stampWorldAr(on, worldArNodeIds(on), lit([0, 1, 0])), node: AR, port: 'lightElevation', canvas: CANVAS, proxy: 1, quality: 'preview' });
    expect(outs.value as number).toBeGreaterThan(88);
  }, 180000);
});

void ({} as NodeInstance);
