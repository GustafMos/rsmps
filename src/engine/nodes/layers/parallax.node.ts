import { defineNode } from '../../define';
import type { ImageValue } from '../../types';

const MOTIONS = [
  { value: 'sway-h', label: 'Sway horizontal' },
  { value: 'sway-v', label: 'Sway vertical' },
  { value: 'circle', label: 'Circle' },
  { value: 'figure-eight', label: 'Figure eight' },
  { value: 'push', label: 'Push in / out' },
  { value: 'manual', label: 'Manual (camera params)' },
] as const;

const MAX_LAYERS = 8;

/**
 * 2.5D parallax. A virtual camera moves; every layer shifts opposite to the camera by an amount proportional to its
 * nearness, so the background barely moves and the front layer moves the most. Layers are full-frame images (usually
 * cutouts with alpha, e.g. from `split-layers` / `depth-slice`), stacked back to front on the background.
 * The auto motions are driven by `ctx.time.phase` with a whole number of `cycles`, so they loop exactly.
 */
export default defineNode({
  id: 'parallax',
  title: 'Parallax',
  category: 'composite',
  description:
    'Animates a virtual camera over a background and cutout layers (back to front) so nearer layers move more: a looping 2.5D parallax. Manual mode lets you drive the camera yourself.',
  keywords: ['2.5d', 'depth', 'camera', 'layers', 'sway', 'ken burns', 'loop', 'dolly', 'motion'],
  inputs: {
    background: { type: 'image', required: true, label: 'Background' },
    layers: { type: 'image', multi: true, label: 'Layers (back to front)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    motion: { type: 'enum', default: 'sway-h', options: MOTIONS, label: 'Motion' },
    amount: { type: 'number', default: 24, min: 0, max: 500, step: 0.5, unit: 'px', label: 'Amount', hint: 'Camera travel; the nearest layer moves by this much.', visibleIf: (p) => p.motion !== 'manual' },
    cycles: { type: 'number', default: 1, min: 1, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Cycles per loop', visibleIf: (p) => p.motion !== 'manual' },
    cameraX: { type: 'number', default: 0, min: -500, max: 500, step: 0.5, unit: 'px', label: 'Camera X', visibleIf: (p) => p.motion === 'manual' },
    cameraY: { type: 'number', default: 0, min: -500, max: 500, step: 0.5, unit: 'px', label: 'Camera Y', visibleIf: (p) => p.motion === 'manual' },
    cameraZoom: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Camera zoom', hint: 'Push in (+) or out (-). Nearer layers scale more.', visibleIf: (p) => p.motion === 'manual' },
    spread: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Depth spread', group: 'Depth', hint: '0 = everything moves together, 1 = front layer moves by the full amount, above 1 exaggerates.' },
    backgroundMotion: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Background motion', group: 'Depth', hint: 'Share of the camera motion the background follows.' },
    overscan: { type: 'number', default: 0, min: 0, max: 50, step: 0.1, unit: '%', label: 'Extra overscan', group: 'Edges' },
    autoFit: { type: 'bool', default: true, label: 'Auto overscan', group: 'Edges', hint: 'Scales each layer just enough that its shifted edges never show.' },
    rotation: { type: 'number', default: 0, min: -15, max: 15, step: 0.05, unit: 'deg', label: 'Rotation', group: 'Edges', hint: 'Subtle tilt that follows the camera (scaled by depth).' },
  },
  summary: (p) => `${p.motion} · ${p.amount} px`,
  render(ctx) {
    const bg = ctx.in.background;
    const layers = (ctx.in.layers as ImageValue[]).slice(0, MAX_LAYERS);
    const p = ctx.params;

    // Camera at the current time.
    let cx = 0;
    let cy = 0;
    let zoom = 0;
    if (p.motion === 'manual') {
      cx = p.cameraX;
      cy = p.cameraY;
      zoom = p.cameraZoom;
    } else {
      const a = Math.PI * 2 * p.cycles * ctx.time.phase;
      const side = Math.min(bg.width, bg.height);
      switch (p.motion) {
        case 'sway-h':
          cx = Math.sin(a) * p.amount;
          break;
        case 'sway-v':
          cy = Math.sin(a) * p.amount;
          break;
        case 'circle':
          cx = Math.sin(a) * p.amount;
          cy = Math.cos(a) * p.amount - p.amount;
          break;
        case 'figure-eight':
          cx = Math.sin(a) * p.amount;
          cy = Math.sin(2 * a) * p.amount * 0.5;
          break;
        case 'push':
          zoom = (Math.sin(a) * p.amount) / (side * 0.5);
          break;
      }
    }
    const rotRef = p.motion === 'manual' ? bg.width * 0.05 : Math.max(p.amount, 1e-3);
    const rotBase = (p.rotation * Math.PI) / 180;
    const travel = p.motion === 'manual' ? Math.max(Math.abs(p.cameraX), Math.abs(p.cameraY)) : p.motion === 'push' ? 0 : p.amount * (p.motion === 'circle' ? 2 : 1);
    const zoomTravel = p.motion === 'manual' ? Math.abs(p.cameraZoom) : p.motion === 'push' ? p.amount / (Math.min(bg.width, bg.height) * 0.5) : 0;

    // Per-layer transform: factor 0..~3 (how much the layer follows the camera).
    const count = layers.length;
    const factor = (i: number) => p.backgroundMotion + p.spread * (1 - p.backgroundMotion) * (i < 0 ? 0 : (i + 1) / count);
    const transform = (i: number): [number, number, number, number] => {
      const f = factor(i);
      const rotNorm = p.motion === 'push' ? 0 : Math.max(-1, Math.min(1, cx / rotRef));
      const rot = rotBase * rotNorm * f;
      const sx = -cx * f;
      const sy = -cy * f;
      let scale = 1 + zoom * f + p.overscan / 100;
      if (p.autoFit) {
        const fit = Math.max((2 * travel * f) / bg.width, (2 * travel * f) / bg.height) + zoomTravel * f + Math.abs(rotBase) * f * 1.2;
        scale = Math.max(scale, 1 + fit + p.overscan / 100);
      }
      return [sx, sy, Math.max(0.05, scale), rot];
    };

    const uniforms: Record<string, number[]> = { tb: transform(-1) };
    layers.forEach((_, i) => (uniforms[`t${i}`] = transform(i)));
    const textures: Record<string, ImageValue> = { bg };
    layers.forEach((l, i) => (textures[`l${i}`] = l));

    const layerCode = layers
      .map(
        (_, i) => `
  {
    let q = tf(uv, u.t${i});
    if (q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0) {
      let c = textureSampleLevel(l${i}, smp, q, 0.0);
      col = c + col * (1.0 - c.a);
    }
  }`,
      )
      .join('');

    const image = ctx.gpu.pass({
      label: 'parallax',
      size: bg,
      textures,
      uniforms,
      wgsl: /* wgsl */ `
fn tf(uv: vec2f, t: vec4f) -> vec2f {
  var p = (uv - 0.5) * u.size - t.xy;
  let c = cos(t.w);
  let s = sin(t.w);
  p = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
  p = p / t.z;
  return p / u.size + 0.5;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var col = textureSampleLevel(bg, smp, tf(uv, u.tb), 0.0);
  ${layerCode}
  return col;
}`,
    });
    return { image };
  },
});
