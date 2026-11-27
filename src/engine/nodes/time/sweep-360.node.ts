import { defineNode } from '../../define';
import { PANO_WGSL } from '../../lib/pano';
import type { ImageValue } from '../../types';

/**
 * Sweep 360: paints a live camera picture into a 2:1 panorama canvas at the direction the camera points, like a photo sphere.
 *
 * Each frame, every canvas pixel becomes a direction on the sphere; that direction is turned into the camera's frame with Yaw, Pitch and
 * Roll, projected with a pinhole camera (View angle = horizontal field of view) and, where it lands inside the picture, the picture's
 * colour is painted over the canvas with a feathered edge. Everywhere else the canvas keeps what it had.
 *
 * State: the canvas is this node's own output of the previous frame (`usesPrevious`, `ctx.previous()`), kept in the hidden `carry` picture
 * as premultiplied colour + coverage (alpha = how painted a pixel is). The picture the user sees (`image`) is made from it each frame:
 * the Empty look decides what unpainted coverage shows, and Output decides whether it is the panorama, a tiny planet or a view.
 * This is the one place where a node cannot be a pure fold: a live sweep depends on where the phone WAS, which no later evaluation can
 * recompute. So a frame evaluated cold (a scrub, a jump, an evicted cache) starts from an empty canvas, by design. With Loop on, the first
 * frame continues from the last one (`wrap`), so the canvas never resets by itself.
 *
 * Direction conventions (lib/pano.ts): yaw positive = turning right, pitch positive = looking up, roll positive = clockwise.
 */
export const SWEEP360_EMPTY = { black: 0, transparent: 1, blur: 2 } as const;
export const SWEEP360_PAINT = { always: 0, fresh: 1, paused: 2 } as const;

const rad = (v: number): number => (v * Math.PI) / 180;
const outputIs = (...v: string[]) => (p: Record<string, unknown>) => v.includes(p.output as string);

/** The canvas pass: fade the old canvas, then paint the camera picture where the camera looks. State is premultiplied colour, a = coverage. */
function paintWgsl(hasPrev: boolean): string {
  return /* wgsl */ `
${PANO_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var old = vec4f(0.0);
  ${hasPrev ? 'old = textureSampleLevel(prev, smpNearest, uv, 0.0);' : ''}
  if (u.paint > 1.5) { return old; }
  if (u.fadeStep > 0.0 && old.a > 0.0) {
    let na = max(old.a - u.fadeStep, 0.0);
    old = old * (na / old.a);
  }
  let lon = (uv.x - 0.5) * TAU;
  let lat = (0.5 - uv.y) * PI;
  let dw = vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  // into the camera's frame: undo yaw, then pitch, then roll
  let dc = rotZ(rotX(rotY(dw, -u.yaw), -u.pitch), -u.roll);
  if (dc.z <= 0.0001) { return old; }
  let p = vec2f(dc.x / dc.z / u.tH, dc.y / dc.z / u.tV);
  let m = min(1.0 - abs(p.x), 1.0 - abs(p.y));
  if (m < 0.0) { return old; }
  var w = 1.0;
  if (u.soft > 0.0) { w = smoothstep(0.0, u.soft, m); }
  if (u.paint > 0.5) { w = w * (1.0 - old.a); }
  var q = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (u.mirror > 0.5) { q.x = 1.0 - q.x; }
  let c = textureSampleLevel(pic, smp, q, 0.0);
  return max(old * (1.0 - w * c.a) + c * w, vec4f(0.0));
}`;
}

/** What the viewer sees: the canvas seen as panorama, planet or a view, with the Empty look under unpainted areas. */
function showWgsl(blur: boolean): string {
  return /* wgsl */ `
${PANO_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var d = panoView(uv, i32(u.mode));
  if (u.follow > 0.5) { d = rotY(rotX(rotZ(d, u.roll), u.pitch), u.yaw); }
  let lon = atan2(d.x, d.z);
  let lat = asin(clamp(d.y, -1.0, 1.0));
  let q = vec2f(lon / TAU + 0.5, 0.5 - lat / PI);
  let s = textureSampleLevel(canvas, smp, q, 0.0);
  ${
    blur
      ? `let b = textureSampleLevel(fill, smp, q, 0.0);
  let tt = smoothstep(0.0, 0.01, b.a);
  let fc = mix(vec3f(0.1), b.rgb / max(b.a, 0.0001), tt);
  return vec4f(s.rgb + fc * (1.0 - s.a), 1.0);`
      : `if (u.empty < 0.5) { return vec4f(s.rgb, 1.0); }
  return s;`
  }
}`;
}

const FILL_W = 64;
const FILL_H = 32;

