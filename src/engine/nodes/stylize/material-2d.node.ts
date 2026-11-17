import { defineNode } from '../../define';
import { PIXEL_SIZE_PARAM, upscaleArtGrid, withArtGrid } from '../../lib/art-grid';
import { materialKey, materialTextures, materialUniforms } from '../../lib/gen-material';
import { defaultMaterial2d, lightDir2d, material2dWgsl } from '../../lib/gen-material2d';
import { FIELD_CAP, PROFILE_HEIGHT, PROFILE_ID, SHAPE_ID, silhouetteField } from '../../lib/gen-surface2d';
import type { ImageValue, MaterialValue } from '../../types';


export default defineNode({
  id: 'material-2d',
  title: 'Material 2D',
  category: 'stylize',
  description:
    'Makes a flat picture look like a real surface: chrome, plastic, glass, clay, toon, hologram... The picture\'s shape (its transparency) is the object; it gets a bevel, a normal map or a height picture, and real lighting from a Material node, with a light you can aim, move or animate. A black logo on transparent becomes a chrome logo; a pixel sprite gets crisp lit edges. Wire a Background to refract footage through the shape. Outputs the normal map and height it used.',
  keywords: ['material', 'metal', 'chrome', 'gold', 'plastic', 'glass', 'clay', 'emboss', 'bevel', 'relief', 'lit', 'lighting', 'shiny', 'toon', 'matcap', 'light', '2d material', '3d logo', 'sprite lighting', 'refraction', 'shadow', 'normal map'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    material: { type: 'material', label: 'Material' },
    height: { type: 'image', label: 'Height' },
    normal: { type: 'image', label: 'Normal map' },
    environment: { type: 'image', label: 'Environment' },
    background: { type: 'image', label: 'Background' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, normal: { type: 'image', label: 'Normal map' }, height: { type: 'image', label: 'Height' } },
  optionalOutputs: ['normal', 'height'],
  maskable: true,
  params: {
    shape: {
      type: 'enum',
      default: 'bevel',
      label: 'Surface shape',
      group: 'Surface',
      hint: 'Where the relief comes from when no Height or Normal map is wired. Bevel rounds the silhouette; Brightness raises what is bright; Flat adds none.',
      options: [
        { value: 'bevel', label: 'Bevel' },
        { value: 'luma', label: 'Brightness' },
        { value: 'flat', label: 'Flat' },
      ],
    },
    profile: {
      type: 'enum',
      default: 'round',
      label: 'Bevel profile',
      group: 'Surface',
      visibleIf: (p) => p.shape === 'bevel',
      options: [
        { value: 'round', label: 'Round' },
        { value: 'chisel', label: 'Chisel' },
        { value: 'pillow', label: 'Pillow' },
        { value: 'rim', label: 'Flat with edge' },
      ],
    },
    bevelWidth: { type: 'number', default: 16, min: 0.5, max: 400, softMax: 120, step: 0.5, unit: 'px', label: 'Bevel width', group: 'Surface', hint: 'Also the relief height of the Brightness shape and of a Height picture.' },
    depth: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.01, label: 'Depth', group: 'Surface', hint: '0 = flat. Higher = steeper slopes, more dramatic light.' },
    smoothing: { type: 'number', default: 1.5, min: 0, max: 60, softMax: 30, step: 0.1, unit: 'px', label: 'Smoothing', group: 'Surface', hint: 'Softens the relief of Brightness shapes and Height pictures (8-bit pictures stair-step without it).' },
    detail: { type: 'number', default: 0, min: 0, max: 2, step: 0.01, label: 'Fine detail', group: 'Surface', hint: 'Adds relief from the picture\'s own brightness on top of the shape: paper grain, brush strokes, pixel texture.' },
    normalStrength: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Normal strength', group: 'Surface' },
    flipY: { type: 'bool', default: false, label: 'Flip normal Y', group: 'Surface', hint: 'Off = OpenGL normal maps (green points up; what Normal Map and most game tools write). On = DirectX maps.' },
    colorFrom: {
      type: 'enum',
      default: 'auto',
      label: 'Color from',
      group: 'Surface',
      hint: 'Automatic: the Material\'s color when a Material is wired (a black logo still becomes chrome), the picture\'s own colors when none is.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'picture', label: 'Picture' },
        { value: 'material', label: 'Material' },
        { value: 'tint', label: 'Both multiplied' },
      ],
    },
    lightAngle: { type: 'number', default: -45, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light angle', group: 'Light', hint: 'Where the light comes from, clockwise from the top: 0 = above, 90 = from the right, -45 = top left.' },
    lightHeight: { type: 'number', default: 50, min: 5, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Light', hint: '90 = straight at the picture (flat light), low = raking light that shows every bump.' },
    lightColor: { type: 'color', default: [1, 1, 1, 1], label: 'Light color', group: 'Light' },
    lightIntensity: { type: 'number', default: 1, min: 0, max: 4, softMax: 2.5, step: 0.01, label: 'Intensity', group: 'Light' },
    ambient: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Ambient', group: 'Light' },
    fillIntensity: { type: 'number', default: 0, min: 0, max: 2, step: 0.01, label: 'Fill light', group: 'Light', hint: 'A second light, usually dimmer and colored, from another side.' },
    fillAngle: { type: 'number', default: 135, min: -180, max: 180, step: 1, unit: 'deg', label: 'Fill angle', group: 'Light' },
    fillColor: { type: 'color', default: [0.55, 0.7, 1, 1], label: 'Fill color', group: 'Light' },
    cel: { type: 'bool', default: false, label: 'Posterize light', group: 'Light', hint: 'Flat bands instead of smooth shading. On pixel art this gives crisp pixel bevels.' },
    celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Light steps', group: 'Light', visibleIf: (p) => p.cel === true },
    sweep: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Light sweep', group: 'Light', hint: 'The light circles the picture this many whole times per loop. 0 = still.' },
    shadow: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Shadow', group: 'Shadow', hint: 'A soft shadow under the shape, away from the light. 0 = none.' },
    shadowOffset: { type: 'number', default: 8, min: 0, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Shadow distance', group: 'Shadow', hint: 'Small = contact shadow, large = drop shadow.' },
    shadowBlur: { type: 'number', default: 6, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Shadow blur', group: 'Shadow' },
    shadowColor: { type: 'color', default: [0, 0, 0, 0.6], label: 'Shadow color', group: 'Shadow' },
    quality: {
      type: 'enum',
      default: 'normal',
      label: 'Field detail',
      group: 'Quality',
      hint: 'Resolution of the silhouette distance field (the bevel). Static pictures are cached; on video this is rebuilt every frame, so Draft is much cheaper.',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'normal', label: 'Normal' },
        { value: 'high', label: 'High' },
      ],
    },
    pixelSize: { ...PIXEL_SIZE_PARAM, group: 'Quality' },
  },
  summary: (p) => `${p.shape}${p.cel ? ' · posterized' : ''}${p.sweep ? ' · sweeping light' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.in.image;
    const wired = ctx.in.material;
    const mat0 = wired ?? defaultMaterial2d();
    const normalTex = ctx.in.normal ?? mat0.maps.normalMap;
    const heightTex = ctx.in.height;
    const colorFrom = p.colorFrom as 'auto' | 'picture' | 'material' | 'tint';
    // The Material's own normal map is used as the Normal input; its other maps are read planar (the picture is flat).
    const m: MaterialValue = {
      ...mat0,
      base: colorFrom === 'picture' ? [1, 1, 1] : mat0.base,
      flags: { ...mat0.flags, triplanar: false },
      maps: { ...mat0.maps, normalMap: null, environment: ctx.in.environment ?? mat0.maps.environment, background: ctx.in.background ?? mat0.maps.background },
    };
    const useImg = colorFrom === 'picture' || colorFrom === 'tint' ? 1 : colorFrom === 'material' ? 0 : wired ? 0 : 1;
    const phase = p.sweep !== 0 ? ctx.time.phase : 0;
    const angle = p.lightAngle + 360 * p.sweep * phase;
    const key = lightDir2d(angle, p.lightHeight);
    const fill = lightDir2d(p.fillAngle + 360 * p.sweep * phase, p.lightHeight);
    const keyCol = [p.lightColor[0] * p.lightIntensity, p.lightColor[1] * p.lightIntensity, p.lightColor[2] * p.lightIntensity, 1];
    const extra = p.lightIntensity !== 1 || p.lightColor[0] !== 1 || p.lightColor[1] !== 1 || p.lightColor[2] !== 1 || p.fillIntensity > 0;
    const shapeMode = heightTex ? 3 : SHAPE_ID[p.shape as keyof typeof SHAPE_ID];
    const wantNormal = ctx.wants('normal');
    const wantHeight = ctx.wants('height');
    const prof = p.profile as keyof typeof PROFILE_ID;
    const needField = shapeMode === 0;
    const wantsOut: { normal: ImageValue | null; height: ImageValue | null } = { normal: null, height: null };

    const lit = withArtGrid(ctx.gpu, image, p.pixelSize, (art, grid) => {
      const gpu = ctx.gpu;
      let fld: ImageValue | null = null;
      let occ: ImageValue | null = null;
      let cellTex = 1;
      if (needField) {
        const cap = grid.active ? Math.max(FIELD_CAP[p.quality as keyof typeof FIELD_CAP], 512) : FIELD_CAP[p.quality as keyof typeof FIELD_CAP];
        const f = silhouetteField(gpu, art, cap, grid.active);
        fld = f.fld;
        occ = f.occ;
        cellTex = f.cellTex;
      }
      const width = Math.max(0.5, grid.toArt(p.bevelWidth));
      const hScale = needField ? width * p.depth * PROFILE_HEIGHT[prof] : width * p.depth;
      const off = grid.toArt(p.shadowOffset);
      const shadowDir = [-Math.sin((angle * Math.PI) / 180), Math.cos((angle * Math.PI) / 180)];
      const uniforms = {
        ...materialUniforms(m),
        light: key,
        fillL: fill,
        keyCol,
        fillCol: [p.fillColor[0] * p.fillIntensity, p.fillColor[1] * p.fillIntensity, p.fillColor[2] * p.fillIntensity, p.fillIntensity],
        extra: extra ? 1 : 0,
        ambient: p.ambient,
        cel: p.cel ? 1 : 0,
        steps: Math.max(2, Math.round(p.celSteps)),
        camRight: [1, 0, 0],
        camUp: [0, 1, 0],
        camFwd: [0, 0, 1],
        t0: [1, 0, 0],
        t1: [0, 1, 0],
        t2: [0, 0, 1],
        shapeMode,
        profile: PROFILE_ID[prof] ?? 0,
        widthPx: width,
        hScale,
        smoothR: Math.max(1, grid.toArt(p.smoothing)),
        detail: p.detail,
        nStrength: p.normalStrength,
        flipY: p.flipY ? -1 : 1,
        cellTex,
        tile: 0,
        useImg,
        glassSolid: m.model === 'glass' && m.maps.background ? 1 : 0,
        shadowAmt: p.shadow,
        shadowOff: [shadowDir[0] * off, shadowDir[1] * off],
        shadowBlur: grid.toArt(p.shadowBlur),
        shadowCol: [p.shadowColor[0], p.shadowColor[1], p.shadowColor[2], p.shadowColor[3]],
      };
      const textures = { src: art, fld, hgt: heightTex, nrm: normalTex, ...materialTextures(m) };
      const wgsl = material2dWgsl(m, { hasField: !!fld, hasHeight: !!heightTex, hasNormal: !!normalTex });
      const label = `material-2d ${materialKey(m)} ${fld ? 'f' : ''}${heightTex ? 'h' : ''}${normalTex ? 'n' : ''}`;
      const run = (outMode: number, name: string): ImageValue => gpu.pass({ label: `${label} ${name}`, size: art, uniforms: { ...uniforms, outMode }, textures, wgsl });
      const out = run(0, 'lit');
      const finish = (img: ImageValue): ImageValue => (grid.active ? upscaleArtGrid(gpu, img, { width: image.width, height: image.height, unit: image.unit }, grid.cell) : img);
      if (wantNormal) {
        const n = run(1, 'normal');
        wantsOut.normal = finish(n);
        if (grid.active) gpu.recycle(n);
      }
      if (wantHeight) {
        const h = run(2, 'height');
        wantsOut.height = finish(h);
        if (grid.active) gpu.recycle(h);
      }
      if (fld) gpu.recycle(fld);
      if (occ) gpu.recycle(occ);
      return out;
    });
    return { image: lit, normal: wantsOut.normal, height: wantsOut.height };
  },
});
