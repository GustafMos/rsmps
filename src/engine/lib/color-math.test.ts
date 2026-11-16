import { describe, expect, it } from 'vitest';
import {
  CAT_MATRICES,
  D65,
  IDENTITY3,
  RGB_TO_XYZ,
  SPACES,
  TF_BREAKS,
  TRANSFER_IDS,
  type GradeOpts,
  type M3,
  type V3,
  XYZ_TO_SRGB,
  convertSpace,
  cubeText,
  cubeTexture,
  daylightXY,
  gradeReference,
  hslCurveTable,
  hslToRgb,
  illuminantXY,
  invM3,
  linearToOklab,
  luma709,
  mulMM,
  mulMV,
  neutralMatrix,
  oklabToLinear,
  parseCube,
  planckianXY,
  primariesMatrix,
  qualify,
  rgbCurveTable,
  rgbToHsl,
  sampleCube,
  saturateReference,
  shoulder,
  srgbToLinear,
  tfDecode,
  tfEncode,
  whiteBalanceMatrix,
  xyToXYZ,
  estimateNeutral,
  exposureChannel,
  hable,
} from './color-math';
import { presetLinear } from './util-curve';

const near = (a: number, b: number, tol: number, what = '') => expect(Math.abs(a - b), `${what} ${a} vs ${b}`).toBeLessThanOrEqual(tol);
const nearV = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number, what = '') => {
  for (let i = 0; i < a.length; i++) near(a[i], b[i], tol, what);
};

describe('matrices and primaries', () => {
  it('derived sRGB matrix equals the published one', () => {
    nearV(RGB_TO_XYZ.rec709, [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041], 1e-3);
  });
  it('white maps to D65 and primaries conversions invert', () => {
    nearV(mulMV(RGB_TO_XYZ.rec709, [1, 1, 1]), xyToXYZ(D65), 1e-9);
    nearV(mulMV(RGB_TO_XYZ.p3, [1, 1, 1]), xyToXYZ(D65), 1e-9);
    nearV(mulMV(RGB_TO_XYZ.rec2020, [1, 1, 1]), xyToXYZ(D65), 1e-9);
    nearV(mulMM(primariesMatrix('rec709', 'p3'), primariesMatrix('p3', 'rec709')), IDENTITY3, 1e-9);
    nearV(mulMM(XYZ_TO_SRGB, RGB_TO_XYZ.rec709), IDENTITY3, 1e-9);
    // Rec.709 -> Rec.2020 (BT.2407): published coefficients
    nearV(primariesMatrix('rec709', 'rec2020').slice(0, 3), [0.6274, 0.3293, 0.0433], 1e-3);
  });
  it('invM3 inverts', () => {
    const m: M3 = [2, 1, 0, 0, 3, 1, 1, 0, 4];
    nearV(mulMM(m, invM3(m)), IDENTITY3, 1e-12);
  });
});

describe('transfer functions', () => {
  it('every transfer round-trips', () => {
    for (const id of TRANSFER_IDS) for (const x of [0, 0.001, 0.0123, 0.18, 0.5, 1, 4]) near(tfDecode(id, tfEncode(id, x)), x, 1e-6 * Math.max(1, x), `${id} ${x}`);
  });
  it('log curves are continuous at their break points', () => {
    for (const [id, brk] of Object.entries(TF_BREAKS)) {
      const eps = brk! * 1e-6;
      near(tfEncode(id as 'slog3', brk! - eps), tfEncode(id as 'slog3', brk! + eps), 2e-5, `${id} value`);
    }
  });
  it('published anchor values: 18% grey and reference white', () => {
    near(tfEncode('slog3', 0.18), 420 / 1023, 1e-6);
    near(tfEncode('logc3', 0.18), 0.391, 5e-4);
    near(tfEncode('vlog', 0.18), 0.423, 5e-4);
    near(tfEncode('acescct', 0.18), 0.4135, 5e-4);
    near(tfEncode('davinci', 0.18), 0.336, 1e-3);
    near(tfEncode('cineon', 1), 685 / 1023, 1e-9);
    near(tfEncode('cineon', 0), 95 / 1023, 1e-9);
    near(tfEncode('srgb', 0.18), 0.4614, 1e-3);
  });
  it('colour space conversions round trip', () => {
    for (const a of SPACES) for (const b of SPACES) {
      const c: V3 = [0.62, 0.41, 0.23];
      nearV(convertSpace(convertSpace(c, a.id, b.id), b.id, a.id), c, 1e-6, `${a.id}<->${b.id}`);
    }
  });
});

