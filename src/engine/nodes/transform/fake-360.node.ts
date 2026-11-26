import { defineNode } from '../../define';
import { PANO_WGSL } from '../../lib/pano';

/**
 * Fake 360: builds a full sphere (an equirectangular panorama, 2:1) from one or two ordinary pictures.
 *
 * How: every output pixel becomes a direction on the sphere. The front picture is a pinhole view looking at longitude 0,
 * the back picture the same at longitude 180 degrees. Where a direction falls inside a picture's view the picture is
 * sampled exactly (a true reprojection, straight lines stay straight inside the view). Elsewhere the gap is filled:
 * the picture's edge smeared round the sphere, the picture reflected again and again, or the edge smeared and blurred
 * more the further it goes. The front fill and the back fill are crossfaded over the seam, and the poles fade to the
 * average colour of the top and bottom of the pictures, so nothing pinches.
 *
 * Only the pixels the cameras really saw are real; the rest is invented fill. The node says so in its description.
 */
export const FAKE360_FILLS = { stretch: 0, mirror: 1, blur: 2, blend: 3 } as const;
export const FAKE360_OUTPUTS = { panorama: 0, planet: 1, look: 2 } as const;

/** Height of the panorama: the front picture's height, capped so that 2:1 stays a sensible texture. */
export const fake360Height = (frontHeight: number): number => Math.max(2, Math.min(4096, Math.round(frontHeight)));

function fake360Wgsl(hasBack: boolean): string {
  return /* wgsl */ `
${PANO_WGSL}
struct Cam { col: vec4f, real: f32 }

// reflect x back and forth between -h and h
fn tri(x: f32, h: f32) -> f32 {
  let per = 4.0 * h;
  let m = (x + h) - per * floor((x + h) / per);
  if (m < 2.0 * h) { return m - h; }
  return 3.0 * h - m;
}
fn smpCam(isBack: bool, uv: vec2f) -> vec4f {
  var q = clamp(uv, vec2f(0.0), vec2f(1.0));
  if (isBack) {
    if (u.flipBack > 0.5) { q.x = 1.0 - q.x; }
    ${hasBack ? 'return textureSampleLevel(back, smp, q, 0.0);' : 'return textureSampleLevel(front, smp, q, 0.0);'}
  }
  return textureSampleLevel(front, smp, q, 0.0);
}
// the average colour of the top (north) or bottom strip of a picture
fn strip(isBack: bool, north: bool) -> vec4f {
  var acc = vec4f(0.0);
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 8; i++) {
      var y = 0.02 + 0.05 * f32(j);
      if (!north) { y = 1.0 - y; }
      acc += smpCam(isBack, vec2f((f32(i) + 0.5) / 8.0, y));
    }
  }
  return acc / 24.0;
}
fn camera(dw: vec3f, isBack: bool) -> Cam {
  var d = dw;
  var hh = u.frontHalf;
  var asp = u.frontAsp;
  if (isBack) {
    d = vec3f(-d.x, d.y, -d.z);
    hh = u.backHalf;
    asp = u.backAsp;
  }
  let tH = tan(hh);
  let tV = tH / asp;
  let a = atan2(d.x, d.z);
  let e = atan2(d.y, length(vec2f(d.x, d.z)));
  var r: Cam;
  if (d.z > 1.0e-4) {
    let p = vec2f(d.x / d.z / tH, d.y / d.z / tV);
    if (abs(p.x) <= 1.0 && abs(p.y) <= 1.0) {
      r.real = 1.0;
      r.col = smpCam(isBack, vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
      return r;
    }
  }
  r.real = 0.0;
  let mode = i32(u.fill);
  if (mode == 1) {
    // mirror: reflect the angle across the picture's sides, then the height across its top and bottom
    let am = tri(a, hh);
    let py = tri(tan(e) / cos(am) / tV, 1.0);
    r.col = smpCam(isBack, vec2f(tan(am) / tH * 0.5 + 0.5, 0.5 - py * 0.5));
    return r;
  }
  // stretch the edge: the angle is held at the picture's side, the height at its top or bottom
  let ac = clamp(a, -hh, hh);
  let p = vec2f(tan(ac) / tH, clamp(tan(e) / cos(ac) / tV, -1.0, 1.0));
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (mode >= 2) {
    // blur out: the further the direction is from the picture, the wider the spread of the taps
    let dc = normalize(vec3f(p.x * tH, p.y * tV, 1.0));
    let ex = acos(clamp(dot(normalize(d), dc), -1.0, 1.0));
    var rad = 0.3 * smoothstep(0.0, 1.8, ex);
    if (mode == 3) { rad = rad * 0.3; }
    var acc = vec4f(0.0);
    for (var i = 0; i < 64; i++) {
      let rr = sqrt((f32(i) + 0.5) / 64.0);
      let th = f32(i) * 2.3999632;
      acc += smpCam(isBack, uv + vec2f(cos(th), sin(th) * asp) * rr * rad);
    }
    r.col = acc / 64.0;
    return r;
  }
  r.col = smpCam(isBack, uv);
  return r;
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let outMode = i32(u.output);
  var d = panoView(uv, outMode);
  // the whole sphere: turned, then tilted
  d = rotY(rotX(d, -u.tilt), -u.turn);

  let F = camera(d, false);
  let B = camera(d, true);
  let angF = acos(clamp(d.z, -1.0, 1.0));
  let wf = smoothstep(-u.seamHalf, u.seamHalf, PI - 2.0 * angF);
  var col: vec4f;
  if (F.real > 0.5 && B.real < 0.5) {
    col = F.col;
  } else if (B.real > 0.5 && F.real < 0.5) {
    col = B.col;
  } else {
    col = mix(B.col, F.col, wf);
    if (F.real < 0.5 && B.real < 0.5) {
      // poles: fade to the average colour of the pictures' top or bottom, so the fill never pinches
      let lat = asin(clamp(d.y, -1.0, 1.0));
      let pole = smoothstep(1.0, 1.45, abs(lat));
      if (pole > 0.0) {
        let north = lat > 0.0;
        let avg = 0.5 * (strip(false, north) + strip(true, north));
        col = mix(col, avg, pole);
      }
    }
  }
  return col;
}`;
}

