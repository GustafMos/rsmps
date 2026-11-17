import { defineNode } from '../../define';
import { COMPOSE_TILE_WGSL, LAYOUTS, layoutMasks, type TileLayout } from '../../lib/autotile';
import { assertTextureSize } from '../../lib/pixel-gpu';

/**
 * Source layout: five pieces of T x T pixels in ONE ROW, left to right (picture 5T x T):
 *
 *   1 center      2 edge          3 outer corner   4 inner corner   5 single
 *   terrain       terrain below,  terrain toward   terrain all      an isolated
 *   everywhere    empty above     the bottom right around, empty    tile, as it
 *                                 (empty N and W)  NW diagonal      should look alone
 *
 * See docs/GAME_ASSETS.md for the drawing.
 */
export default defineNode({
  id: 'autotile',
  title: 'Autotile',
  category: 'pixel',
  description:
    'Builds a full terrain tileset from five source pieces drawn in a row (center, edge, outer corner, inner corner, single): the 47-tile "blob" set or the 16-tile edge set, laid out in a documented grid. Every tile is put together from quarter tiles of the pieces, turned by whole quarter turns, so the pieces must be drawn with the edge on top and the corners at the top left. ' +
    'Pair it with Tileset Map to paint a terrain picture from a mask.',
  keywords: ['tileset', 'bitmask', 'blob', 'wang', '47', '16', 'terrain', 'rpg maker', 'godot terrain', 'autotile', 'tilemap', 'tiles', 'edge'],
  inputs: { image: { type: 'image', required: true, label: 'Pieces' } },
  outputs: { image: { type: 'image', label: 'Tileset' }, tiles: { type: 'number', label: 'Tiles' }, columns: { type: 'number', label: 'Columns' } },
  params: {
    mode: { type: 'enum', default: 'pieces', label: 'Input', options: [{ value: 'pieces', label: 'From 5 pieces' }], hint: 'Five equal squares in one row: center, edge, outer corner, inner corner, single.' },
    layout: {
      type: 'enum',
      default: 'blob47',
      label: 'Tileset',
      options: [
        { value: 'blob47', label: '47 tile blob' },
        { value: 'edge16', label: '16 tile edge' },
      ],
      hint: '47: every combination of 8 neighbors that looks different, 8 columns x 6 rows in ascending mask order. 16: the four edges only, 4 x 4, tile number = N + 2 E + 4 S + 8 W.',
    },
    tileSize: { type: 'number', default: 0, min: 0, max: 1024, softMax: 128, step: 1, integer: true, unit: 'px', label: 'Tile size', hint: 'Art pixels per tile. 0 = the height of the pieces picture.' },
    spacing: { type: 'number', default: 0, min: 0, max: 32, step: 1, integer: true, unit: 'px', label: 'Spacing', hint: 'Empty pixels between tiles in the output.' },
  },
  summary: (p) => `${p.layout === 'blob47' ? '47' : '16'} tiles`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const T = p.tileSize > 0 ? Math.round(p.tileSize) : src.height;
    if (T < 2) throw new Error('The tile size must be at least 2 pixels.');
    if (src.width < 5 * T || src.height < T) throw new Error(`The pieces picture must hold five ${T}x${T} pieces in a row (${5 * T}x${T}); it is ${src.width}x${src.height}.`);
    const layout = p.layout as TileLayout;
    const info = LAYOUTS[layout];
    const s = Math.round(p.spacing);
    const size = { width: info.columns * T + (info.columns - 1) * s, height: info.rows * T + (info.rows - 1) * s, unit: 1 };
    assertTextureSize(ctx.gpu, size.width, size.height, 'Autotile');
    const masks = layoutMasks(layout);
    const table = new Float32Array(info.columns * info.rows * 4).fill(-1);
    masks.forEach((m, i) => (table[i * 4] = m));
    const image = ctx.gpu.pass({
      label: 'autotile',
      size,
      textures: { src, tbl: ctx.gpu.dataTexture(table, info.columns * info.rows, 1) },
      uniforms: { tile: T, spacing: s, cols: info.columns },
      wgsl: /* wgsl */ `
${COMPOSE_TILE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = i32(u.tile);
  let pitch = t + i32(u.spacing);
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let col = x / pitch;
  let row = y / pitch;
  let lx = x - col * pitch;
  let ly = y - row * pitch;
  if (lx >= t || ly >= t) { return vec4f(0.0); }
  let m = textureLoad(tbl, vec2i(row * i32(u.cols) + col, 0), 0).r;
  if (m < 0.0) { return vec4f(0.0); }
  return composeTile(i32(m + 0.5), lx, ly, t);
}`,
    });
    return { image, tiles: info.count, columns: info.columns };
  },
});
