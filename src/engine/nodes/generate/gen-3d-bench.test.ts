import { expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';

/**
 * Frame cost of the 3D family at 1920x1080 on the headless GPU, default settings (run with BENCH_3D=1 to print the table).
 * Always runs a tiny smoke version so the harness itself stays tested.
 */
const BIG = !!process.env.BENCH_3D;

async function bench(id: string, params: Record<string, unknown>, inputs: Record<string, 'sprite' | 'logo'>, port: string, w: number, h: number, n: number) {
  const t = await harness();
  const sprite = t.fromFn(32, 32, (x, y) => (Math.hypot(x - 15.5, y - 15.5) < 14 ? [220, 90 + x * 4, 60, 255] : [0, 0, 0, 0]));
  const logo = t.fromFn(256, 256, (x, y) => { const r = Math.hypot(x - 127.5, y - 127.5); return r < 110 && r > 55 ? [240, 200, 60, 255] : [0, 0, 0, 0]; });
  let g = createGraph('bench');
  g.project = { ...g.project, width: w, height: h };
  const a = addNode(g, t.registry, id, { x: 0, y: 0 }, params);
  g = a.graph;
  for (const [portName, which] of Object.entries(inputs)) {
    const s = addNode(g, t.registry, t.source(which === 'sprite' ? sprite : logo));
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: a.node.id, port: portName });
  }
  const times: number[] = [];
  for (let i = 0; i < n + 2; i++) {
    // a different position each time so the kernel's cache never answers
    const g2 = { ...g, nodes: g.nodes.map((nd) => (nd.id === a.node.id ? { ...nd, params: { ...nd.params, posX: 0.001 * (i + 1) } } : nd)) };
    const t0 = performance.now();
    const r = await t.engine.evaluate({ graph: g2, node: a.node.id, port });
    if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
    await t.gpu.device.queue.onSubmittedWorkDone();
    if (i >= 2) times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)];
}

it('frame cost table (BENCH_3D=1 for 1920x1080)', { timeout: 600_000 }, async () => {
  const [w, h, n] = BIG ? [1920, 1080, 9] : [160, 90, 2];
  const rows: string[] = [];
  const cases: [string, string, Record<string, unknown>, Record<string, 'sprite' | 'logo'>][] = [
    ['object-3d cube (4 rays/px, as before)', 'object-3d', {}, {}],
    ['image-to-3d sprite 32x32 blocky, normal', 'image-to-3d', { silhouette: 'blocky' }, { image: 'sprite' }],
    ['image-to-3d logo 256 smooth, normal', 'image-to-3d', {}, { image: 'logo' }],
    ['image-to-3d logo 256 smooth, draft', 'image-to-3d', { quality: 'draft' }, { image: 'logo' }],
    ['image-to-3d logo 256 smooth, high', 'image-to-3d', { quality: 'high' }, { image: 'logo' }],
    ['image-to-3d logo, AO + shadows', 'image-to-3d', { shadows: true, ao: 0.5 }, { image: 'logo' }],
    ['sdf-3d default (2 smooth spheres), normal', 'sdf-3d', {}, {}],
    ['sdf-3d default, draft', 'sdf-3d', { quality: 'draft' }, {}],
    ['sdf-3d default, high', 'sdf-3d', { quality: 'high' }, {}],
    ['sdf-3d default + shadows', 'sdf-3d', { shadows: true }, {}],
    ['sdf-3d default + noise displace', 'sdf-3d', { dNoise: 0.1 }, {}],
    ['sdf-3d 8 spheres smooth', 'sdf-3d', Object.fromEntries([3, 4, 5, 6, 7, 8].flatMap((i) => [[`shape${i}`, 'sphere'], [`x${i}`, Math.cos(i) * 0.9], [`y${i}`, Math.sin(i) * 0.7], [`size${i}`, 0.3]])), {}],
    ['sdf-3d infinite repeat (3 axes)', 'sdf-3d', { repeatX: true, repeatY: true, repeatZ: true, shape2: 'off', x1: 0, size1: 0.3 }, {}],
  ];
  for (const [label, id, params, inputs] of cases) {
    const ms = await bench(id, params, inputs, 'image', w, h, n);
    rows.push(`${label.padEnd(46)} ${ms.toFixed(1).padStart(7)} ms`);
  }
  const depthMs = await bench('sdf-3d', {}, {}, 'depth', w, h, n);
  rows.push(`${'sdf-3d depth output alone'.padEnd(46)} ${depthMs.toFixed(1).padStart(7)} ms`);
  if (BIG) console.log(`\nFRAME COST ${w}x${h}\n${rows.join('\n')}`);
  expect(rows.length).toBeGreaterThan(5);
});
