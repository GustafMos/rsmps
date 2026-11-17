import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import type { GraphDoc, ImageValue } from '../../types';
import { harness, type Harness } from '../../testing';
import type { Rgb } from '../../lib/pixel-color';
import { crispResize } from '../../lib/art-grid';

type Px = [number, number, number, number];
const CLEAR: Px = [0, 0, 0, 0];
const RED: Px = [255, 0, 0, 255];

/** Draw a small picture from strings: '.' empty, 'R' red, 'G' green, 'B' blue, 'W' white. */
function draw(t: Harness, rows: string[]): ImageValue {
  const col: Record<string, Px> = { '.': CLEAR, R: RED, G: [0, 255, 0, 255], B: [0, 0, 255, 255], W: [255, 255, 255, 255] };
  return t.fromFn(rows[0].length, rows.length, (x, y) => col[rows[y][x]]);
}

/** The picture as strings again: R G B W for those colors, '#' for any other opaque pixel, '.' for empty. */
async function show(t: Harness, image: ImageValue | null | undefined): Promise<string[]> {
  const px = await t.pixels(image);
  const names = new Map<string, string>([['255,0,0', 'R'], ['0,255,0', 'G'], ['0,0,255', 'B'], ['255,255,255', 'W']]);
  const rows: string[] = [];
  for (let y = 0; y < px.height; y++) {
    let r = '';
    for (let x = 0; x < px.width; x++) {
      const [R, G, B, A] = px.at(x, y);
      r += A === 0 ? '.' : (names.get(`${R},${G},${B}`) ?? '#');
    }
    rows.push(r);
  }
  return rows;
}

const run = async (t: Harness, type: string, params: Record<string, unknown>, image: ImageValue) => (await t.run(type, params, { image })).image as ImageValue;
const dot = ['.......', '.......', '.......', '...R...', '.......', '.......', '.......'];

