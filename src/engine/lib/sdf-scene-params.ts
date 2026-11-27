/**
 * The render settings of an SDF Scene, in one place: the inner Scene Output node (`sdf-render`) declares them, and the scene's group node
 * shows them (group.ts `groupDefOf` uses this schema, with its groups and conditions, instead of the plain snapshot other exposed params get).
 */
import { GROUND_PARAMS, LIGHT_FROM_CAMERA_PARAM, LIGHT_PARAMS, QUALITY_PARAM, SHADE_PARAMS, XFORM_PARAMS } from './gen-3d';
import type { InputDef, ParamSchema } from '../types';

/** Id of the Scene Output node inside every SDF Scene (its group's marker `sdfScene` and the wiring rely on it). */
export const SDF_RENDER_ID = 'render';
export const SDF_RENDER_TYPE = 'sdf-render';

export const SDF_SCENE_PARAMS = {
  ...XFORM_PARAMS,
  // a scene starts square to the camera; turn it here (or with the viewer handles) to look around the model
  rotX: { ...XFORM_PARAMS.rotX, default: 0, hint: 'Turns the whole scene. Tilt.' },
  rotY: { ...XFORM_PARAMS.rotY, default: 0, hint: 'Turns the whole scene. Turn.' },
  ...LIGHT_PARAMS,
  ...LIGHT_FROM_CAMERA_PARAM,
  ...GROUND_PARAMS,
  ...SHADE_PARAMS,
  ...QUALITY_PARAM,
  shape2dFrom: {
    type: 'enum',
    default: 'alpha',
    label: 'Picture from',
    group: 'Picture shapes',
    hint: 'Used by Extruded picture shapes. Alpha for logos and cut-outs, brightness for masks.',
    options: [
      { value: 'alpha', label: 'Alpha' },
      { value: 'brightness', label: 'Brightness' },
    ],
  },
  shape2dThreshold: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Picture threshold', group: 'Picture shapes' },
} satisfies ParamSchema;

/** Inputs of the Scene Output node other than the scene itself (they become ports of the scene's group). */
export const SDF_SCENE_EXTRA_INPUTS = {
  camera: { type: 'camera', label: 'Camera' },
  material: { type: 'material', label: 'Material' },
  size: { type: 'image', label: 'Size from' },
} as const satisfies Record<string, InputDef>;