describe('white balance maths', () => {
  it('Planckian and daylight loci hit published points', () => {
    nearV(planckianXY(2856), [0.4476, 0.4074], 3e-3);
    nearV(planckianXY(6500), [0.3135, 0.3237], 2e-3);
    nearV(planckianXY(2000), [0.5267, 0.4133], 4e-3);
    nearV(daylightXY(6504), D65, 1e-3);
    nearV(daylightXY(5003), [0.3457, 0.3585], 1e-3); // D50
  });
  it('6500 K and tint 0 is exactly the identity, for both adaptations', () => {
    for (const m of Object.keys(CAT_MATRICES) as (keyof typeof CAT_MATRICES)[]) nearV(whiteBalanceMatrix(6500, 0, m), IDENTITY3, 1e-9);
  });
  it('the illuminant itself is mapped to neutral, and warm light turns the picture cooler', () => {
    for (const k of [2500, 3200, 4500, 5600, 9000, 12000]) for (const tint of [-0.7, 0, 0.5]) {
      const m = whiteBalanceMatrix(k, tint, 'bradford');
      // The illuminant, as linear sRGB, must become grey (CAT maps source white to destination white exactly).
      const rgb = mulMV(XYZ_TO_SRGB, xyToXYZ(illuminantXY(k, tint)));
      const out = mulMV(m, rgb);
      near(out[0] / out[1], 1, 1e-6, `${k}K r/g`);
      near(out[2] / out[1], 1, 1e-6, `${k}K b/g`);
    }
    const warm = mulMV(whiteBalanceMatrix(3200, 0, 'bradford'), [1, 1, 1]);
    expect(warm[2]).toBeGreaterThan(warm[0]);
    const cool = mulMV(whiteBalanceMatrix(9000, 0, 'bradford'), [1, 1, 1]);
    expect(cool[0]).toBeGreaterThan(cool[2]);
  });
  it('positive tint goes magenta, negative green', () => {
    const mag = mulMV(whiteBalanceMatrix(6500, 1, 'bradford'), [1, 1, 1]);
    expect(mag[1]).toBeLessThan((mag[0] + mag[2]) / 2);
    const grn = mulMV(whiteBalanceMatrix(6500, -1, 'bradford'), [1, 1, 1]);
    expect(grn[1]).toBeGreaterThan((grn[0] + grn[2]) / 2);
  });
  it('the neutral pick maps to equal RGB', () => {
    for (const picked of [[0.7, 0.55, 0.4], [0.3, 0.4, 0.6], [0.9, 0.9, 0.9]] as V3[]) for (const method of ['bradford', 'cat16'] as const) {
      const lin = srgbToLinear(picked);
      const out = mulMV(neutralMatrix(picked, method), lin);
      near(out[0], out[1], 1e-6);
      near(out[1], out[2], 1e-6);
      near(out[1], luma709(lin), 0.02); // same luminance, roughly (adaptation keeps Y of the picked colour)
    }
  });
  it('grey-world estimates the mean, white-patch the brightest', () => {
    const px = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) px.set(i < 98 ? [100, 80, 60, 255] : [250, 230, 200, 255], i * 4);
    const wp = estimateNeutral(px, 'white-patch');
    near(wp[0], 250 / 255, 0.01);
    const gw = estimateNeutral(px, 'grey-world');
    expect(gw[0]).toBeLessThan(0.45);
  });
});

