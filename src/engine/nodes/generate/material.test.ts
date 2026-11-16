import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';

let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 180_000 };
const sha = (px: Img) => createHash('sha1').update(Buffer.from(px.data)).digest('hex');
const front = { shape: 'sphere', rotX: 0, rotY: 0, cameraType: 'orthographic', scale: 0.5 };
const pj = { width: 96, height: 96 };

/** object-3d (or another 3D node) fed by a Material node with the given params and pictures. */
async function withMaterial(target: string, targetParams: Record<string, unknown>, mat: Record<string, unknown>, maps: Record<string, never> = {}, seconds = 0, project = pj, extra: Record<string, never> = {}) {
  const t = await H();
  let g = createGraph('mat');
  g.project = { ...g.project, ...project, fps: 10, duration: 2, loop: true };
  const m = addNode(g, t.registry, 'material', { x: 0, y: 0 }, mat);
  g = m.graph;
  for (const [port, img] of Object.entries(maps)) {
    const s = addNode(g, t.registry, t.source(img));
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: m.node.id, port });
  }
  const o = addNode(g, t.registry, target, { x: 200, y: 0 }, targetParams);
  g = connect(o.graph, t.registry, { node: m.node.id, port: 'material' }, { node: o.node.id, port: 'material' });
  for (const [port, img] of Object.entries(extra)) {
    const s = addNode(g, t.registry, t.source(img));
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: o.node.id, port });
  }
  const r = await t.engine.evaluate({ graph: g, node: o.node.id, port: 'image', seconds });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  return t.pixels(r.value as never);
}
const plain = async (params: Record<string, unknown>, size = 96) => {
  const t = await H();
  return t.pixels((await t.run('object-3d', params, {}, { project: { width: size, height: size } })).image as never);
};
const at = (px: Img, x: number, y: number) => [px.data[(y * px.width + x) * 4], px.data[(y * px.width + x) * 4 + 1], px.data[(y * px.width + x) * 4 + 2], px.data[(y * px.width + x) * 4 + 3]];

it('unwired material input: the picture is exactly what it was before materials existed', T, async () => {
  const GOLDEN: Record<string, string> = {
    cube: '2584d52c2a3b8ff9f9fb034dd36d5d79dffddd5c',
    sphereCel: '89212cb6a5efc684fb5d37be7e2ed6407555e251',
  };
  expect(sha(await plain({ shape: 'cube', rotX: 20, rotY: 30 }, 96))).toBe(GOLDEN.cube);
  expect(sha(await plain({ shape: 'sphere', cel: true, celSteps: 4 }, 96))).toBe(GOLDEN.sphereCel);
});

it('metal and matte differ in the highlight; plastic has a specular spot', T, async () => {
  const matte = await withMaterial('object-3d', front, { model: 'matte' });
  const plastic = await withMaterial('object-3d', front, { model: 'plastic', roughness: 0.15, specular: 1 });
  const metal = await withMaterial('object-3d', front, { model: 'metal', roughness: 0.2 });
  const peak = (px: Img) => {
    let m = 0;
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 250) m = Math.max(m, px.data[i], px.data[i + 1], px.data[i + 2]);
    return m;
  };
  expect(sha(matte)).not.toBe(sha(metal));
  expect(sha(matte)).not.toBe(sha(plastic));
  const hot = (px: Img) => { let n = 0; for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 250 && px.data[i] > 245 && px.data[i + 1] > 245) n++; return n; };
  expect(hot(plastic)).toBeGreaterThan(hot(matte) + 3);
  expect(peak(plastic)).toBeGreaterThanOrEqual(peak(matte));
  // metal mirrors the sky: the top of the ball is bluer than its bottom
  const top = at(metal, 48, 48 - 14);
  const bottom = at(metal, 48, 48 + 14);
  expect(top[2] - top[0]).toBeGreaterThan(bottom[2] - bottom[0]);
});

