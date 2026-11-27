import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupData, groupDefOf } from './group';
import { newSdfScene } from './sdf-scene-group';
import { SDF_SCENE_PARAMS } from './lib/sdf-scene-params';
import { harness } from './testing';
import type { GraphDoc, ImageValue } from './types';

// the owner's project as saved BEFORE the ground shadow settings existed: its SDF Scene group lists only the old render settings
const fixture = JSON.parse(readFileSync(new URL('../io/world-ar/fixtures/sdf-ar-hologram.json', import.meta.url), 'utf8')) as GraphDoc;
const GROUP = 'g_mwyokc0s3s8';
const NEW = ['groundShadow', 'groundStrength', 'groundSoftness', 'groundHeight', 'lightFromCamera'];

describe('an SDF Scene shows the current render settings, also when it was saved without them', () => {
  const old = fixture.nodes.find((n) => n.id === GROUP)!;
  it('the saved group does not list the new settings, yet its definition has them, in the definition\'s order and groups', () => {
    const saved = (old.params as { exposed: { id: string }[] }).exposed.map((x) => x.id);
    for (const k of NEW) expect(saved).not.toContain(k);
    const def = groupDefOf(old);
    for (const k of NEW) expect(Object.keys(def.params)).toContain(k);
    expect((def.params.groundShadow as { group?: string }).group).toBe('Ground shadow');
    const order = Object.keys(def.params).filter((k) => k in SDF_SCENE_PARAMS);
    expect(order).toEqual(Object.keys(SDF_SCENE_PARAMS).filter((k) => order.includes(k)));
    expect(groupData(old).exposed.length).toBe(Object.keys(SDF_SCENE_PARAMS).length);
  });
  it('opening changes nothing: the saved params are untouched and the existing values stay', () => {
    const before = JSON.stringify(old.params);
    groupData(old);
    groupDefOf(old);
    expect(JSON.stringify(old.params)).toBe(before);
    expect(groupData(old).exposed.slice(0, 3).map((x) => x.id)).toEqual(['posX', 'posY', 'posZ']);
    expect((old.params as Record<string, number>).rotX).toBe(-33.9);
  });
  it('a scene that already lists them is unchanged, and a new scene has each setting once', async () => {
    const t = await harness();
    const fresh = newSdfScene(t.registry, 's', { x: 0, y: 0 });
    const ids = groupData(fresh).exposed.map((x) => x.id);
    expect(ids).toEqual(Object.keys(SDF_SCENE_PARAMS));
    expect(groupData(fresh).exposed).toEqual((fresh.params as { exposed: unknown[] }).exposed);
  });
  it('toggling Ground shadow on the old group renders the shadow, and the values persist through save and load', async () => {
    const t = await harness();
    const set = (g: GraphDoc, p: Record<string, unknown>): GraphDoc => ({ ...g, nodes: g.nodes.map((n) => (n.id === GROUP ? { ...n, params: { ...n.params, ...p } } : n)) });
    const cut = structuredClone(fixture);
    const grp = cut.nodes.find((n) => n.id === GROUP)!.params as { edges: { from: { node: string } }[] };
    grp.edges = grp.edges.filter((e) => e.from.node !== 'n_mwysdf7r2k0' && e.from.node !== 'n_mwysffal5i8');
    const canvas = { width: 240, height: 135 };
    const shadowPixels = async (g: GraphDoc) => {
      const img = (await t.engine.evaluate({ graph: g, node: GROUP, port: 'image', seconds: 2, canvas, proxy: 1, quality: 'preview' })).value as ImageValue;
      const px = await t.pixels(img);
      let n = 0;
      for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 20 && px.data[i - 3] + px.data[i - 2] + px.data[i - 1] === 0) n++;
      return n;
    };
    expect(await shadowPixels(cut)).toBe(0);
    const on = set(cut, { groundShadow: true, groundStrength: 1 });
    expect(await shadowPixels(on)).toBeGreaterThan(50);
    // save and load: the values are plain group params, so a JSON round trip keeps them and the shadow
    const loaded = JSON.parse(JSON.stringify(on)) as GraphDoc;
    expect((loaded.nodes.find((n) => n.id === GROUP)!.params as Record<string, unknown>).groundShadow).toBe(true);
    expect(await shadowPixels(loaded)).toBeGreaterThan(50);
  }, 120000);
});
