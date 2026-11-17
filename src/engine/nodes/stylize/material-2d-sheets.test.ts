import { expect, it } from 'vitest';
import { sheet, writePng, type Img } from '../../lib/gen-3d-testutil';
import { addNode, connect, createGraph } from '../../graph';
import { baseScene, centredLogo, H, lit, over } from '../../lib/material2d-testutil';
import type { GraphDoc, ImageValue } from '../../types';

const T = { timeout: 300_000 };

const MODELS: [string, Record<string, unknown> | null, Record<string, unknown>?][] = [
  ['unwired', null],
  ['matte', { model: 'matte' }],
  ['clay', { model: 'clay', baseColor: [0.8, 0.55, 0.4, 1] }],
  ['plastic', { model: 'plastic', baseColor: [0.9, 0.15, 0.1, 1] }],
  ['metal', { model: 'metal' }],
  ['gold', { model: 'metal', baseColor: [1, 0.78, 0.35, 1], roughness: 0.25 }],
  ['glass', { model: 'glass' }],
  ['toon', { model: 'toon', baseColor: [0.95, 0.5, 0.2, 1] }],
  ['emissive', { model: 'emissive', baseColor: [0.2, 0.9, 1, 1], emissionStrength: 1.2 }],
  ['hologram', { model: 'hologram', baseColor: [0.2, 0.9, 1, 1] }],
  ['matcap', { model: 'matcap' }],
  ['wire', { model: 'wire', baseColor: [0.2, 1, 0.5, 1] }],
];

it('looks: a pixel sprite through every material model (contact sheet, art grid kept)', T, async () => {
  const t = await H();
  // a 24 x 24 sprite: a little potion bottle, upscaled 8x with its art grid
  const rows = [
    '........................',
    '..........######........',
    '..........#....#........',
    '..........######........',
    '..........#....#........',
    '.........########.......',
    '........##......##......',
    '.......##..ooo...##.....',
    '......##..ooooo...##....',
    '.....##..ooooooo...##...',
    '.....##..ooooooo...##...',
    '.....##..ooooooo...##...',
    '.....##...ooooo....##...',
    '.....##............##...',
    '......##..........##....',
    '.......############.....',
    '........................',
  ];
  const sprite = (x: number, y: number): [number, number, number, number] => {
    const ch = rows[y]?.[x] ?? '.';
    if (ch === '#') return [60, 70, 110, 255];
    if (ch === 'o') return [230, 60, 90, 255];
    if (y >= 6 && y <= 14 && ch === '.' && x > 6 && x < 18) return [210, 225, 240, 255];
    return [0, 0, 0, 0];
  };
  const cell = 8;
  const big = t.fromFn(24 * cell, 18 * cell, (x, y) => sprite(Math.floor(x / cell), Math.floor(y / cell)));
  const input = { ...big, cell } as ImageValue;
  const tiles: Img[] = [];
  for (const [name, mat] of MODELS) {
    const { px } = await lit(input, mat, { cel: false, bevelWidth: 14, shape: 'bevel' });
    writePng(`material-2d/sprite-${name}`, px);
    tiles.push(px);
  }
  // the same sprite with posterized light ("pixel bevel")
  const { px: cel } = await lit(input, { model: 'plastic' }, { cel: true, celSteps: 3, bevelWidth: 14 });
  tiles.push(cel);
  const { px: cel2 } = await lit(input, { model: 'metal' }, { cel: true, celSteps: 4, bevelWidth: 24, profile: 'pillow' });
  tiles.push(cel2);
  const { px: toonSh } = await lit(input, { model: 'toon', baseColor: [1, 1, 1, 1] }, { colorFrom: 'tint', shadow: 0.8, shadowOffset: 16, shadowBlur: 0, bevelWidth: 10 });
  tiles.push(toonSh);
  const { px: lumaDetail } = await lit(input, { model: 'clay', baseColor: [1, 1, 1, 1] }, { colorFrom: 'picture', shape: 'luma', depth: 1.2, detail: 0.6 });
  tiles.push(lumaDetail);
  writePng('material-2d/sprite-sheet', sheet(tiles, 5));
  expect(tiles.length).toBe(16);
});

