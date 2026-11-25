import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

/**
 * Depth scan: effects that travel through the DEPTH of a picture instead of across its surface. It needs a depth map
 * (how near every pixel is; wire in AI Depth, Depth Estimate, or any grey picture) next to the picture.
 *
 *   - Scan wave: a sheet of light at one distance from the camera, moving away or toward it. Only the pixels at that
 *     distance light up, so the sheet draws the outline of everything it passes, with an afterglow behind it.
 *   - Contours: lines of equal distance, like the height lines of a map, flowing through the scene.
 *   - Grid: a net of lines laid over the scene and pushed sideways by its depth, so it wraps round the shapes.
 *   - Dots: a field of points, larger where the scene is nearer: a laser-scanner point cloud.
 *   - Scanlines: horizontal lines whose thickness follows the depth and that the wave lights up as it passes.
 *
 * A line that follows the depth must have the same thickness on a steep wall as on a gentle slope, so its distance is
 * measured in pixels: the difference in depth divided by how fast the depth changes there (its slope).
 * Everything moves in whole cycles per loop.
 */
const STYLES = { wave: 0, contours: 1, grid: 2, dots: 3, lines: 4 } as const;
const SHOW = { over: 0, only: 1, reveal: 2, dim: 3 } as const;

export default defineNode({
  id: 'depth-scan',
  title: 'Depth Scan',
  category: 'filter',
  description: 'Scanner effects that move through the depth of a picture: a sheet of light sweeping from near to far, flowing contour lines, a grid or point cloud wrapped round the shapes. Wire a depth map (AI Depth or Depth Estimate) into Depth.',
  keywords: ['depth', 'scan', 'scanline', 'scanner', 'lidar', 'laser', 'hologram', 'contour', 'topographic', 'grid', 'point cloud', 'sweep', 'wave', 'sonar', 'radar', 'matrix', '3d scan', 'depth map', 'reveal', 'sci-fi', 'trippy'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    depth: { type: 'image', required: true, label: 'Depth' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    style: {
      type: 'enum',
      default: 'wave',
      options: [
        { value: 'wave', label: 'Scan wave' },
        { value: 'contours', label: 'Contours' },
        { value: 'grid', label: 'Grid' },
        { value: 'dots', label: 'Dots' },
        { value: 'lines', label: 'Scanlines' },
      ],
      label: 'Style',
    },
    show: {
      type: 'enum',
      default: 'over',
      options: [
        { value: 'over', label: 'Over the picture' },
        { value: 'dim', label: 'Over a dimmed picture' },
        { value: 'reveal', label: 'Reveals the picture' },
        { value: 'only', label: 'Effect only' },
      ],
      label: 'Picture',
      hint: 'Reveals the picture: black until the wave has passed, then the picture stays lit behind it for the length of the afterglow.',
    },
    sweep: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Sweeps per loop', hint: 'How many times the wave travels through the scene per loop. Above 0 goes from near to far, below 0 from far to near, 0 stands still at Position.' },
    position: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Position', hint: 'Where the wave stands (0 = nearest, 1 = farthest). Wire a number here, for example a sound level, to drive it yourself.', visibleIf: (p) => p.sweep === 0 },
    count: { type: 'number', default: 1, min: 1, max: 60, step: 1, integer: true, label: 'Waves', hint: 'How many waves (or contour lines) are in the scene at once.' },
    thickness: { type: 'number', default: 3, min: 0.5, max: 60, step: 0.5, unit: 'px', label: 'Line thickness' },
    trail: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Afterglow', hint: 'How long the scene stays lit behind the wave, as a share of the distance between two waves.', visibleIf: (p) => p.style !== 'contours' },
    cells: { type: 'number', default: 40, min: 4, max: 300, step: 1, integer: true, label: 'Density', hint: 'Grid lines, dots or scanlines across the picture height.', visibleIf: (p) => p.style === 'grid' || p.style === 'dots' || p.style === 'lines' },
    push: { type: 'number', default: 0.06, min: -0.5, max: 0.5, step: 0.005, label: 'Depth push', hint: 'How far near parts push the grid, dots or lines aside, so the pattern wraps round the shapes.', visibleIf: (p) => p.style === 'grid' || p.style === 'dots' || p.style === 'lines' },
    color: { type: 'color', default: [0.3, 1, 0.85, 1], label: 'Color' },
    rainbow: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Color by depth', hint: 'Shifts the colour with the distance: near and far get different hues.' },
    glow: { type: 'number', default: 0.6, min: 0, max: 3, step: 0.01, label: 'Glow' },
    intensity: { type: 'number', default: 1.2, min: 0, max: 4, step: 0.01, label: 'Brightness' },
    smooth: { type: 'number', default: 2, min: 0, max: 40, step: 0.5, unit: 'px', label: 'Smooth the depth', hint: 'Depth maps are rough at the edges; a little smoothing gives cleaner lines.' },
    invert: { type: 'bool', default: false, label: 'Dark is near', hint: 'Depth maps here are bright where the scene is near. Turn on for one made the other way round.' },
  },
  summary: (p) => `${p.style}${p.sweep ? ` · ${p.sweep} sweep${Math.abs(p.sweep) === 1 ? '' : 's'}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const rawDepth = ctx.in.depth;
    if (!src || !rawDepth) return { image: src };
    const depth = p.smooth > 0.05 ? gaussianBlur(ctx.gpu, rawDepth, (p.smooth * rawDepth.width) / src.width) : rawDepth;
    const sweep = Math.round(p.sweep);
    // the place of the wave, 0 = nearest .. 1 = farthest; it wraps, so a whole number of sweeps closes the loop
    const pos = sweep === 0 ? p.position : ctx.time.phase * sweep;
    const image = ctx.gpu.pass({
      label: 'depth-scan',
      size: src,
      textures: { src, depth },
      uniforms: {
        style: STYLES[p.style as keyof typeof STYLES] ?? 0,
        show: SHOW[p.show as keyof typeof SHOW] ?? 0,
        pos,
        still: sweep === 0,
        back: sweep < 0,
        count: Math.max(1, Math.round(p.count)),
        thick: Math.max(0.25, p.thickness * 0.5),
        trail: p.trail,
        cells: p.cells,
        push: p.push,
        color: p.color,
        rainbow: p.rainbow,
        glow: p.glow,
        gain: p.intensity,
        invert: p.invert,
      },
      wgsl: /* wgsl */ `
fn nearAt(uv: vec2f) -> f32 {
  let d = luma(unpremul(textureSampleLevel(depth, smp, uv, 0.0)).rgb);
  return mix(d, 1.0 - d, u.invert);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let pic = unpremul(s).rgb;
  let near = nearAt(uv);
  // how fast the depth changes here, per pixel: turns a difference in depth into a distance on screen
  let e = vec2f(1.5) / u.size;
  let gx = nearAt(uv + vec2f(e.x, 0.0)) - nearAt(uv - vec2f(e.x, 0.0));
  let gy = nearAt(uv + vec2f(0.0, e.y)) - nearAt(uv - vec2f(0.0, e.y));
  let slope = max(length(vec2f(gx, gy)) / 3.0, 0.0006);
  let far = 1.0 - near;            // 0 = nearest .. 1 = farthest, the way the wave counts
  let n = u.count;

  // the wave: w runs 0..1 between two waves, 0 just behind a wave front
  var w = fract((u.pos - far) * n);
  if (u.back > 0.5) { w = fract((far - u.pos) * n); }
  if (u.still > 0.5 && n < 1.5) {
    // one standing wave does not wrap: nothing is "behind" it at the far end of the scene
    w = clamp(abs(u.pos - far), 0.0, 1.0);
  }
  // distance to the nearest wave front, in pixels
  let frontPx = min(w, 1.0 - w) / (slope * n);
  let front = 1.0 - smoothstep(u.thick - 0.75, u.thick + 0.75, frontPx);
  let halo = exp(-frontPx / max(u.thick * 6.0, 1.0)) * u.glow;
  let after = exp(-w / max(u.trail * 0.5, 0.0001)) * step(0.0001, u.trail);

  var light = 0.0;
  var lit = after;   // how much of the picture the wave has uncovered
  let aspect = u.size.x / u.size.y;
  if (u.style < 0.5) {
    light = front + halo + after * 0.5;
  } else if (u.style < 1.5) {
    // contours: every line is a wave front; they flow as the position moves
    light = front + halo * 0.6;
    lit = 1.0;
  } else if (u.style < 2.5) {
    // grid: lines every 1 / cells of the height, shifted by the depth
    let g = (uv * vec2f(aspect, 1.0) + vec2f(near * u.push, near * u.push * 0.6)) * u.cells;
    let dg = abs(fract(g + 0.5) - 0.5) / u.cells * u.size.y;
    let lines = 1.0 - smoothstep(u.thick * 0.5 - 0.5, u.thick * 0.5 + 0.75, min(dg.x, dg.y));
    light = lines * (0.25 + 0.75 * after + front) + (front + halo) * 0.6;
  } else if (u.style < 3.5) {
    // dots: one per cell, larger where the scene is near
    let g = (uv * vec2f(aspect, 1.0) + vec2f(near * u.push, 0.0)) * u.cells;
    let c = (fract(g) - 0.5) / u.cells * u.size.y;
    let r = (0.12 + 0.36 * near) / u.cells * u.size.y;
    let dot = 1.0 - smoothstep(r - 0.75, r + 0.75, length(c));
    light = dot * (0.2 + 0.8 * after + front * 1.5);
  } else {
    // scanlines: thicker where the scene is near, lit by the wave
    let y = (uv.y + near * u.push) * u.cells;
    let dy = abs(fract(y) - 0.5) / u.cells * u.size.y;
    let half = (0.08 + 0.34 * near) / u.cells * u.size.y;
    let line = 1.0 - smoothstep(half - 0.5, half + 0.75, dy);
    light = line * (0.3 + 0.7 * after + front * 1.5) + halo * 0.4;
  }
  light *= u.gain;

  var tint = u.color.rgb;
  if (u.rainbow > 0.0) {
    var hsv = rgbToHsv(tint);
    hsv.x = fract(hsv.x + u.rainbow * far);
    hsv.y = max(hsv.y, 0.6 * u.rainbow);
    tint = hsvToRgb(hsv);
  }
  var base = pic;
  if (u.show > 0.5 && u.show < 1.5) { base = vec3f(0.0); }
  if (u.show > 1.5 && u.show < 2.5) { base = pic * clamp(lit, 0.0, 1.0); }
  if (u.show > 2.5) { base = pic * 0.3; }
  let rgb = clamp(base + tint * light, vec3f(0.0), vec3f(1.0));
  return premul(vec4f(rgb, s.a));
}`,
    });
    return { image };
  },
});
