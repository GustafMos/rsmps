import { defineNode } from '../../define';
import { wholeCycles } from '../../lib/loop-snap';
import { sdfMod, sdfValue } from '../../lib/sdf-scene';
import type { SdfNode } from '../../types';

/**
 * SDF Modify: one change applied to everything that comes in. Each is a DOMAIN change (space is folded, repeated or bent before the
 * shapes see it) or a DISTANCE change (the surface is grown, hollowed or roughened).
 *
 * Exact distances: Mirror, Repeat, Round and Shell. INEXACT: Twist, Bend and Displace (the stored distance is too long). The renderer
 * shortens its steps for scenes that contain them (`sdfStepScale`), so they cost a few more steps and a strong effect can still show
 * small gaps; the Quality setting of the scene helps.
 */
const AXES = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
];
const is = (m: string) => (p: Record<string, unknown>) => p.modifier === m;

export default defineNode({
  id: 'sdf-modify',
  title: 'SDF Modify',
  category: 'sdf',
  description: 'Changes everything that comes in: Mirror it, Repeat it in a grid, Round its edges, make it a hollow Shell, Twist or Bend it, or roughen it with noise (Displace).',
  keywords: ['sdf', 'mirror', 'repeat', 'array', 'round', 'shell', 'hollow', 'twist', 'bend', 'displace', 'noise', 'symmetry', 'model'],
  inputs: { scene: { type: 'sdf', required: true, label: 'Shapes' } },
  outputs: { sdf: { type: 'sdf', label: 'Modified' } },
  params: {
    modifier: {
      type: 'enum',
      default: 'mirror',
      label: 'Modifier',
      options: [
        { value: 'mirror', label: 'Mirror' },
        { value: 'repeat', label: 'Repeat' },
        { value: 'round', label: 'Round' },
        { value: 'shell', label: 'Shell' },
        { value: 'twist', label: 'Twist' },
        { value: 'bend', label: 'Bend' },
        { value: 'displace', label: 'Displace by noise' },
      ],
    },
    mirrorX: { type: 'bool', default: true, label: 'Mirror X', hint: 'Copy across the plane x = 0.', visibleIf: is('mirror') },
    mirrorY: { type: 'bool', default: false, label: 'Mirror Y', visibleIf: is('mirror') },
    mirrorZ: { type: 'bool', default: false, label: 'Mirror Z', visibleIf: is('mirror') },
    countX: { type: 'number', default: 3, min: 1, max: 32, softMax: 16, step: 1, integer: true, label: 'Copies X', hint: 'How many copies along x, centred on the middle. 1 = none.', visibleIf: is('repeat') },
    countY: { type: 'number', default: 1, min: 1, max: 32, softMax: 16, step: 1, integer: true, label: 'Copies Y', visibleIf: is('repeat') },
    countZ: { type: 'number', default: 1, min: 1, max: 32, softMax: 16, step: 1, integer: true, label: 'Copies Z', visibleIf: is('repeat') },
    spacingX: { type: 'number', default: 1.5, min: 0.05, max: 20, step: 0.01, label: 'Spacing X', hint: 'Distance between copies. Keep it larger than the shape so copies do not overlap.', visibleIf: is('repeat') },
    spacingY: { type: 'number', default: 1.5, min: 0.05, max: 20, step: 0.01, label: 'Spacing Y', visibleIf: is('repeat') },
    spacingZ: { type: 'number', default: 1.5, min: 0.05, max: 20, step: 0.01, label: 'Spacing Z', visibleIf: is('repeat') },
    roundAmount: { type: 'number', default: 0.1, min: 0, max: 2, step: 0.005, label: 'Rounding', hint: 'Grows the shapes by this much with soft edges.', visibleIf: is('round') },
    thickness: { type: 'number', default: 0.08, min: 0.001, max: 2, step: 0.005, label: 'Wall thickness', hint: 'Hollows the shapes into a skin this thick.', visibleIf: is('shell') },
    axis: { type: 'enum', default: 'y', label: 'Axis', options: AXES, visibleIf: (p) => p.modifier === 'twist' || p.modifier === 'bend' },
    twistAmount: { type: 'number', default: 45, min: -360, max: 360, step: 1, unit: 'deg', label: 'Twist per unit', hint: 'Degrees of turn for every scene unit along the axis. Inexact distance: the tracer takes smaller steps.', visibleIf: is('twist') },
    bendAmount: { type: 'number', default: 30, min: -360, max: 360, step: 1, unit: 'deg', label: 'Bend per unit', hint: 'Degrees of bend for every scene unit along the axis. Inexact distance: the tracer takes smaller steps.', visibleIf: is('bend') },
    displaceAmount: { type: 'number', default: 0.1, min: -1, max: 1, step: 0.005, label: 'Amount', hint: 'How far the surface moves in and out. Inexact distance: the tracer takes smaller steps.', visibleIf: is('displace') },
    noiseScale: { type: 'number', default: 2, min: 0.1, max: 20, step: 0.05, label: 'Noise size', hint: 'Bumps per scene unit.', visibleIf: is('displace') },
    loops: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Animate', hint: 'Whole times the noise cycles back to where it started per loop. 0 = still.', visibleIf: is('displace') },
  },
  titleSuffix: (p) => String(p.modifier).replace(/^./, (c) => c.toUpperCase()),
  summary: (p) => String(p.modifier),
  render(ctx) {
    const v = ctx.in.scene;
    if (!v.root) return { sdf: v };
    const p = ctx.params;
    const id = ctx.path;
    const deg = Math.PI / 180;
    const axis = p.axis === 'x' ? 0 : p.axis === 'z' ? 2 : 1;
    let node: SdfNode;
    switch (p.modifier) {
      case 'repeat':
        node = sdfMod(id, 'repeat', v.root, { v: [p.countX, p.countY, p.countZ, 0, p.spacingX, p.spacingY, p.spacingZ, 0] });
        break;
      case 'round':
        node = sdfMod(id, 'round', v.root, { v: [p.roundAmount] });
        break;
      case 'shell':
        node = sdfMod(id, 'shell', v.root, { v: [p.thickness] });
        break;
      case 'twist':
        node = sdfMod(id, 'twist', v.root, { axis, v: [p.twistAmount * deg] });
        break;
      case 'bend':
        node = sdfMod(id, 'bend', v.root, { axis, v: [p.bendAmount * deg] });
        break;
      case 'displace': {
        // the clock is read only when the noise is animated, so a still displacement stays cached
        let theta = 0;
        if (p.loops !== 0) theta = Math.PI * 2 * ctx.time.phase * wholeCycles(p.loops, ctx.time.loop);
        node = sdfMod(id, 'displace', v.root, { v: [p.displaceAmount, p.noiseScale, theta] });
        break;
      }
      default:
        node = sdfMod(id, 'mirror', v.root, { axes: [p.mirrorX, p.mirrorY, p.mirrorZ] });
    }
    return { sdf: sdfValue(node, v.picture) };
  },
});
