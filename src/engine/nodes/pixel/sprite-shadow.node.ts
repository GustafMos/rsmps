import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';

/**
 * A shadow under a sprite, one pass, pixel crisp. The shadow is drawn BEHIND the sprite; the output has the size of the input, so leave room around the
 * sprite (or pad the canvas first) when the shadow reaches past the sprite.
 */
export default defineNode({
  id: 'sprite-shadow',
  title: 'Sprite Shadow',
  category: 'pixel',
  description:
    'Adds a shadow behind a sprite: a flat drop shadow (the silhouette moved by an offset), a ground shadow (the silhouette flattened and skewed along a ground line) or a contact blob (an ellipse under the feet). Hard pixels; transparency can be solid or a retro dither pattern. Works on the art grid.',
  keywords: ['shadow', 'drop shadow', 'ground shadow', 'contact shadow', 'blob', 'sprite', 'dither', 'retro transparency'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'drop',
      label: 'Shadow',
      options: [
        { value: 'drop', label: 'Drop shadow' },
        { value: 'ground', label: 'Ground shadow' },
        { value: 'contact', label: 'Contact blob' },
      ],
    },
    offset: { type: 'vec2', default: [1, 1], min: -64, max: 64, step: 1, unit: 'px', label: 'Offset', hint: 'Art pixels, x to the right, y down.', visibleIf: (p) => p.mode === 'drop' },
    ground: { type: 'number', default: 0.95, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Ground line', hint: 'Where the feet touch the ground, as a fraction of the picture height from the top.', visibleIf: (p) => p.mode !== 'drop' },
    squash: { type: 'number', default: 0.4, min: 0.05, max: 1.5, step: 0.01, label: 'Flatten', hint: 'Height of the shadow compared with the sprite.', visibleIf: (p) => p.mode === 'ground' },
    skew: { type: 'number', default: 0.5, min: -2, max: 2, step: 0.01, label: 'Skew', hint: 'Sideways lean of the shadow: pixels moved per pixel of height.', visibleIf: (p) => p.mode === 'ground' },
    toward: { type: 'bool', default: false, label: 'Toward viewer', hint: 'Cast the shadow downward (in front of the feet) instead of upward behind them.', visibleIf: (p) => p.mode === 'ground' },
    center: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Center', hint: 'Horizontal position of the blob, fraction of the picture width.', visibleIf: (p) => p.mode === 'contact' },
    blob: { type: 'vec2', default: [10, 3], min: 1, max: 512, step: 0.5, unit: 'px', label: 'Blob radius', hint: 'Half width and half height, art pixels.', visibleIf: (p) => p.mode === 'contact' },
    color: { type: 'color', default: [0, 0, 0, 1], label: 'Color' },
    opacity: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    pattern: {
      type: 'enum',
      default: 'solid',
      label: 'Transparency',
      options: [
        { value: 'solid', label: 'Solid blend' },
        { value: 'bayer', label: 'Dither' },
        { value: 'checker', label: 'Checkerboard' },
        { value: 'lines', label: 'Scan lines' },
      ],
      hint: 'Solid blend mixes the shadow color with what is behind it. The others keep the shadow fully opaque on some pixels only (retro look, no new colors): Dither follows Opacity, Checkerboard and Scan lines are half and half.',
    },
    only: { type: 'bool', default: false, label: 'Shadow only', hint: 'Output just the shadow, without the sprite.' },
  },
  summary: (p) => `${p.mode} · ${p.pattern}`,
  render(ctx) {
    const p = ctx.params;
    const image = withArtGrid(ctx.gpu, ctx.in.image, 0, (art, { toArt }) =>
      ctx.gpu.pass({
        label: 'sprite-shadow',
        size: art,
        textures: { src: art },
        uniforms: {
          mode: p.mode === 'drop' ? 0 : p.mode === 'ground' ? 1 : 2,
          offset: [Math.round(toArt(p.offset[0])), Math.round(toArt(p.offset[1]))],
          ground: p.ground,
          squash: p.squash,
          skew: p.skew,
          toward: p.toward,
          center: p.center,
          blob: [Math.max(0.5, toArt(p.blob[0])), Math.max(0.5, toArt(p.blob[1]))],
          color: p.color,
          opacity: p.opacity,
          pattern: p.pattern === 'solid' ? 0 : p.pattern === 'bayer' ? 1 : p.pattern === 'checker' ? 2 : 3,
          only: p.only,
        },
        wgsl: /* wgsl */ `
fn alphaAt(q: vec2f) -> f32 {
  let d = vec2i(textureDimensions(src));
  let i = vec2i(floor(q));
  if (i.x < 0 || i.y < 0 || i.x >= d.x || i.y >= d.y) { return 0.0; }
  return select(0.0, 1.0, textureLoad(src, i, 0).a >= 0.5);
}
fn bayer4(x: i32, y: i32) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(y & 3) * 4 + (x & 3)] + 0.5) / 16.0;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureLoad(src, vec2i(floor(px)), 0);
  let g = u.ground * u.size.y;
  var cov = 0.0;
  if (u.mode < 0.5) {
    cov = alphaAt(px - u.offset);
  } else if (u.mode < 1.5) {
    // ground: inverse map into the sprite. Height above the ground line h, shadow height h * squash.
    var up = g - px.y;
    if (u.toward > 0.5) { up = px.y - g; }
    if (up > 0.0) {
      let h = up / u.squash;
      let sp = vec2f(px.x - u.skew * up, g - h);
      cov = alphaAt(sp);
    }
  } else {
    let d = (px - vec2f(u.center * u.size.x, g)) / u.blob;
    cov = select(0.0, 1.0, dot(d, d) <= 1.0);
  }
  var a = 0.0;
  let ix = i32(floor(px.x));
  let iy = i32(floor(px.y));
  if (cov > 0.5) {
    if (u.pattern < 0.5) { a = u.color.a * u.opacity; }
    else if (u.pattern < 1.5) { a = select(0.0, u.color.a, bayer4(ix, iy) < u.opacity); }
    else if (u.pattern < 2.5) { a = select(0.0, u.color.a, ((ix + iy) & 1) == 0 && u.opacity > 0.0); }
    else { a = select(0.0, u.color.a, (iy & 1) == 0 && u.opacity > 0.0); }
  }
  let shadow = vec4f(u.color.rgb * a, a);
  if (u.only > 0.5) { return shadow; }
  return s + shadow * (1.0 - s.a);
}`,
      }),
    );
    return { image };
  },
});