const rad = (v: number): number => (v * Math.PI) / 180;
const isPlanet = (p: Record<string, unknown>) => p.output === 'planet';
const isLook = (p: Record<string, unknown>) => p.output === 'look';

export default defineNode({
  id: 'fake-360',
  title: 'Fake 360',
  category: 'transform',
  description: 'Fakes a 360 degree panorama from one or two ordinary pictures, for example a phone front and back camera. It is a fake: real pixels only exist where the cameras looked, and the rest is filled in by stretching, mirroring or blurring the edges. Shows it as a 2:1 panorama, a tiny planet or a look-around view.',
  keywords: ['360', 'fake 360', 'panorama', 'equirectangular', 'sphere', 'spherical', 'tiny planet', 'little planet', 'look around', 'vr', 'front back camera', 'selfie camera', 'ultrawide', 'reproject', 'photosphere', 'fill gaps', 'fake'],
  inputs: {
    front: { type: 'image', required: true, label: 'Front' },
    back: { type: 'image', label: 'Back' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    frontView: { type: 'number', default: 80, min: 30, max: 170, step: 0.5, unit: 'deg', label: 'Front view', hint: 'How wide the front camera sees, left to right. A phone is about 80, an ultrawide about 120.' },
    backView: { type: 'number', default: 80, min: 30, max: 170, step: 0.5, unit: 'deg', label: 'Back view', hint: 'How wide the back camera sees. With no Back picture the front picture is used again.' },
    fill: {
      type: 'enum',
      default: 'mirror',
      options: [
        { value: 'stretch', label: 'Stretch edges' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'blur', label: 'Blur out' },
        { value: 'blend', label: 'Blend both' },
      ],
      label: 'Fill gaps',
      hint: 'What shows where no camera looked. Stretch edges: the picture edge smeared round. Mirror: the picture reflected again and again. Blur out: smeared edge, softer the further away. Blend both: a lightly blurred stretch, front and back fills crossfaded over a wide seam.',
    },
    seam: { type: 'number', default: 20, min: 0, max: 90, step: 0.5, unit: 'deg', label: 'Seam softness', hint: 'How wide the soft crossfade is between the front fill and the back fill, where they meet at the sides.' },
    turn: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn', hint: 'Turns the whole panorama round. Wire a number here to spin it.' },
    tilt: { type: 'number', default: 0, min: -90, max: 90, step: 0.5, unit: 'deg', label: 'Tilt', hint: 'Tips the whole sphere up or down.' },
    flipBack: { type: 'bool', default: true, label: 'Flip back', hint: 'Mirrors the back picture left to right. A selfie camera picture is mirrored, so leave this on for it.' },
    output: {
      type: 'enum',
      default: 'panorama',
      options: [
        { value: 'panorama', label: '360 panorama 2:1' },
        { value: 'planet', label: 'Tiny planet' },
        { value: 'look', label: 'Look around' },
      ],
      label: 'Output',
    },
    zoom: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.01, label: 'Planet zoom', visibleIf: isPlanet },
    lookTurn: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Look turn', hint: 'Which way the look-around camera faces, left and right. Wire phone motion here.', visibleIf: isLook },
    lookTilt: { type: 'number', default: 0, min: -90, max: 90, step: 0.5, unit: 'deg', label: 'Look tilt', hint: 'Which way it faces, up and down.', visibleIf: isLook },
    lookView: { type: 'number', default: 90, min: 20, max: 150, step: 0.5, unit: 'deg', label: 'Look view angle', hint: 'How wide the look-around camera sees.', visibleIf: isLook },
  },
  summary: (p) => `${p.frontView}° + ${p.backView}° · ${p.fill} · ${p.output}`,
  render(ctx) {
    const p = ctx.params;
    const front = ctx.in.front;
    const back = ctx.in.back;
    if (!front) return { image: front };
    const H = fake360Height(front.height);
    const out = p.output as string;
    let width = H * 2;
    let height = H;
    if (out === 'planet') width = H;
    else if (out === 'look') {
      width = front.width;
      height = front.height;
    }
    const fill = FAKE360_FILLS[p.fill as keyof typeof FAKE360_FILLS] ?? 1;
    const seamRad = rad(p.seam);
    const image = ctx.gpu.pass({
      label: 'fake-360',
      size: { width, height, unit: front.unit * (height / front.height) },
      textures: back ? { front, back } : { front },
      uniforms: {
        frontHalf: rad(Math.min(170, Math.max(30, p.frontView))) / 2,
        backHalf: rad(Math.min(170, Math.max(30, p.backView))) / 2,
        frontAsp: front.width / front.height,
        backAsp: (back ?? front).width / (back ?? front).height,
        fill,
        // Blend both crossfades over a wide seam on purpose; the others only need enough to hide the join
        seamHalf: fill === 3 ? Math.max(seamRad, 1.2) : Math.max(seamRad, 0.06),
        turn: rad(p.turn),
        tilt: rad(p.tilt),
        flipBack: p.flipBack,
        output: FAKE360_OUTPUTS[out as keyof typeof FAKE360_OUTPUTS] ?? 0,
        zoom: p.zoom,
        lookTurn: rad(p.lookTurn),
        lookTilt: rad(p.lookTilt),
        lookView: rad(p.lookView),
      },
      wgsl: fake360Wgsl(!!back),
    });
    return { image };
  },
});