describe('saturation reference', () => {
  const colours: V3[] = [[0.8, 0.3, 0.2], [0.2, 0.5, 0.8], [0.6, 0.7, 0.2], [0.9, 0.7, 0.6], [0.35, 0.2, 0.5], [0.15, 0.4, 0.3]];
  const base = { vibrance: 0, protectSkin: 0, shadowRolloff: 0, highlightRolloff: 0 };
  it('neutral grey stays neutral at any amount in every mode', () => {
    for (const mode of ['oklab', 'linear', 'hsl'] as const) for (const saturation of [0, 0.3, 1, 2, 4]) for (const v of [0.05, 0.2, 0.5, 0.8, 0.97]) {
      const o = saturateReference([v, v, v], { ...base, mode, saturation });
      near(o[0], o[1], 1e-5, `${mode} ${saturation}`);
      near(o[1], o[2], 1e-5, `${mode} ${saturation}`);
      near(o[0], v, 1e-5);
    }
  });
  it('OKLab mode keeps OKLab lightness; linear mode keeps linear luma', () => {
    for (const c of colours) for (const saturation of [0, 0.5, 1.5, 2.5]) {
      const L0 = linearToOklab(srgbToLinear(c))[0];
      const o = saturateReference(c, { ...base, mode: 'oklab', saturation });
      near(linearToOklab(srgbToLinear(o))[0], L0, 0.004, `oklab ${c} x${saturation}`);
      const y0 = luma709(srgbToLinear(c));
      const o2 = saturateReference(c, { ...base, mode: 'linear', saturation });
      near(luma709(srgbToLinear(o2)), y0, 0.004, `linear ${c} x${saturation}`);
    }
  });
  it('saturation 0 gives grey of the same lightness; 1 is identity', () => {
    for (const c of colours) {
      nearV(saturateReference(c, { ...base, mode: 'oklab', saturation: 1 }), c, 1e-4);
      const g = saturateReference(c, { ...base, mode: 'oklab', saturation: 0 });
      near(g[0], g[1], 1e-4);
    }
  });
  it('gamut mapping reduces chroma instead of clipping (hue is kept)', () => {
    const c: V3 = [0.8, 0.3, 0.2];
    const o = saturateReference(c, { ...base, mode: 'oklab', saturation: 3 });
    expect(o.every((v) => v >= 0 && v <= 1)).toBe(true);
    const a = linearToOklab(srgbToLinear(c));
    const b = linearToOklab(srgbToLinear(o));
    near(Math.atan2(b[2], b[1]), Math.atan2(a[2], a[1]), 0.02);
  });
  it('vibrance moves muted colours more than vivid ones', () => {
    const muted: V3 = [0.55, 0.5, 0.45];
    const vivid: V3 = [0.9, 0.1, 0.1];
    const chroma = (c: V3) => Math.hypot(...(linearToOklab(srgbToLinear(c)).slice(1) as [number, number]));
    const opts = { ...base, mode: 'oklab' as const, saturation: 1, vibrance: 1, protectSkin: 0 };
    const gainMuted = chroma(saturateReference(muted, opts)) / chroma(muted);
    const gainVivid = chroma(saturateReference(vivid, opts)) / chroma(vivid);
    expect(gainMuted).toBeGreaterThan(gainVivid + 0.3);
  });
});

describe('grade reference', () => {
  const identity: GradeOpts = { mode: 'lgg', lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], offset: [0, 0, 0], slope: [1, 1, 1], cdlOffset: [0, 0, 0], power: [1, 1, 1], contrast: 1, pivot: 0.3, saturation: 1 };
  it('identity values are identity in every working space and both modes', () => {
    for (const space of ['display', 'linear', 'log'] as const) for (const mode of ['lgg', 'cdl'] as const) {
      nearV(gradeReference([0.7, 0.4, 0.1], { ...identity, mode }, space), [0.7, 0.4, 0.1], 1e-5, `${space} ${mode}`);
    }
  });
  it('CDL slope doubles, power bends, offset adds (display)', () => {
    const o = { ...identity, mode: 'cdl' as const };
    nearV(gradeReference([0.25, 0.25, 0.25], { ...o, slope: [2, 2, 2] }, 'display'), [0.5, 0.5, 0.5], 1e-5);
    nearV(gradeReference([0.5, 0.5, 0.5], { ...o, power: [2, 2, 2] }, 'display'), [0.25, 0.25, 0.25], 1e-5);
    nearV(gradeReference([0.2, 0.2, 0.2], { ...o, cdlOffset: [0.1, 0.1, 0.1] }, 'display'), [0.3, 0.3, 0.3], 1e-5);
    // saturation about Rec.709 luma
    const c: V3 = [0.8, 0.4, 0.2];
    const out = gradeReference(c, { ...o, saturation: 0 }, 'display');
    near(out[0], luma709(c), 1e-5);
  });
  it('lift moves black, gain moves white, gamma moves neither', () => {
    const o = { ...identity, lift: [0.1, 0.1, 0.1] as V3, gain: [0.8, 0.8, 0.8] as V3 };
    near(gradeReference([0, 0, 0], o, 'display')[0], 0.1, 1e-5);
    near(gradeReference([1, 1, 1], o, 'display')[0], 0.8 * 0.9 + 0.1, 1e-5);
    const g = { ...identity, gamma: [2, 2, 2] as V3 };
    near(gradeReference([0, 0, 0], g, 'display')[0], 0, 1e-6);
    near(gradeReference([1, 1, 1], g, 'display')[0], 1, 1e-6);
    expect(gradeReference([0.25, 0.25, 0.25], g, 'display')[0]).toBeCloseTo(0.5, 5);
  });
});