it('a colour map shows on a cube face (triplanar and planar), and a normal map changes the light', T, async () => {
  const t = await H();
  const red = t.solid(8, 8, [255, 0, 0, 255]);
  const cube = { shape: 'cube', rotX: 0, rotY: 0, cameraType: 'orthographic', scale: 0.5, baseColor: [1, 1, 1, 1] };
  const w = await withMaterial('object-3d', cube, { model: 'matte', baseColor: [1, 1, 1, 1] });
  const r = await withMaterial('object-3d', cube, { model: 'matte', baseColor: [1, 1, 1, 1] }, { colorMap: red as never });
  const c = at(r, 48, 48);
  expect(at(w, 48, 48)[1]).toBeGreaterThan(150);
  expect(c[0]).toBeGreaterThan(120);
  expect(c[1]).toBeLessThan(30);
  const r2 = await withMaterial('object-3d', cube, { model: 'matte', baseColor: [1, 1, 1, 1], triplanar: false }, { colorMap: red as never });
  expect(at(r2, 48, 48)[1]).toBeLessThan(30);
  // a tilted normal map (strongly leaning right) changes the lit shading
  const lean = t.solid(8, 8, [255, 128, 255, 255]);
  const n1 = await withMaterial('object-3d', { ...front, lightAzimuth: -70 }, { model: 'matte' });
  const n2 = await withMaterial('object-3d', { ...front, lightAzimuth: -70 }, { model: 'matte', normalStrength: 2 }, { normalMap: lean as never });
  expect(sha(n1)).not.toBe(sha(n2));
});

it('one Material feeds two objects (Object and SDF 3D and Image to 3D), all with the same look', T, async () => {
  const t = await H();
  let g = createGraph('two');
  g.project = { ...g.project, width: 96, height: 96 };
  const m = addNode(g, t.registry, 'material', { x: 0, y: 0 }, { model: 'matte', baseColor: [1, 0, 0, 1] });
  g = m.graph;
  const ids: string[] = [];
  const img = t.solid(16, 16, [255, 255, 255, 255]);
  for (const [type, params] of [
    ['object-3d', { ...front, baseColor: [1, 1, 1, 1], ambient: 1 }],
    ['sdf-3d', { cameraType: 'orthographic', rotX: 0, rotY: 0, scale: 0.5, shape2: 'off', x1: 0, size1: 0.8, color1: [1, 1, 1, 1], ambient: 1, ao: 0 }],
    ['image-to-3d', { cameraType: 'orthographic', rotX: 0, rotY: 0, scale: 0.5, ambient: 1, ao: 0 }],
  ] as const) {
    const o = addNode(g, t.registry, type, { x: 0, y: 0 }, params as never);
    g = connect(o.graph, t.registry, { node: m.node.id, port: 'material' }, { node: o.node.id, port: 'material' });
    if (type === 'image-to-3d') {
      const s = addNode(g, t.registry, t.source(img));
      g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: o.node.id, port: 'image' });
    }
    ids.push(o.node.id);
  }
  for (const id of ids) {
    const r = await t.engine.evaluate({ graph: g, node: id, port: 'image' });
    expect(r.errors.size).toBe(0);
    const px = await t.pixels(r.value as never);
    const c = at(px, 48, 48);
    expect(c[0], id).toBeGreaterThan(150);
    expect(c[1], id).toBeLessThan(40);
  }
});

it('toon material posterises into the chosen number of bands and draws an outline', T, async () => {
  const px = await withMaterial('object-3d', { ...front, baseColor: [1, 1, 1, 1] }, { model: 'toon', toonBands: 3, specular: 0, outline: 0.45, baseColor: [0.8, 0.8, 0.8, 1] }, {}, 0, { width: 128, height: 128 });
  const levels = new Map<number, number>();
  let dark = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const c = at(px, x, y);
    const r = Math.hypot(x - 64, y - 64);
    if (c[3] === 255 && r < 22) levels.set(c[0], (levels.get(c[0]) ?? 0) + 1);
    if (c[3] === 255 && c[0] < 30) dark++;
  }
  // exactly three bands (band edges are anti-aliased, so count only the levels that cover real area)
  expect([...levels.values()].filter((n) => n > 40).length).toBe(3);
  expect(dark).toBeGreaterThan(20); // the outline ring
});

it('hologram scanlines animate and loop exactly', T, async () => {
  const cfg = { ...front };
  const mat = { model: 'hologram', holoCycles: 1, rimStrength: 1 };
  const a = await withMaterial('object-3d', cfg, mat, {}, 0);
  const mid = await withMaterial('object-3d', cfg, mat, {}, 1);
  const end = await withMaterial('object-3d', cfg, mat, {}, 2);
  let seam = 0;
  let motion = 0;
  for (let i = 0; i < a.data.length; i++) {
    seam += Math.abs(a.data[i] - end.data[i]);
    motion += Math.abs(a.data[i] - mid.data[i]);
  }
  expect(seam / a.data.length).toBeLessThan(0.05);
  expect(motion / a.data.length).toBeGreaterThan(0.1);
  // translucent: the hologram is partly see-through
  let part = 0;
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] > 10 && a.data[i] < 240) part++;
  expect(part).toBeGreaterThan(200);
});