describe('pixel-outline', () => {
  it('8-connected outer outline of one pixel is the ring of 8; 4-connected is the plus', async () => {
    const t = await harness();
    expect(await show(t, await run(t, 'pixel-outline', { color: [0, 0, 0, 1], connect: 'eight' }, draw(t, dot)))).toEqual(['.......', '.......', '..###..', '..#R#..', '..###..', '.......', '.......']);
    expect(await show(t, await run(t, 'pixel-outline', { color: [0, 0, 0, 1], connect: 'four' }, draw(t, dot)))).toEqual(['.......', '.......', '...#...', '..#R#..', '...#...', '.......', '.......']);
  });

  it('width 2: a diamond with 4-connected, a square with 8-connected', async () => {
    const t = await harness();
    const p = { color: [0, 0, 0, 1], width: 2 };
    const four = await show(t, await run(t, 'pixel-outline', { ...p, connect: 'four' }, draw(t, dot)));
    expect(four.join('').split('#').length - 1).toBe(12);
    expect(four[1]).toBe('...#...');
    const eight = await show(t, await run(t, 'pixel-outline', { ...p, connect: 'eight' }, draw(t, dot)));
    expect(eight.join('').split('#').length - 1).toBe(24);
    expect(eight[1]).toBe('.#####.');
  });

  it('inner outline recolors the border pixels of a block; both also draws the ring', async () => {
    const t = await harness();
    const block = ['.....', '.RRR.', '.RRR.', '.RRR.', '.....'];
    expect(await show(t, await run(t, 'pixel-outline', { position: 'inside', color: [0, 0, 0, 1], connect: 'four' }, draw(t, block)))).toEqual(['.....', '.###.', '.#R#.', '.###.', '.....']);
    expect(await show(t, await run(t, 'pixel-outline', { position: 'both', color: [0, 0, 0, 1], connect: 'four' }, draw(t, block)))).toEqual(['.###.', '#####', '##R##', '#####', '.###.']);
  });

  it('only bottom and right: a drop-shadow style edge', async () => {
    const t = await harness();
    const base = { color: [0, 0, 0, 1], top: false, left: false };
    expect(await show(t, await run(t, 'pixel-outline', { ...base, connect: 'four' }, draw(t, dot)))).toEqual(['.......', '.......', '.......', '...R#..', '...#...', '.......', '.......']);
    expect(await show(t, await run(t, 'pixel-outline', { ...base, connect: 'eight' }, draw(t, dot)))).toEqual(['.......', '.......', '....#..', '...R#..', '..###..', '.......', '.......']);
  });

  it('selective outline darkens the color it touches; a second outline sits outside the first', async () => {
    const t = await harness();
    const two = ['.........', '.........', '.........', '....RG...', '.........', '.........', '.........'];
    const px = await t.pixels(await run(t, 'pixel-outline', { colorMode: 'selective', darken: 0.5, connect: 'four' }, draw(t, two)));
    expect(Math.abs(px.at(4, 2)[0] - 128)).toBeLessThanOrEqual(1);
    expect(px.at(4, 2)[1]).toBe(0);
    expect(Math.abs(px.at(5, 4)[1] - 128)).toBeLessThanOrEqual(1);
    const dbl = await show(t, await run(t, 'pixel-outline', { color: [0, 0, 0, 1], second: true, color2: [1, 1, 1, 1], connect: 'four' }, draw(t, dot)));
    expect(dbl).toEqual(['.......', '...W...', '..W#W..', '.W#R#W.', '..W#W..', '...W...', '.......']);
  });

  it('palette mode only uses palette colors', async () => {
    const t = await harness();
    let g = createGraph('o');
    const node = addNode(g, t.registry, 'pixel-outline', { x: 0, y: 0 }, { colorMode: 'palette', darken: 0.5, connect: 'four' });
    g = node.graph;
    const src = addNode(g, t.registry, t.source(draw(t, ['.....', '..R..', '.....'])));
    g = connect(src.graph, t.registry, { node: src.node.id, port: 'out' }, { node: node.node.id, port: 'image' });
    const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'custom', custom: [[0, 0, 0], [0.4, 0, 0], [1, 1, 1]] });
    g = connect(pal.graph, t.registry, { node: pal.node.id, port: 'palette' }, { node: node.node.id, port: 'palette' });
    const px = await t.pixels((await t.evalGraph(g, node.node.id, { port: 'image' })) as ImageValue);
    expect(px.at(2, 0).slice(0, 3)).toEqual([102, 0, 0]);
  });

  it('works on the art grid: one art pixel of outline is cell texels wide', async () => {
    const t = await harness();
    const art = draw(t, ['.....', '..R..', '.....']);
    const big = { ...crispResize(t.gpu as never, art, { width: 20, height: 12, unit: 1 }), cell: 4 };
    t.gpu.retain(big.texture);
    const o = await run(t, 'pixel-outline', { color: [0, 0, 0, 1], connect: 'four' }, big);
    expect([o.width, o.height, o.cell]).toEqual([20, 12, 4]);
    const px = await t.pixels(o);
    expect(px.at(8, 3)).toEqual([0, 0, 0, 255]);
    expect(px.at(11, 0)).toEqual([0, 0, 0, 255]);
    expect(px.at(7, 3)[3]).toBe(0);
    expect(px.at(12, 3)[3]).toBe(0);
  });

  it('an empty picture stays empty', async () => {
    const t = await harness();
    expect((await show(t, await run(t, 'pixel-outline', {}, t.fromFn(4, 4, () => CLEAR)))).join('')).toBe('.'.repeat(16));
  });
});

describe('clean-pixels', () => {
  it('removes stray pixels, fills one pixel holes, keeps solid shapes untouched', async () => {
    const t = await harness();
    const img = draw(t, ['R.......', '..GGG...', '..G.G...', '..GGG...', '.......B', '........']);
    const o = await show(t, await run(t, 'clean-pixels', {}, img));
    expect(o[0]).toBe('........');
    expect(o[4]).toBe('........');
    expect(o.slice(1, 4)).toEqual(['..GGG...', '..GGG...', '..GGG...']);
  });

  it('hard alpha takes edge color from the solid neighbours and drops faint pixels', async () => {
    const t = await harness();
    const img = t.fromFn(5, 3, (x) => (x <= 1 ? [255, 0, 0, 255] : x === 2 ? [40, 40, 40, 160] : x === 3 ? [250, 250, 250, 60] : CLEAR));
    const px = await t.pixels(await run(t, 'clean-pixels', { threshold: 0.5, orphans: false, holes: false }, img));
    expect(px.at(2, 1)).toEqual([255, 0, 0, 255]);
    expect(px.at(3, 1)[3]).toBe(0);
    const soft = await t.pixels(await run(t, 'clean-pixels', { hardAlpha: false, defringe: false, orphans: false, holes: false }, img));
    expect(soft.at(3, 1)[3]).toBe(60);
  });

  it('trim elbows thins a staircase without breaking it, and leaves filled shapes alone', async () => {
    const t = await harness();
    expect(await show(t, await run(t, 'clean-pixels', { jaggies: true }, draw(t, ['RR...', '.RR..', '..RR.', '...RR'])))).toEqual(['RR...', '..R..', '...R.', '....R']);
    const block = ['.....', '.RRR.', '.RRR.', '.RRR.', '.....'];
    expect(await show(t, await run(t, 'clean-pixels', { jaggies: true }, draw(t, block)))).toEqual(block);
    const stairs = ['RR...', '.RR..', '..RR.', '...RR'];
    expect(await show(t, await run(t, 'clean-pixels', {}, draw(t, stairs)))).toEqual(stairs);
  });
});

