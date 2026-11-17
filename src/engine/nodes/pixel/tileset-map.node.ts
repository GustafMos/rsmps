import { defineNode } from '../../define';
import { BLOB47_INDEX, LAYOUTS, reduceMask, type TileLayout } from '../../lib/autotile';
import { assertTextureSize } from '../../lib/pixel-gpu';

export default defineNode({
  id: 'tileset-map',
  title: 'Tileset Map',
  category: 'pixel',
  description:
    'Paints a terrain picture from a mask: white = terrain. The mask is cut into square map cells; for each terrain cell the eight neighbors give a bitmask, the bitmask picks a tile of the tileset (as made by Autotile: 47 blob or 16 edge layout) and that tile is drawn. A blobby mask becomes a properly edged terrain.',
  keywords: ['autotile', 'tilemap', 'terrain', 'bitmask', 'paint', 'map', 'tileset', 'blob', 'wang', 'level', 'mask'],
  inputs: { terrain: { type: 'image', required: true, label: 'Terrain' }, tileset: { type: 'image', required: true, label: 'Tileset' } },
  outputs: { image: { type: 'image', label: 'Image' }, cellsX: { type: 'number', label: 'Cells X' }, cellsY: { type: 'number', label: 'Cells Y' } },
  params: {
    layout: {
      type: 'enum',
      default: 'blob47',
      label: 'Tileset',
      options: [
        { value: 'blob47', label: '47 tile blob' },
        { value: 'edge16', label: '16 tile edge' },
      ],
      hint: 'The layout of the wired tileset: the one Autotile writes.',
    },
    mapCell: { type: 'number', default: 1, min: 1, max: 512, softMax: 64, step: 1, integer: true, unit: 'px', label: 'Mask cell', hint: 'Pixels of the mask per map cell. 1 = every mask pixel is one tile (draw the map at tile resolution); 16 = a 256 pixel mask makes a 16 x 16 map.' },
    tileSize: { type: 'number', default: 0, min: 0, max: 1024, softMax: 128, step: 1, integer: true, unit: 'px', label: 'Tile size', hint: 'Art pixels per tile in the tileset. 0 = worked out from the tileset width and its layout.' },
    spacing: { type: 'number', default: 0, min: 0, max: 32, step: 1, integer: true, unit: 'px', label: 'Spacing', hint: 'Empty pixels between tiles in the tileset.' },
    outside: {
      type: 'enum',
      default: 'empty',
      label: 'Beyond the map',
      options: [
        { value: 'empty', label: 'Empty' },
        { value: 'terrain', label: 'Terrain' },
      ],
      hint: 'What counts as the neighbor past the map border: terrain makes the border cells continue off the picture without an edge.',
    },
    cutoff: { type: 'number', default: 0.5, min: 0.01, max: 0.99, step: 0.01, label: 'Cutoff', hint: 'A map cell is terrain when its mask brightness is above this.' },
  },
  summary: (p) => `${p.layout === 'blob47' ? '47' : '16'} tile map`,
  render(ctx) {
    const p = ctx.params;
    const mask = ctx.in.terrain;
    const set = ctx.in.tileset;
    const layout = p.layout as TileLayout;
    const info = LAYOUTS[layout];
    const s = Math.round(p.spacing);
    const T = p.tileSize > 0 ? Math.round(p.tileSize) : Math.floor((set.width - (info.columns - 1) * s) / info.columns);
    if (T < 1) throw new Error('The tileset picture is too small for this layout.');
    const cell = Math.max(1, Math.round(p.mapCell));
    const nx = Math.max(1, Math.round(mask.width / cell));
    const ny = Math.max(1, Math.round(mask.height / cell));
    const size = { width: nx * T, height: ny * T, unit: 1 };
    assertTextureSize(ctx.gpu, size.width, size.height, 'Tileset Map');
    // reduced mask (0..255) -> tile index (-1 = not a reduced mask), as a lookup row
    const inverse = new Float32Array(256 * 4).fill(-1);
    for (let m = 0; m < 256; m++) inverse[m * 4] = layout === 'blob47' ? BLOB47_INDEX[reduceMask(m)] : (m & 1 ? 1 : 0) | (m & 4 ? 2 : 0) | (m & 16 ? 4 : 0) | (m & 64 ? 8 : 0);
    const image = ctx.gpu.pass({
      label: 'tileset-map',
      size,
      textures: { terrain: mask, tiles: set, inv: ctx.gpu.dataTexture(inverse, 256, 1) },
      uniforms: { tile: T, spacing: s, cols: info.columns, cells: [nx, ny], cutoff: p.cutoff, cellPx: cell, outsideTerrain: p.outside === 'terrain', layoutBlob: layout === 'blob47' },
      wgsl: /* wgsl */ `
// is the map cell (cx, cy) terrain? mask brightness (premultiplied luma, so empty pixels are black) averaged over the cell, 3 x 3 taps
fn isTerrain(cx: i32, cy: i32) -> bool {
  if (cx < 0 || cy < 0 || cx >= i32(u.cells.x) || cy >= i32(u.cells.y)) { return u.outsideTerrain > 0.5; }
  let size = vec2f(textureDimensions(terrain));
  let origin = vec2f(f32(cx), f32(cy)) * size / u.cells;
  let span = size / u.cells;
  var sum = 0.0;
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 3; i++) {
      let q = (origin + (vec2f(f32(i), f32(j)) + 0.5) / 3.0 * span) / size;
      let c = textureSampleLevel(terrain, smpNearest, q, 0.0);
      sum += dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
    }
  }
  return sum / 9.0 > u.cutoff;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = i32(u.tile);
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let cx = x / t;
  let cy = y / t;
  if (!isTerrain(cx, cy)) { return vec4f(0.0); }
  var m = 0;
  if (isTerrain(cx, cy - 1)) { m |= 1; }
  if (isTerrain(cx + 1, cy - 1)) { m |= 2; }
  if (isTerrain(cx + 1, cy)) { m |= 4; }
  if (isTerrain(cx + 1, cy + 1)) { m |= 8; }
  if (isTerrain(cx, cy + 1)) { m |= 16; }
  if (isTerrain(cx - 1, cy + 1)) { m |= 32; }
  if (isTerrain(cx - 1, cy)) { m |= 64; }
  if (isTerrain(cx - 1, cy - 1)) { m |= 128; }
  let idx = i32(textureLoad(inv, vec2i(m, 0), 0).r + 0.5);
  if (idx < 0) { return vec4f(0.0); }
  let cols = i32(u.cols);
  let pitch = t + i32(u.spacing);
  let tx = (idx % cols) * pitch + (x - cx * t);
  let ty = (idx / cols) * pitch + (y - cy * t);
  return textureLoad(tiles, vec2i(tx, ty), 0);
}`,
    });
    return { image, cellsX: nx, cellsY: ny };
  },
});