describe('exposure maths', () => {
  const base = { stops: 0, blackPoint: 0, rolloff: 0, tonemap: 'none' as const, whitePoint: 4 };
  it('one stop doubles linear light', () => {
    near(exposureChannel(0.2, { ...base, stops: 1 }), 0.4, 1e-9);
    near(exposureChannel(0.2, { ...base, stops: -2 }), 0.05, 1e-9);
  });
  it('shoulder is C1 at the knee and never exceeds 1', () => {
    const k = 0.7;
    near(shoulder(k - 1e-6, k), shoulder(k + 1e-6, k), 1e-5);
    near((shoulder(k + 2e-6, k) - shoulder(k + 1e-6, k)) / 1e-6, 1, 1e-3);
    expect(shoulder(50, k)).toBeLessThanOrEqual(1);
    expect(shoulder(50, k)).toBeGreaterThan(0.999);
  });
  it('tone maps send the white point to 1', () => {
    near(exposureChannel(4, { ...base, tonemap: 'reinhard' }), 1, 1e-9);
    near(exposureChannel(4, { ...base, tonemap: 'hable' }), 1, 1e-9);
    near(hable(0), 0, 1e-12);
  });
});

describe('curve tables', () => {
  it('identity curves give an identity table', () => {
    const t = rgbCurveTable(presetLinear(), presetLinear(), presetLinear(), presetLinear());
    for (let i = 0; i < 256; i++) near(t[i * 4], i / 255, 1e-6);
  });
  it('hue curves wrap: first and last texel agree', () => {
    const curve = { keys: [{ t: 0.1, v: 0.9, interp: 'smooth' as const }, { t: 0.6, v: 0.2, interp: 'smooth' as const }] };
    const flat = { keys: [{ t: 0, v: 0.5, interp: 'smooth' as const }] };
    const t = hslCurveTable([curve, flat, flat, flat, flat]);
    near(t[0], t[255 * 4], 1e-6);
  });
});