export default defineNode({
  id: 'sweep-360',
  title: 'Sweep 360',
  category: 'time',
  description:
    "Paints a live camera picture into a 360 panorama as you turn, like a photo sphere. Wire the camera picture and the phone's Yaw, Pitch and Roll (Phone Motion with Sensors from: This device). The part in view is live and everything painted earlier stays. It relies on the phone's motion sensors, so it drifts over time and seams are only as good as the sensors. Only the area currently pointed at is live, the rest is an old snapshot. The canvas is built frame by frame, so jumping in time starts it empty.",
  keywords: ['360', 'panorama', 'photo sphere', 'photosphere', 'sweep', 'gyro', 'equirectangular', 'phone', 'camera', 'stitch', 'tiny planet', 'look around', 'live', 'paint', 'accumulate'],
  guide: {
    does: 'Paints a live camera picture into a 360 panorama while you turn the phone.',
    steps: [
      'Wire the camera picture into Image.',
      'Wire Phone Motion Yaw, Pitch and Roll into the Yaw, Pitch and Roll settings (Phone Motion with Sensors from: This device).',
      'Turn slowly: the part in view is live and what you painted earlier stays.',
    ],
    needs: [
      { input: 'image', hint: 'The live camera picture.' },
    ],
    seeAlso: ['fake-360', 'phone-motion'],
  },
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  usesPrevious: true,
  // Only the canvas size starts a new canvas. Toggling Paint, Mirror, Output etc. while sweeping must keep what was painted.
  previousKey: ['height'],
  params: {
    yaw: { type: 'number', default: 0, min: -100000, max: 100000, softMax: 360, step: 0.1, unit: 'deg', label: 'Yaw', hint: 'Which way the camera points, left and right. Turning right is positive. Wire Phone Motion Yaw here.' },
    pitch: { type: 'number', default: 0, min: -100000, max: 100000, softMax: 90, step: 0.1, unit: 'deg', label: 'Pitch', hint: 'Looking up is positive. Wire Phone Motion Pitch here.' },
    roll: { type: 'number', default: 0, min: -100000, max: 100000, softMax: 180, step: 0.1, unit: 'deg', label: 'Roll', hint: 'Tilting the phone clockwise is positive. Wire Phone Motion Roll here.' },
    view: { type: 'number', default: 70, min: 20, max: 170, step: 0.5, unit: 'deg', label: 'View angle', hint: 'How wide the camera sees, left to right. Phones are about 65 to 80, an ultrawide about 120. A wrong value makes the patches pile up or leave gaps.' },
    soft: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Edge softness', hint: 'How far in from the picture edge the paint fades out, so strokes blend. 0 is a hard edge.' },
    paint: {
      type: 'enum',
      default: 'always',
      options: [
        { value: 'always', label: 'Always' },
        { value: 'fresh', label: 'Only new areas' },
        { value: 'paused', label: 'Paused' },
      ],
      label: 'Paint',
      hint: 'Always: the part in view is live and replaces what was there. Only new areas: paints just where nothing was painted yet, so earlier snapshots stay. Paused: nothing changes.',
    },
    fade: { type: 'number', default: 0, min: 0, max: 100, softMax: 30, step: 0.1, label: 'Fade old', hint: 'Percent of the canvas that fades back to the Empty look every second where it is not being painted. 0 keeps everything forever.' },
    empty: {
      type: 'enum',
      default: 'black',
      options: [
        { value: 'black', label: 'Black' },
        { value: 'transparent', label: 'Transparent' },
        { value: 'blur', label: 'Blurred fill' },
      ],
      label: 'Empty look',
      hint: 'What unpainted areas show. Blurred fill: a very soft, low resolution blur of what is painted so far.',
    },
    clear: { type: 'number', default: 0, min: 0, max: 1, step: 1, label: 'Clear', hint: 'Wipes the canvas on every frame while this is above 0. Wire a tap or a button here, or set 1 and back to 0.' },
    mirror: { type: 'bool', default: false, label: 'Mirror picture', hint: 'Flips the camera picture left to right before painting. Turn on for the selfie camera.' },
    height: {
      type: 'enum',
      default: '1024',
      options: [
        { value: '512', label: '512 x 1024' },
        { value: '1024', label: '1024 x 2048' },
        { value: '2048', label: '2048 x 4096' },
      ],
      label: 'Canvas height',
      hint: 'Size of the panorama canvas, height by width. Larger is sharper and uses more memory. Changing it empties the canvas.',
    },
    output: {
      type: 'enum',
      default: 'panorama',
      options: [
        { value: 'panorama', label: '360 panorama 2:1' },
        { value: 'planet', label: 'Tiny planet' },
        { value: 'look', label: 'Look around' },
        { value: 'follow', label: 'Follow phone' },
      ],
      label: 'Output',
      hint: 'Follow phone looks at the canvas the way the phone points, with a wider view, so the live picture is seen surrounded by what was painted before.',
    },
    zoom: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.01, label: 'Planet zoom', visibleIf: outputIs('planet') },
    lookTurn: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Look turn', hint: 'Which way the look-around camera faces, left and right.', visibleIf: outputIs('look') },
    lookTilt: { type: 'number', default: 0, min: -90, max: 90, step: 0.5, unit: 'deg', label: 'Look tilt', hint: 'Which way it faces, up and down.', visibleIf: outputIs('look') },
    lookView: { type: 'number', default: 110, min: 20, max: 150, step: 0.5, unit: 'deg', label: 'Look view angle', hint: 'How wide the look-around view sees. For Follow phone use more than View angle to see the surroundings.', visibleIf: outputIs('look', 'follow') },
  },
  summary: (p) => `${p.view}° · ${p.paint} · ${p.output}`,
  render(ctx) {
    const p = ctx.params;
    const pic = ctx.in.image;
    const gpu = ctx.gpu;
    if (!pic) return { image: pic };
    const H = Number(p.height) || 1024;
    const W = H * 2;
    const unit = pic.unit * (H / pic.height);
    const fits = (v: ImageValue | null): v is ImageValue => !!v && v.width === W && v.height === H;
    // The canvas of the last frame. A Clear above 0, a new canvas size or a cold start leave it empty.
    const last = p.clear > 0 ? null : ctx.previous({ wrap: true, carry: true });
    const prev = fits(last) ? last : null;

    const fps = Math.max(1, ctx.time.fps);
    const fadeStep = p.fade > 0 ? Math.min(1, Math.max(p.fade / 100 / fps, 0.0005)) : 0;
    const tH = Math.tan(rad(Math.min(170, Math.max(20, p.view))) / 2);
    const state = gpu.pass({
      label: 'sweep-360 paint',
      size: { width: W, height: H, unit },
      format: 'rgba16float',
      textures: prev ? { pic, prev } : { pic },
      uniforms: {
        yaw: rad(p.yaw),
        pitch: rad(p.pitch),
        roll: rad(p.roll),
        tH,
        tV: tH / (pic.width / pic.height),
        soft: p.soft,
        paint: SWEEP360_PAINT[p.paint as keyof typeof SWEEP360_PAINT] ?? 0,
        fadeStep,
        mirror: p.mirror ? 1 : 0,
        zoom: 1,
        lookView: 0,
        lookTurn: 0,
        lookTilt: 0,
      },
      wgsl: paintWgsl(!!prev),
    });

    // Blurred fill: a tiny copy of the canvas, spread out by a few wide 3x3 blurs; read back as colour / coverage.
    const empty = SWEEP360_EMPTY[p.empty as keyof typeof SWEEP360_EMPTY] ?? 0;
    let fill: ImageValue | null = null;
    if (empty === 2) {
      const small = { width: FILL_W, height: FILL_H, unit: 1 };
      fill = gpu.pass({
        label: 'sweep-360 fill',
        size: small,
        format: 'rgba16float',
        textures: { src: state },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  for (var j = 0; j < 6; j++) {
    for (var i = 0; i < 6; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / 6.0 - 0.5;
      acc += textureSampleLevel(src, smp, uv + o / vec2f(${FILL_W}.0, ${FILL_H}.0), 0.0);
    }
  }
  return acc / 36.0;
}`,
      });
      for (const k of [1, 2, 4, 8, 16]) {
        const next: ImageValue = gpu.pass({
          label: 'sweep-360 fill blur',
          size: small,
          format: 'rgba16float',
          textures: { src: fill },
          uniforms: { k },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let w = select(1.0, select(2.0, 4.0, i == 0 && j == 0), i == 0 || j == 0);
      let o = vec2f(f32(i), f32(j)) * u.k / vec2f(${FILL_W}.0, ${FILL_H}.0);
      let q = vec2f(fract(uv.x + o.x), clamp(uv.y + o.y, 0.0, 1.0));
      acc += textureSampleLevel(src, smp, q, 0.0) * w;
      wsum += w;
    }
  }
  return acc / wsum;
}`,
        });
        gpu.recycle(fill);
        fill = next;
      }
    }

    const out = p.output as string;
    const mode = out === 'planet' ? 1 : out === 'look' || out === 'follow' ? 2 : 0;
    let width = W;
    let height = H;
    if (out === 'planet') width = H;
    else if (mode === 2) {
      width = pic.width;
      height = pic.height;
    }
    const follow = out === 'follow';
    const image = gpu.pass({
      label: 'sweep-360 show',
      size: { width, height, unit: pic.unit * (height / pic.height) },
      textures: fill ? { canvas: state, fill } : { canvas: state },
      uniforms: {
        mode,
        follow: follow ? 1 : 0,
        empty: empty === 1 ? 1 : 0,
        yaw: rad(p.yaw),
        pitch: rad(p.pitch),
        roll: rad(p.roll),
        zoom: p.zoom,
        lookView: rad(p.lookView),
        lookTurn: follow ? 0 : rad(p.lookTurn),
        lookTilt: follow ? 0 : rad(p.lookTilt),
      },
      wgsl: showWgsl(!!fill),
    });
    if (fill) gpu.recycle(fill);
    return { image, carry: state } as never;
  },
});
