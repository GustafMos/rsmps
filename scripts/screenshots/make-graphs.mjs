// Writes the small graph files used for the showcase renders into scripts/screenshots/graphs/.
// Run: node scripts/screenshots/make-graphs.mjs        (then node scripts/screenshots/render-showcase.mjs)
// Each look is Media In (test scene) > effect(s) > Output. Missing params take the node's defaults when the CLI loads them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'graphs');
mkdirSync(dir, { recursive: true });

const PROJECT = { width: 1920, height: 1080, fps: 24, duration: 4, loop: true, lengthMode: 'relative', referenceSide: 1080 };
const doc = (name, nodes, edges, project = {}) => ({ schema: 'rsmps/graph', version: 2, name, project: { ...PROJECT, ...project }, nodes, edges, frames: [] });
const save = (file, g) => writeFileSync(join(dir, file), JSON.stringify(g, null, 2) + '\n');
let k = 0;
const E = (a, ap, b, bp) => ({ id: `e${++k}`, from: { node: a, port: ap }, to: { node: b, port: bp } });
const N = (id, type, x, y, params = {}, label) => ({ id, type, x, y, params, ...(label ? { label } : {}) });
const OUT = (x, extra = {}) => N('out', 'image-out', x, 0, { name: 'look', kind: 'image', imageFormat: 'png', ...extra }, 'Out');

/** Scene > a > b > ... > Output. */
function chain(file, name, steps, outExtra) {
  const nodes = [N('s', 'media-in', 0, 0, {}, 'Scene')];
  const edges = [];
  let prev = 's';
  steps.forEach(([type, params], i) => {
    const id = `f${i}`;
    nodes.push(N(id, type, (i + 1) * 280, 0, params));
    edges.push(E(prev, 'image', id, 'image'));
    prev = id;
  });
  nodes.push(OUT((steps.length + 1) * 280, outExtra));
  edges.push(E(prev, 'image', 'out', 'image'));
  return { nodes, edges, file, name };
}

// Pixel art: pixelate, then dither to a wired Endesga 32 palette.
{
  const c = chain('look-pixel-dither', 'Look: pixel art and dither', [['pixelate', { value: 135 }], ['dither', { algorithm: 'bayer-4', strength: 0.6 }], ['pixel-upscale', { mode: 'fit-height', target: 1080 }]]);
  c.nodes.push(N('pal', 'palette', 560, 320, { builtin: 'endesga-32' }));
  c.edges.push(E('pal', 'palette', 'f1', 'palette'));
  save(c.file + '.rsmps.json', doc(c.name, c.nodes, c.edges));
}
for (const [file, name, steps] of [
  ['look-crt', 'Look: CRT display', [['pixelate', { value: 180 }], ['crt-display', { preset: 'consumer' }]]],
  ['look-analog', 'Look: analog video', [['analog-video', { preset: 'vhs' }]]],
  ['look-relief', 'Look: scan line relief', [['line-modulation', { lineCount: 72, amount: 22 }]]],
  ['look-halftone', 'Look: halftone', [['halftone', { mode: 'cmyk', dotSize: 9 }]]],
]) {
  const c = chain(file, name, steps);
  save(c.file + '.rsmps.json', doc(c.name, c.nodes, c.edges));
}
// Lens blur driven by a vertical gradient used as depth.
{
  const c = chain('look-lens-blur', 'Look: lens blur', [['lens-blur', { radius: 22, focus: 0.55, range: 0.12, shape: 'hexagon' }]]);
  c.nodes.push(N('dep', 'gradient', 0, 320, { kind: 'linear', angle: 90 }));
  c.edges.push(E('dep', 'image', 'f0', 'depth'));
  save(c.file + '.rsmps.json', doc(c.name, c.nodes, c.edges));
}
// Echo trail: a torus swings across the scene while spinning; echoes follow it. Rendered as a sequence, one frame is picked.
{
  const nodes = [
    N('s', 'media-in', 0, 0, {}, 'Scene'),
    N('c', 'camera', 0, 300, { projection: 'perspective', rig: 'threeQuarter' }),
    N('a', 'animate', 280, 300, { wave: 'sine', from: -1.6, to: 1.6 }),
    N('o', 'object-3d', 560, 0, { shape: 'torus', objectScale: 0.9, spinY: 1, baseColor: [1, 0.55, 0.15, 1] }),
    N('m', 'merge', 840, 0),
    N('e', 'echo', 1120, 0, { count: 6, spacing: 0.06, decay: 0.7, style: 'lighten' }),
    OUT(1400, { kind: 'sequence' }),
  ];
  const edges = [E('c', 'camera', 'o', 'camera'), E('a', 'value', 'o', 'posX'), E('s', 'image', 'm', 'background'), E('o', 'image', 'm', 'foreground'), E('m', 'image', 'e', 'image'), E('e', 'image', 'out', 'image')];
  save('look-echo.rsmps.json', doc('Look: echo trail', nodes, edges, { duration: 2 }));
}
// 3D: two objects with different cameras over the scene.
{
  const nodes = [
    N('s', 'media-in', 0, 0, {}, 'Scene'),
    N('c1', 'camera', 0, 300, { projection: 'perspective', rig: 'threeQuarter' }),
    N('c2', 'camera', 0, 600, { projection: 'isometric' }),
    N('o1', 'object-3d', 300, 300, { shape: 'torus', posX: -1.5, posY: 0.2, objectScale: 0.8, baseColor: [0.95, 0.4, 0.5, 1] }),
    N('o2', 'object-3d', 300, 600, { shape: 'cube', posX: 1.5, posY: -0.2, objectScale: 0.8, cel: true, baseColor: [0.3, 0.8, 0.9, 1] }),
    N('m1', 'merge', 600, 0),
    N('m2', 'merge', 880, 0),
    OUT(1160),
  ];
  const edges = [E('c1', 'camera', 'o1', 'camera'), E('c2', 'camera', 'o2', 'camera'), E('s', 'image', 'm1', 'background'), E('o1', 'image', 'm1', 'foreground'), E('m1', 'image', 'm2', 'background'), E('o2', 'image', 'm2', 'foreground'), E('m2', 'image', 'out', 'image')];
  save('look-3d.rsmps.json', doc('Look: 3D objects', nodes, edges));
}
// Short looping animation: the scene scrolls sideways under the pixel-art + CRT look.
{
  const nodes = [
    N('s', 'media-in', 0, 0, {}, 'Scene'),
    N('sc', 'scroll', 280, 0, {}),
    N('p', 'pixelate', 560, 0, { value: 144 }),
    N('d', 'dither', 840, 0, { algorithm: 'bayer-4', strength: 0.5 }),
    N('pal', 'palette', 840, 320, { builtin: 'endesga-32' }),
    N('c', 'crt-display', 1120, 0, { preset: 'consumer' }),
    OUT(1400, { name: 'anim', kind: 'sequence' }),
  ];
  const edges = [E('s', 'image', 'sc', 'image'), E('sc', 'image', 'p', 'image'), E('p', 'image', 'd', 'image'), E('pal', 'palette', 'd', 'palette'), E('d', 'image', 'c', 'image'), E('c', 'image', 'out', 'image')];
  save('anim-crt.rsmps.json', doc('Animation: CRT pixel art', nodes, edges, { fps: 12, duration: 2 }));
}
console.log('graphs written to', dir);
