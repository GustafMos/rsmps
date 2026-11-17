import { defineNode } from '../../define';
import type { MaterialValue } from '../../types';

const TAU = Math.PI * 2;

export default defineNode({
  id: 'material',
  title: 'Material',
  category: 'generate',
  description:
    'A surface look for 3D nodes: matte, clay, plastic, metal, glass, toon, emissive, hologram, matcap or wireframe grid, with optional color, normal, roughness and emission pictures and an environment. Wire it into the Material input of 3D Object (shapes and imported models), 3D Array, Image to 3D, SDF 3D or Material 2D (the same look on a flat picture); one Material can feed several nodes. Without it they keep their plain look.',
  keywords: ['shader', 'surface', 'pbr', 'metal', 'glass', 'toon', 'matcap', 'texture', 'look', 'plastic', 'clay', 'hologram', 'wireframe', 'emissive', 'glow', 'reflection', '3d'],
  inputs: {
    colorMap: { type: 'image', label: 'Color map' },
    normalMap: { type: 'image', label: 'Normal map' },
    roughnessMap: { type: 'image', label: 'Roughness map' },
    emissionMap: { type: 'image', label: 'Emission map' },
    matcap: { type: 'image', label: 'Matcap' },
    environment: { type: 'image', label: 'Environment (360°)' },
    background: { type: 'image', label: 'Background (for glass)' },
  },
  outputs: { material: { type: 'material', label: 'Material' } },
  params: {
    model: {
      type: 'enum',
      default: 'plastic',
      label: 'Material',
      options: [
        { value: 'matte', label: 'Matte' },
        { value: 'clay', label: 'Clay' },
        { value: 'plastic', label: 'Plastic' },
        { value: 'metal', label: 'Metal' },
        { value: 'pbr', label: 'Custom' },
        { value: 'glass', label: 'Glass' },
        { value: 'toon', label: 'Toon' },
        { value: 'emissive', label: 'Emissive' },
        { value: 'hologram', label: 'Hologram' },
        { value: 'matcap', label: 'Matcap' },
        { value: 'wire', label: 'Wire grid' },
      ],
    },
    baseColor: { type: 'color', default: [0.9, 0.9, 0.95, 1], label: 'Color', hint: 'The surface color. On SDF 3D and Image to 3D it multiplies the shapes’ / picture’s own colors; 3D Object ignores its own Color while a Material is wired. Multiplies the color map too.' },
    roughness: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Roughness', group: 'Surface', visibleIf: (p) => ['plastic', 'metal', 'pbr', 'glass'].includes(p.model as string) },
    metallic: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Metallic', group: 'Surface', visibleIf: (p) => p.model === 'pbr' },
    specular: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Specular', group: 'Surface', visibleIf: (p) => ['plastic', 'metal', 'pbr', 'glass', 'toon'].includes(p.model as string) },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity', group: 'Surface', hint: 'Glass: 1 = the most opaque glass; the edges are always more opaque.' },
    emissionColor: { type: 'color', default: [1, 0.8, 0.4, 1], label: 'Emission color', group: 'Glow' },
    emissionStrength: { type: 'number', default: 0, min: 0, max: 4, step: 0.01, softMax: 3, label: 'Emission', group: 'Glow', hint: 'Light the surface gives off. Emissive material: 0.4 plus this.' },
    rimColor: { type: 'color', default: [0.7, 0.9, 1, 1], label: 'Rim color', group: 'Glow' },
    rimStrength: { type: 'number', default: 0, min: 0, max: 2, step: 0.01, label: 'Rim / fresnel', group: 'Glow', hint: 'Light on the edges facing away from the viewer. Hologram: the glow.' },
    rimPower: { type: 'number', default: 3, min: 0.5, max: 8, step: 0.1, label: 'Rim width', group: 'Glow', hint: 'Higher = thinner rim.' },
    toonBands: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Toon bands', group: 'Toon', visibleIf: (p) => p.model === 'toon' },
    outline: { type: 'number', default: 0.25, min: 0, max: 0.7, step: 0.01, label: 'Outline width', group: 'Toon', hint: 'Dark edge where the surface turns away from the viewer.', visibleIf: (p) => p.model === 'toon' },
    scanLines: { type: 'number', default: 10, min: 2, max: 200, step: 1, softMax: 60, label: 'Scanlines per unit', group: 'Hologram', visibleIf: (p) => p.model === 'hologram' },
    holoCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Scan motion', group: 'Hologram', hint: '0 = still. Whole cycles per loop, so it loops exactly.', visibleIf: (p) => p.model === 'hologram' },
    wireScale: { type: 'number', default: 5, min: 1, max: 40, step: 0.5, softMax: 30, label: 'Cells per unit', group: 'Wire', visibleIf: (p) => p.model === 'wire' },
    wireWidth: { type: 'number', default: 0.08, min: 0.005, max: 0.3, step: 0.005, label: 'Line width', group: 'Wire', visibleIf: (p) => p.model === 'wire' },
    refraction: { type: 'number', default: 0.12, min: 0, max: 0.6, step: 0.005, label: 'Refraction', group: 'Glass', visibleIf: (p) => p.model === 'glass' },
    skyTop: { type: 'color', default: [0.55, 0.7, 0.95, 1], label: 'Sky top', group: 'Environment', hint: 'Used for reflections and ambient light when no Environment picture is wired.' },
    skyHorizon: { type: 'color', default: [0.85, 0.88, 0.92, 1], label: 'Sky horizon', group: 'Environment' },
    skyBottom: { type: 'color', default: [0.25, 0.22, 0.2, 1], label: 'Sky ground', group: 'Environment' },
    envAmbient: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Env ambient', group: 'Environment', hint: 'Tints the ambient light with the sky or environment picture.' },
    mapScale: { type: 'number', default: 0.5, min: 0.02, max: 8, step: 0.01, label: 'Texture scale', group: 'Maps' },
    mapOffsetX: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Texture offset X', group: 'Maps' },
    mapOffsetY: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Texture offset Y', group: 'Maps' },
    triplanar: { type: 'bool', default: true, label: 'Triplanar mapping', group: 'Maps', hint: 'Project the pictures from three sides: right for shapes without UV coordinates (SDF, extrusions). Off = projected from the front only.' },
    normalStrength: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Normal strength', group: 'Maps' },
  },
  summary: (p) => `${p.model}${p.model === 'hologram' && p.holoCycles ? ' · animated' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const m = p.model;
    const lighting = m === 'matte' || m === 'clay' || m === 'plastic' || m === 'metal' || m === 'pbr' || m === 'glass' || m === 'toon';
    const model: MaterialValue['model'] = m === 'matte' || m === 'clay' ? 'lambert' : m === 'plastic' || m === 'metal' || m === 'pbr' ? 'pbr' : (m as MaterialValue['model']);
    const metal = m === 'metal' ? 1 : m === 'plastic' ? 0 : p.metallic;
    const rough = m === 'metal' ? Math.max(0.05, p.roughness) : p.roughness;
    const spec = m === 'matte' || m === 'clay' ? 0 : p.specular;
    const phase = m === 'hologram' && p.holoCycles > 0 ? ctx.time.phase : 0;
    const emit = m === 'emissive' ? 0.4 + p.emissionStrength : p.emissionStrength;
    const alphaBase = m === 'glass' ? Math.max(0.02, p.opacity * 0.3) : p.opacity;
    const rgb = (c: readonly number[]): [number, number, number] => [c[0], c[1], c[2]];
    const material: MaterialValue = {
      kind: 'material',
      model,
      flags: {
        clay: m === 'clay',
        triplanar: p.triplanar,
        emission: emit > 0 || !!ctx.in.emissionMap,
        rim: p.rimStrength > 0 || m === 'hologram',
        sky: model === 'pbr' || model === 'glass',
        envAmbient: lighting && p.envAmbient > 0,
      },
      base: rgb(p.baseColor),
      a: [rough, metal, spec, alphaBase],
      b: [p.emissionColor[0], p.emissionColor[1], p.emissionColor[2], emit],
      c: [p.rimColor[0], p.rimColor[1], p.rimColor[2], m === 'hologram' ? Math.max(0.3, p.rimStrength) : p.rimStrength],
      d: [p.mapScale, p.mapOffsetX, p.mapOffsetY, TAU * p.holoCycles * phase],
      e: [p.toonBands, p.outline, m === 'wire' ? p.wireScale : p.scanLines, p.envAmbient],
      f: [p.rimPower, m === 'wire' ? p.wireWidth : p.refraction, p.normalStrength, 0],
      skyTop: rgb(p.skyTop),
      skyHorizon: rgb(p.skyHorizon),
      skyBottom: rgb(p.skyBottom),
      maps: {
        colorMap: ctx.in.colorMap,
        normalMap: ctx.in.normalMap,
        roughnessMap: ctx.in.roughnessMap,
        emissionMap: ctx.in.emissionMap,
        matcap: ctx.in.matcap,
        environment: ctx.in.environment,
        background: ctx.in.background,
      },
    };
    return { material };
  },
});