it('moving material sliders never compiles a new shader', T, async () => {
  const t = await H();
  await withMaterial('object-3d', front, { model: 'metal', roughness: 0.2 });
  const before = t.gpu.stats().objects.pipelinesCreated;
  for (const v of [0.1, 0.4, 0.8]) await withMaterial('object-3d', front, { model: 'metal', roughness: v, baseColor: [v, 0.5, 0.5, 1], rimStrength: 0.5 + v, emissionStrength: v });
  const first = t.gpu.stats().objects.pipelinesCreated - before; // rim and emission switch features on once
  const mid = t.gpu.stats().objects.pipelinesCreated;
  for (const v of [0.2, 0.5, 0.9]) await withMaterial('object-3d', front, { model: 'metal', roughness: v, baseColor: [v, 0.5, 0.5, 1], rimStrength: 0.3 + v, emissionStrength: v + 0.1, rimPower: 2 + v });
  expect(t.gpu.stats().objects.pipelinesCreated - mid).toBe(0);
  expect(first).toBeLessThanOrEqual(2);
});

it('draws the material ball sheet to a PNG', T, async () => {
  const t = await H();
  const checker = t.checker(64, 64, 8);
  const studs = t.fromFn(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [230, 190, 80, 255] : [90, 50, 20, 255]));
  const sky = t.fromFn(128, 64, (x, y) => [Math.round(60 + 190 * (x / 128)), Math.round(120 + 100 * (1 - y / 64)), Math.round(200 - 100 * (x / 128)), 255]);
  const matcap = t.fromFn(64, 64, (x, y) => {
    const dx = (x - 31.5) / 32, dy = (y - 31.5) / 32;
    const l = Math.max(0, 1 - Math.hypot(dx + 0.3, dy + 0.3));
    return [Math.round(40 + 215 * l), Math.round(20 + 120 * l), Math.round(60 + 80 * l), 255];
  });
  const cases: [string, Record<string, unknown>, Record<string, never>][] = [
    ['matte', { model: 'matte', baseColor: [0.9, 0.5, 0.3, 1] }, {}],
    ['clay', { model: 'clay', baseColor: [0.85, 0.6, 0.5, 1] }, {}],
    ['plastic', { model: 'plastic', baseColor: [0.2, 0.55, 0.95, 1], roughness: 0.25 }, {}],
    ['metal', { model: 'metal', baseColor: [1, 0.78, 0.4, 1], roughness: 0.25 }, {}],
    ['metal + environment', { model: 'metal', baseColor: [0.9, 0.9, 0.95, 1], roughness: 0.1 }, { environment: sky as never }],
    ['glass', { model: 'glass', baseColor: [0.8, 1, 0.95, 1], refraction: 0.2, opacity: 0.7, rimStrength: 0.3 }, { background: checker as never }],
    ['toon', { model: 'toon', baseColor: [0.95, 0.4, 0.5, 1], toonBands: 3 }, {}],
    ['emissive', { model: 'emissive', baseColor: [0.4, 0.2, 0.9, 1], emissionColor: [0.4, 1, 0.8, 1], emissionStrength: 0 }, {}],
    ['hologram', { model: 'hologram', baseColor: [0.3, 0.9, 1, 1], rimColor: [0.4, 1, 1, 1], rimStrength: 1 }, {}],
    ['matcap', { model: 'matcap', baseColor: [1, 1, 1, 1] }, { matcap: matcap as never }],
    ['wire', { model: 'wire', baseColor: [0.4, 1, 0.5, 1], wireScale: 5 }, {}],
    ['colour map', { model: 'plastic', baseColor: [1, 1, 1, 1], roughness: 0.4, mapScale: 0.6 }, { colorMap: studs as never }],
  ];
  const shots: Img[] = [];
  for (const [, mat, maps] of cases) shots.push(await withMaterial('object-3d', { ...front, scale: 0.7, rotY: 20, cameraType: 'perspective' }, mat, maps, 0, { width: 128, height: 128 }));
  writePng('material-balls', sheet(shots, 6));
});
