import { defineNode } from '../../define';
import { PIXEL_SIZE_PARAM, withArtGrid } from '../../lib/art-grid';
import type { ImageValue } from '../../types';
import { FIELD_CAP, PROFILE_ID, SHAPE_ID, silhouetteField, surfaceWgsl } from '../../lib/gen-surface2d';

const SOURCE = { luma: SHAPE_ID.luma, alpha: SHAPE_ID.bevel, height: SHAPE_ID.height } as const;

export default defineNode({
  id: 'normal-map',
  title: 'Normal Map',
  category: 'filter',
  description:
    'Turns a picture, its silhouette or a height picture into a normal map (the blue-purple picture that tells a light which way each pixel faces). Wire it into the Normal map input of Material 2D, a Material node or a game engine to light flat sprites. Pixel art mode works per art pixel and can snap the tilt to 4 or 8 directions for clean sprite normals. Flat = (0.5, 0.5, 1).',
  keywords: ['normal', 'bump', 'height to normal', 'sprite lighting', 'relief', 'emboss', 'displacement', 'height map', 'game asset', 'lit sprite', 'tangent space'],
  inputs: { image: { type: 'image', required: true, label: 'Image' }, height: { type: 'image', label: 'Height' } },
  outputs: { image: { type: 'image', label: 'Normal map' } },
  params: {
    source: {
      type: 'enum',
      default: 'luma',
      label: 'Height from',
      hint: 'Brightness raises what is bright. Shape bevel rounds the silhouette (the picture\'s transparency). Height input uses the picture wired to Height (white = high); without one it falls back to brightness.',
      options: [
        { value: 'luma', label: 'Brightness' },
        { value: 'alpha', label: 'Shape bevel' },
        { value: 'height', label: 'Height input' },
      ],
    },
    strength: { type: 'number', default: 6, min: 0, max: 200, softMax: 60, step: 0.1, unit: 'px', label: 'Strength', hint: 'Height of white above black (Shape bevel: height of the bevel), in pixels. Bigger = steeper normals.' },
    bevelWidth: { type: 'number', default: 8, min: 0.5, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Bevel width', visibleIf: (p) => p.source === 'alpha' },
    blur: { type: 'number', default: 1, min: 0, max: 60, softMax: 20, step: 0.1, unit: 'px', label: 'Smoothing', hint: 'Softens the height before the slopes are taken: removes noise and 8-bit stair steps.', visibleIf: (p) => p.source !== 'alpha' },
    invert: { type: 'bool', default: false, label: 'Invert height', hint: 'Swaps bumps and dents.' },
    convention: {
      type: 'enum',
      default: 'opengl',
      label: 'Green channel',
      group: 'Format',
      hint: 'OpenGL: green points up (Unity, Godot, Blender, Material 2D). DirectX: green points down (Unreal). A normal map used the wrong way round looks lit from the opposite side vertically.',
      options: [
        { value: 'opengl', label: 'OpenGL, Y up' },
        { value: 'directx', label: 'DirectX, Y down' },
      ],
    },
    directions: {
      type: 'enum',
      default: 'smooth',
      label: 'Tilt directions',
      group: 'Pixel art',
      hint: 'Snap the direction each pixel tilts to 8 or 4 compass directions: clean, readable normals on sprites. Use it with an art grid (Pixelate) or a Pixel size.',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'eight', label: '8 directions' },
        { value: 'four', label: '4 directions' },
      ],
    },
    pixelSize: { ...PIXEL_SIZE_PARAM, group: 'Pixel art' },
    tile: { type: 'bool', default: false, label: 'Tileable edges', group: 'Format', hint: 'Wraps around the picture edges so a repeating texture gets a normal map that repeats without a seam.' },
  },
  summary: (p) => `${p.source}${p.directions !== 'smooth' ? ` · ${p.directions === 'eight' ? 8 : 4} directions` : ''}${p.convention === 'directx' ? ' · DirectX' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.in.image;
    const heightTex = p.source === 'height' ? ctx.in.height : null;
    const source = p.source === 'height' && !heightTex ? 'luma' : p.source;
    const mode = SOURCE[source as keyof typeof SOURCE];
    const sign = p.invert ? -1 : 1;
    const out = withArtGrid(ctx.gpu, image, p.pixelSize, (art, grid) => {
      const gpu = ctx.gpu;
      let fld: ImageValue | null = null;
      let occ: ImageValue | null = null;
      let cellTex = 1;
      if (mode === SHAPE_ID.bevel) {
        const f = silhouetteField(gpu, art, grid.active ? Math.max(FIELD_CAP.normal, 512) : FIELD_CAP.normal, grid.active);
        fld = f.fld;
        occ = f.occ;
        cellTex = f.cellTex;
      }
      const res = gpu.pass({
        label: `normal-map ${fld ? 'bevel' : heightTex ? 'height' : 'luma'}`,
        size: art,
        uniforms: {
          shapeMode: mode,
          profile: PROFILE_ID.round,
          widthPx: Math.max(0.5, grid.toArt(p.bevelWidth)),
          hScale: p.strength * sign,
          smoothR: Math.max(1, grid.toArt(p.blur)),
          detail: 0,
          nStrength: 0,
          flipY: 1,
          cellTex,
          tile: p.tile ? 1 : 0,
          dirs: p.directions === 'eight' ? 1 : p.directions === 'four' ? 2 : 0,
          yFlip: p.convention === 'directx' ? -1 : 1,
        },
        textures: { src: art, fld, hgt: heightTex },
        wgsl: /* wgsl */ `
${surfaceWgsl({ hasField: !!fld, hasHeight: !!heightTex, hasNormal: false })}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let ss = surfSlope(uv);
  var sx = ss.x;
  var sy = ss.y;
  if (u.dirs > 0.5) {
    // clean sprite normals: the direction of the tilt snaps to 8 or 4 compass points; faint tilts become flat
    let m = length(vec2f(sx, sy));
    if (m < 0.03) {
      sx = 0.0;
      sy = 0.0;
    } else {
      let step = TAU / select(8.0, 4.0, u.dirs > 1.5);
      let q = round(atan2(sy, sx) / step) * step;
      sx = cos(q) * m;
      sy = sin(q) * m;
    }
  }
  let n = normalize(vec3f(-sx, -sy, 1.0));
  return vec4f(n.x * 0.5 + 0.5, n.y * u.yFlip * 0.5 + 0.5, n.z * 0.5 + 0.5, 1.0);
}`,
      });
      if (fld) gpu.recycle(fld);
      if (occ) gpu.recycle(occ);
      return res;
    });
    return { image: out };
  },
});
