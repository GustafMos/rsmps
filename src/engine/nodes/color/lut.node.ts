import { defineNode } from '../../define';
import { type CubeLut, SPACE_OPTIONS, cubeTexture, parseCube, primariesMatrix, rows, spaceDef, transferIndex } from '../../lib/color-math';
import { COLOR_WGSL } from '../../lib/color-wgsl';

interface Prepared {
  lut: CubeLut;
  data: Float32Array;
  width: number;
  height: number;
}
/** Parsed LUTs and their texture data, keyed by the file's bytes object (the library returns the same instance per asset). Pure memo. */
const prepared = new WeakMap<ArrayBuffer, Prepared | { error: string }>();
const MAX_FILE_BYTES = 48 * 1024 * 1024;

export default defineNode({
  id: 'lut',
  title: 'LUT',
  category: 'color',
  description: 'Applies a .cube lookup table (1D or 3D, up to 65 points) with tetrahedral or trilinear interpolation, an intensity mix, and input / output colour spaces for log LUTs.',
  keywords: ['grade', 'lut', 'cube', '.cube', '3d lut', '1d lut', 'look', 'lookup table', 'film emulation', 'log to rec709', 'technical lut', 'creative lut', 'tetrahedral', 'trilinear'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    lut: { type: 'assets', default: [], accept: 'lut', label: 'LUT file', hint: 'A .cube file, 1D or 3D. With several files, each batch item uses its own. With none, the picture passes through.' },
    interpolation: {
      type: 'enum',
      default: 'tetrahedral',
      label: 'Interpolation',
      options: [
        { value: 'tetrahedral', label: 'Tetrahedral' },
        { value: 'trilinear', label: 'Trilinear' },
      ],
      hint: 'Tetrahedral is what grading apps use: it keeps the grey axis smooth. Trilinear is the classic 8-corner blend. 1D LUTs are always linearly interpolated per channel.',
    },
    intensity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Intensity', hint: 'Blend between the picture and the LUT result.' },
    inSpace: {
      type: 'enum',
      default: 'srgb',
      label: 'LUT input space',
      options: SPACE_OPTIONS,
      hint: 'The encoding the LUT expects at its input. The picture (sRGB) is converted to it first: use e.g. S-Log3 for a log-to-Rec.709 LUT after a Colour Space conversion, or leave sRGB for a creative look that expects display values. Log entries are curve-only (Rec.709 primaries).',
    },
    outSpace: { type: 'enum', default: 'srgb', label: 'LUT output space', options: SPACE_OPTIONS, hint: 'The encoding the LUT writes. The result is converted back to sRGB for the picture.' },
  },
  summary: (p) => (p.lut.length ? `${p.interpolation} · ${Math.round(p.intensity * 100)}%` : 'no LUT'),
  async render(ctx) {
    const p = ctx.params;
    if (!p.lut.length) return { image: ctx.in.image };
    const assetId = p.lut[p.lut.length > 1 ? ctx.item.index % p.lut.length : 0];
    if (!ctx.host.assetBytes) throw new Error('This app build cannot load LUT files (the host has no assetBytes).');
    const bytes = await ctx.host.assetBytes(assetId);
    if (!bytes) throw new Error('The LUT file is missing. Choose it again in the node.');
    let prep = prepared.get(bytes);
    if (!prep) {
      try {
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('.cube file is larger than 48 MB');
        const lut = parseCube(new TextDecoder().decode(bytes));
        prep = { lut, ...cubeTexture(lut) };
      } catch (e) {
        prep = { error: e instanceof Error ? e.message : String(e) };
      }
      prepared.set(bytes, prep);
    }
    if ('error' in prep) throw new Error(`Could not read the LUT: ${prep.error}`);
    const { lut } = prep;
    const tex = ctx.gpu.dataTexture(prep.data, prep.width, prep.height);
    const a = spaceDef(p.inSpace);
    const b = spaceDef(p.outSpace);
    const [i0, i1, i2] = rows(primariesMatrix('rec709', a.primaries));
    const [o0, o1, o2] = rows(primariesMatrix(b.primaries, 'rec709'));
    const image = ctx.gpu.pass({
      label: 'lut',
      size: ctx.in.image,
      textures: { src: ctx.in.image, lut: tex },
      uniforms: {
        n: lut.size,
        is1d: lut.kind === '1d',
        tetra: p.interpolation === 'tetrahedral',
        dmin: lut.domainMin,
        dmax: lut.domainMax,
        i0,
        i1,
        i2,
        o0,
        o1,
        o2,
        inTf: transferIndex(a.transfer),
        outTf: transferIndex(b.transfer),
        intensity: p.intensity,
      },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn cg_fetch(ix: vec3i) -> vec3f { return textureLoad(lut, vec2i(ix.x + ix.z * i32(u.n), ix.y), 0).rgb; }
fn cg_fetch1(i: i32) -> vec3f { return textureLoad(lut, vec2i(i, 0), 0).rgb; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let lin = cg_dec(s.rgb, 0.0);
  let inp = cg_enc(vec3f(dot(u.i0, lin), dot(u.i1, lin), dot(u.i2, lin)), u.inTf);
  let N = i32(u.n);
  let t = clamp((inp - u.dmin) / (u.dmax - u.dmin), vec3f(0.0), vec3f(1.0));
  let f = t * f32(N - 1);
  let b0 = min(vec3i(floor(f)), vec3i(N - 2));
  let w = f - vec3f(b0);
  var o: vec3f;
  if (u.is1d > 0.5) {
    o = vec3f(
      mix(cg_fetch1(b0.x).r, cg_fetch1(b0.x + 1).r, w.x),
      mix(cg_fetch1(b0.y).g, cg_fetch1(b0.y + 1).g, w.y),
      mix(cg_fetch1(b0.z).b, cg_fetch1(b0.z + 1).b, w.z));
  } else {
    let c000 = cg_fetch(b0);
    let c100 = cg_fetch(b0 + vec3i(1, 0, 0));
    let c010 = cg_fetch(b0 + vec3i(0, 1, 0));
    let c001 = cg_fetch(b0 + vec3i(0, 0, 1));
    let c110 = cg_fetch(b0 + vec3i(1, 1, 0));
    let c101 = cg_fetch(b0 + vec3i(1, 0, 1));
    let c011 = cg_fetch(b0 + vec3i(0, 1, 1));
    let c111 = cg_fetch(b0 + vec3i(1, 1, 1));
    if (u.tetra > 0.5) {
      if (w.x >= w.y && w.y >= w.z) { o = c000 + w.x * (c100 - c000) + w.y * (c110 - c100) + w.z * (c111 - c110); }
      else if (w.x >= w.z && w.z >= w.y) { o = c000 + w.x * (c100 - c000) + w.z * (c101 - c100) + w.y * (c111 - c101); }
      else if (w.z >= w.x && w.x >= w.y) { o = c000 + w.z * (c001 - c000) + w.x * (c101 - c001) + w.y * (c111 - c101); }
      else if (w.y >= w.x && w.x >= w.z) { o = c000 + w.y * (c010 - c000) + w.x * (c110 - c010) + w.z * (c111 - c110); }
      else if (w.y >= w.z && w.z >= w.x) { o = c000 + w.y * (c010 - c000) + w.z * (c011 - c010) + w.x * (c111 - c011); }
      else { o = c000 + w.z * (c001 - c000) + w.y * (c011 - c001) + w.x * (c111 - c011); }
    } else {
      let x0 = mix(c000, c100, w.x);
      let x1 = mix(c010, c110, w.x);
      let x2 = mix(c001, c101, w.x);
      let x3 = mix(c011, c111, w.x);
      o = mix(mix(x0, x1, w.y), mix(x2, x3, w.y), w.z);
    }
  }
  let lo = cg_dec(o, u.outTf);
  let res = cg_enc(max(vec3f(dot(u.o0, lo), dot(u.o1, lo), dot(u.o2, lo)), vec3f(0.0)), 0.0);
  return premul(vec4f(clamp(mix(s.rgb, res, u.intensity), vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