describe('.cube parsing and sampling', () => {
  const rnd = (() => {
    let s = 12345;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  it('parses a generated 3D cube with header lines and comments', () => {
    const text = '# comment\n' + cubeText('3d', 5, (r, g, b) => [r, g, b], 'my look') + '\n';
    const lut = parseCube(text);
    expect(lut.kind).toBe('3d');
    expect(lut.size).toBe(5);
    expect(lut.title).toBe('my look');
    expect(lut.rgb.length).toBe(5 * 5 * 5 * 3);
    // red fastest
    expect(Array.from(lut.rgb.slice(3, 6))).toEqual([0.25, 0, 0]);
    expect(Array.from(lut.rgb.slice(15, 18))).toEqual([0, 0.25, 0]);
  });
  it('identity cubes are identity for both interpolations and both dimensions', () => {
    for (const kind of ['3d', '1d'] as const) {
      const lut = parseCube(cubeText(kind, kind === '3d' ? 9 : 33, (r, g, b) => [r, g, b]));
      for (let i = 0; i < 200; i++) {
        const c: V3 = [rnd(), rnd(), rnd()];
        for (const interp of ['tetrahedral', 'trilinear'] as const) nearV(sampleCube(lut, c, interp), c, 1e-6, `${kind} ${interp}`);
      }
    }
  });
  it('tetrahedral and trilinear are both exact on an affine LUT (all six simplices)', () => {
    const f = (r: number, g: number, b: number): V3 => [0.1 + 0.5 * r + 0.2 * g, 0.3 * g + 0.4 * b, 0.9 - 0.6 * b + 0.1 * r];
    const lut = parseCube(cubeText('3d', 7, f));
    for (let i = 0; i < 300; i++) {
      const c: V3 = [rnd(), rnd(), rnd()];
      for (const interp of ['tetrahedral', 'trilinear'] as const) nearV(sampleCube(lut, c, interp), f(...c), 2e-6, interp);
    }
  });
  it('honours DOMAIN_MIN/MAX', () => {
    const text = 'LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 1 1\n';
    nearV(sampleCube(parseCube(text), [1, 0.5, 2]), [0.5, 0.25, 1], 1e-9);
  });
  it('builds an atlas texture: x = r + b * size, y = g', () => {
    const lut = parseCube(cubeText('3d', 4, (r, g, b) => [r, g, b]));
    const t = cubeTexture(lut);
    expect([t.width, t.height]).toEqual([16, 4]);
    // r = 1, g = 2, b = 3 -> x = 1 + 12 = 13, y = 2
    nearV(t.data.slice((2 * 16 + 13) * 4, (2 * 16 + 13) * 4 + 3), [1 / 3, 2 / 3, 1], 1e-6);
  });
  it('reports bad files with a readable message', () => {
    expect(() => parseCube('TITLE x\n0 0 0\n')).toThrow(/LUT_3D_SIZE or LUT_1D_SIZE/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/expected 8 entries/);
    expect(() => parseCube('LUT_3D_SIZE 66\n')).toThrow(/larger than/);
    expect(() => parseCube('LUT_3D_SIZE 1\n0 0 0\n')).toThrow(/invalid size/);
    expect(() => parseCube('LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 0 0 0\n0 0 0\n1 1 1\n')).toThrow(/DOMAIN_MAX/);
    expect(() => parseCube('LUT_1D_SIZE 2\n0 a 0\n1 1 1\n')).toThrow(/numeric/);
  });
  it('accepts the maximum 3D size', () => {
    const lut = parseCube(cubeText('3d', 65, (r, g, b) => [r, g, b]));
    expect(lut.size).toBe(65);
    const t = cubeTexture(lut);
    expect([t.width, t.height]).toEqual([4225, 65]);
  });
});

describe('qualifier reference', () => {
  const o = { hueCenter: 220 / 360, hueWidth: 30 / 360, hueSoft: 15 / 360, satLow: 0, satHigh: 1, satSoft: 0.1, lumLow: 0, lumHigh: 1, lumSoft: 0.1, invert: false };
  it('selects blue, not red or grey', () => {
    expect(qualify([0.1, 0.35, 0.9], o)).toBeGreaterThan(0.99);
    expect(qualify([0.9, 0.2, 0.1], o)).toBeLessThan(0.01);
    expect(qualify([0.5, 0.5, 0.5], o)).toBeLessThan(0.01);
    expect(qualify([0.5, 0.5, 0.5], { ...o, hueWidth: 0.5 })).toBeGreaterThan(0.99);
    expect(qualify([0.1, 0.35, 0.9], { ...o, invert: true })).toBeLessThan(0.01);
  });
  it('hsl round trip', () => {
    for (const c of [[0.2, 0.5, 0.9], [0.9, 0.5, 0.1], [0.3, 0.3, 0.3]] as V3[]) nearV(hslToRgb(rgbToHsl(c)), c, 1e-9);
  });
  it('OKLab round trip', () => {
    nearV(oklabToLinear(linearToOklab([0.2, 0.5, 0.9])), [0.2, 0.5, 0.9], 1e-6);
    near(linearToOklab([1, 1, 1])[0], 1, 1e-4);
  });
});