describe('sprite-shadow', () => {
  const sprite = ['..........', '..........', '...RR.....', '...RR.....', '...RR.....', '..........', '..........'];

  it('drop shadow is the silhouette moved by the offset, drawn behind the sprite', async () => {
    const t = await harness();
    const o = await show(t, await run(t, 'sprite-shadow', { mode: 'drop', offset: [2, 1], color: [0, 0, 0, 1], opacity: 1 }, draw(t, sprite)));
    expect(o).toEqual(['..........', '..........', '...RR.....', '...RR##...', '...RR##...', '.....##...', '..........']);
  });

  it('ground shadow is flattened toward the ground line (shadow only)', async () => {
    const t = await harness();
    const tall = draw(t, ['..........', '..........', '....RR....', '....RR....', '....RR....', '....RR....', '....RR....', '....RR....', '..........', '..........']);
    const behind = await show(t, await run(t, 'sprite-shadow', { mode: 'ground', ground: 0.8, squash: 0.5, skew: 0, color: [0, 0, 0, 1], opacity: 1, only: true }, tall));
    expect(behind).toEqual(['..........', '..........', '..........', '..........', '..........', '....##....', '....##....', '....##....', '..........', '..........']);
    const front = await show(t, await run(t, 'sprite-shadow', { mode: 'ground', ground: 0.8, squash: 0.5, skew: 0, toward: true, color: [0, 0, 0, 1], opacity: 1, only: true }, tall));
    expect(front.slice(8)).toEqual(['....##....', '....##....']);
    expect(front.slice(0, 8).join('')).toBe('.'.repeat(80));
  });

  it('contact blob is an ellipse on the ground line', async () => {
    const t = await harness();
    const px = await t.pixels(await run(t, 'sprite-shadow', { mode: 'contact', ground: 0.5, center: 0.5, blob: [4, 2], color: [0, 0, 0, 1], opacity: 1, only: true }, t.fromFn(20, 10, () => CLEAR)));
    let row5 = 0;
    for (let x = 0; x < 20; x++) if (px.at(x, 5)[3] === 255) row5++;
    expect(row5).toBe(8);
    expect(px.at(9, 4)[3]).toBe(255);
    expect(px.at(0, 0)[3]).toBe(0);
  });

  it('retro transparency uses full-opacity pixels on a pattern; solid blends', async () => {
    const t = await harness();
    const empty = t.fromFn(20, 10, () => CLEAR);
    const base = { mode: 'contact', ground: 0.5, blob: [6, 3], color: [0, 0, 0, 1], only: true };
    const checker = await t.pixels(await run(t, 'sprite-shadow', { ...base, pattern: 'checker', opacity: 0.5 }, empty));
    let n = 0;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
      const a = checker.at(x, y)[3];
      if (a) {
        n++;
        expect(a).toBe(255);
        expect((x + y) % 2).toBe(0);
      }
    }
    expect(n).toBeGreaterThan(10);
    const none = await t.pixels(await run(t, 'sprite-shadow', { ...base, pattern: 'bayer', opacity: 0 }, empty));
    expect(none.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
    const full = await t.pixels(await run(t, 'sprite-shadow', { ...base, pattern: 'bayer', opacity: 1 }, empty));
    expect(full.at(10, 5)[3]).toBe(255);
    const solid = await t.pixels(await run(t, 'sprite-shadow', { ...base, pattern: 'solid', opacity: 0.5 }, empty));
    expect(Math.abs(solid.at(10, 5)[3] - 128)).toBeLessThanOrEqual(1);
  });
});

async function lockGraph(t: Harness, image: ImageValue, palette: Rgb[], params: Record<string, unknown>): Promise<{ graph: GraphDoc; id: string }> {
  let g = createGraph('lock');
  const node = addNode(g, t.registry, 'palette-lock', { x: 0, y: 0 }, params);
  g = node.graph;
  const src = addNode(g, t.registry, t.source(image));
  g = connect(src.graph, t.registry, { node: src.node.id, port: 'out' }, { node: node.node.id, port: 'image' });
  const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'custom', custom: palette });
  g = connect(pal.graph, t.registry, { node: pal.node.id, port: 'palette' }, { node: node.node.id, port: 'palette' });
  return { graph: g, id: node.node.id };
}