it('looks: footage refracted through a glass logo, composited over the scene', T, async () => {
  const t = await H();
  const bg = await baseScene();
  const logo = await centredLogo(bg.width, bg.height, 300);
  const plain = await t.pixels(bg);
  const tiles: Img[] = [plain];
  for (const [mat, params] of [
    [{ model: 'glass' }, {}],
    [{ model: 'glass', refraction: 0.3, baseColor: [0.85, 0.95, 1, 1] }, { depth: 1.5, bevelWidth: 30, profile: 'pillow' }],
  ] as const) {
    const { px } = await lit(logo, mat, params, { background: bg }, { matInputs: { background: bg } });
    tiles.push(over(px, plain));
  }
  writePng('material-2d/glass-over-scene', sheet(tiles, 3), false);
});

it('looks: chrome, plastic, glass and clay at default settings over the scene', T, async () => {
  const t = await H();
  const bg = await baseScene();
  const logo = await centredLogo(bg.width, bg.height, 300);
  const plain = await t.pixels(bg);
  const tiles: Img[] = [];
  for (const mat of [{ model: 'metal' }, { model: 'plastic', baseColor: [0.9, 0.2, 0.15, 1] }, { model: 'glass' }, { model: 'clay', baseColor: [0.75, 0.6, 0.5, 1] }]) {
    const { px } = await lit(logo, mat, {}, {}, { matInputs: mat.model === 'glass' ? { background: bg } : {} });
    tiles.push(over(px, plain));
  }
  writePng('material-2d/defaults-over-scene', sheet(tiles, 2), false);
});

it('performance: milliseconds per frame at 1920 x 1080 (still re-lit, and a different frame every time like video)', T, async () => {
  const t = await H();
  const FR = 26;
  const frames: ImageValue[] = [];
  for (let k = 0; k < FR; k++) frames.push(await centredLogo(1920, 1080, 700 - k));
  const dev = t.gpu.device;
  const result: Record<string, string> = {};
  for (const quality of ['draft', 'normal', 'high']) {
    const build = (frame: ImageValue, extra: Record<string, unknown>) => {
      let g = createGraph('perf');
      g.project = { ...g.project, width: 1920, height: 1080, fps: 30, duration: 1, loop: true };
      const s0 = addNode(g, t.registry, t.source(frame));
      const m = addNode(s0.graph, t.registry, 'material', { x: 0, y: 0 }, { model: 'metal' });
      const n = addNode(m.graph, t.registry, 'material-2d', { x: 200, y: 0 }, { quality, ...extra });
      g = connect(n.graph, t.registry, { node: s0.node.id, port: 'out' }, { node: n.node.id, port: 'image' });
      g = connect(g, t.registry, { node: m.node.id, port: 'material' }, { node: n.node.id, port: 'material' });
      return { g, node: n.node.id };
    };
    const time = async (label: string, make: (i: number) => { g: GraphDoc; node: string }) => {
      const run = async (i: number) => {
        const { g, node } = make(i);
        const r = await t.engine.evaluate({ graph: g, node, port: 'image', seconds: 0 });
        if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
        await dev.queue.onSubmittedWorkDone();
      };
      for (let i = 0; i < 4; i++) await run(i);
      const t0 = performance.now();
      const N = 20;
      for (let i = 0; i < N; i++) await run(i + 4);
      result[quality + ' ' + label] = ((performance.now() - t0) / N).toFixed(2);
    };
    // a still picture with the light being dragged: the node re-renders (field + lighting) every time
    await time('still, light moving', (i) => build(frames[0], { lightAngle: -45 + i * 3 }));
    // video: a new picture every frame
    await time('video frame', (i) => build(frames[i], {}));
  }
  console.log('MATERIAL2D_MS_PER_FRAME_1080p ' + JSON.stringify(result));
  expect(Object.keys(result).length).toBe(6);
});