describe('palette-lock', () => {
  const PAL: Rgb[] = [[1, 0, 0], [0, 0, 1]];
  const pic = (t: Harness) =>
    t.fromFn(4, 2, (x, y) => (y === 0 ? ([[255, 0, 0, 255], [0, 0, 255, 255], [250, 10, 10, 255], [10, 10, 240, 128]] as Px[])[x] : ([[0, 255, 0, 255], CLEAR, [255, 0, 0, 255], [0, 0, 255, 255]] as Px[])[x]));

  it('snap: every output color is on the palette, alpha is kept, transparent stays transparent', async () => {
    const t = await harness();
    const { graph, id } = await lockGraph(t, pic(t), PAL, { mode: 'snap' });
    const px = await t.pixels((await t.evalGraph(graph, id, { port: 'image' })) as ImageValue);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
      const [r, g, b, a] = px.at(x, y);
      if (a === 0) continue;
      expect([`${r},${g},${b}` === '255,0,0', `${r},${g},${b}` === '0,0,255'].some(Boolean), `pixel ${x},${y} = ${r},${g},${b}`).toBe(true);
    }
    expect(px.at(3, 0)[3]).toBe(128);
    expect(px.at(1, 1)[3]).toBe(0);
    expect(px.at(2, 0).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('counts: 5 pixels, 3 of them off the palette, 5 distinct colors in; 2 after snapping', async () => {
    const t = await harness();
    const report = await lockGraph(t, pic(t), PAL, { mode: 'report' });
    expect(await t.evalGraph(report.graph, report.id, { port: 'offPalette' })).toBeCloseTo(3 / 7, 6); // 7 non-transparent pixels, 3 off palette
    expect(await t.evalGraph(report.graph, report.id, { port: 'colors' })).toBe(5);
    const same = (await t.pixels((await t.evalGraph(report.graph, report.id, { port: 'image' })) as ImageValue)).at(2, 0);
    expect(same).toEqual([250, 10, 10, 255]); // report changes nothing
    const snap = await lockGraph(t, pic(t), PAL, { mode: 'snap' });
    expect(await t.evalGraph(snap.graph, snap.id, { port: 'offPalette' })).toBeCloseTo(3 / 7, 6);
    expect(await t.evalGraph(snap.graph, snap.id, { port: 'colors' })).toBe(2);
  });

  it('highlight paints the off-palette pixels magenta and leaves the others', async () => {
    const t = await harness();
    const { graph, id } = await lockGraph(t, pic(t), PAL, { mode: 'highlight' });
    const px = await t.pixels((await t.evalGraph(graph, id, { port: 'image' })) as ImageValue);
    expect(px.at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px.at(2, 0)).toEqual([255, 0, 255, 255]);
    expect(px.at(0, 1)).toEqual([255, 0, 255, 255]);
    expect(px.at(3, 0).slice(0, 3)).toEqual([255, 0, 255]);
  });

  it('a large picture is counted on a 128 px sample; report mode counts exactly', async () => {
    const t = await harness();
    const big = t.fromFn(256, 256, (x) => (x < 128 ? RED : [250, 0, 0, 255]));
    const approx = await lockGraph(t, big, PAL, { mode: 'highlight' });
    expect(Math.abs((await t.evalGraph(approx.graph, approx.id, { port: 'offPalette' })) as number - 0.5)).toBeLessThan(0.02);
    const exact = await lockGraph(t, big, PAL, { mode: 'report' });
    expect(await t.evalGraph(exact.graph, exact.id, { port: 'offPalette' })).toBe(0.5);
  });

  it('reads nothing back unless a number output is used', async () => {
    const t = await harness();
    const { graph, id } = await lockGraph(t, pic(t), PAL, { mode: 'snap' });
    const spy = (await import('vitest')).vi.spyOn(t.gpu, 'read');
    await t.evalGraph(graph, id, { port: 'image' });
    expect(spy).not.toHaveBeenCalled();
    await t.evalGraph(graph, id, { port: 'offPalette' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('works without a wired palette (built-in fallback)', async () => {
    const t = await harness();
    const o = await t.run('palette-lock', { mode: 'snap', builtin: 'pico-8' }, { image: t.fromFn(8, 8, (x, y) => [x * 30, y * 30, 100, 255]) });
    expect((await t.pixels(o.image as ImageValue)).at(3, 3)[3]).toBe(255);
  });
});
