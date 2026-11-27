/**
 * Convert to SDF Scene: turns the settings of an SDF 3D node into the inside of an SDF Scene (a group node, see sdf-scene-group.ts) that
 * draws the same picture wherever the scene system has an equivalent, and says in plain words where it has not.
 *
 * Pure: it reads the node's params and which of its ports are wired, and returns the new group's params, where each wired port goes, and
 * the notes. The editor does the graph surgery (editor.convertToSdfScene).
 *
 * What maps how (SDF 3D -> SDF Scene):
 *  - every active slot becomes an SDF Shape (sizes are half sizes in SDF 3D, full widths in the Shape node, so box sizes double);
 *  - the slot chain `acc = op(acc, shape, smooth x gooeyness)` becomes SDF Combine nodes in slot order: the same operator and the same
 *    blend radius, so shape and colour blending are the same maths. Neighbouring hard joins of one operator share a single Combine;
 *  - Mirror, Shell, Twist, Bend, Inflate (as Round) and Repeat become SDF Modify nodes in the order SDF 3D applies them;
 *  - camera, spin, light, shading, quality, picture settings and the scene's own move / scale are the Scene Output settings on the group.
 * Approximated: endless Repeat (a limited number of copies), Noise displace (another noise pattern).
 * Not available: Morph 1 to 2, Kaleidoscope, Texture, Displace map, Taper, Melt, Explode, Low-fi snap, Morph to sphere.
 */
import { defaultParams } from '../engine';
import { GROUP_IN, GROUP_TYPE, type GroupPort } from '../group';
import { uid } from '../graph';
import { paramBundles, type Registry } from '../define';
import { newSdfScene, SDF_SHAPE_TYPE } from '../sdf-scene-group';
import { SDF_RENDER_ID, SDF_SCENE_PARAMS } from './sdf-scene-params';
import type { Edge, GraphDoc, NodeInstance, ParamDef, SocketType } from '../types';

export const SDF_3D_TYPE = 'sdf-3d';
/** Hint shown after converting. */
export const SDF_CONVERT_HINT = 'Double-click the scene to open it and move its shapes separately.';

const SLOTS = 8;
const SLOT_KEY = /^(shape|op|smooth|x|y|z|rx|ry|rz|size|sizeB|sizeC|color)(\d)$/;
const RADIUS_KINDS = ['sphere', 'octa', 'torus', 'capsule', 'cylinder', 'cone'];
/** Copies an endless Repeat is cut down to, by how many axes repeat (keeps the total small: at most 125 copies of the shapes). */
const REPEAT_COPIES = [1, 15, 9, 5];

export interface SdfConvertInput {
  /** The SDF 3D node's params (missing ones are filled with the defaults). */
  params: Record<string, unknown>;
  /** Names of the ports and params of the node that have a wire coming in. */
  wired: ReadonlySet<string>;
}

export interface SdfConvertResult {
  /** `params` of the new group node (an SDF Scene). */
  params: Record<string, unknown>;
  /** Where each wired incoming port goes on the new group: the group's port name, or null when the wire could not be carried over. */
  portMap: Record<string, string | null>;
  /** Plain-language things the person should know (empty = nothing lost). */
  notes: string[];
}

interface Slot {
  n: number;
  kind: string;
  op: 'union' | 'subtract' | 'intersect';
  smooth: number;
  y: number;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function convertSdf3dToScene(registry: Pick<Registry, 'get'>, input: SdfConvertInput): SdfConvertResult {
  const def3d = registry.get(SDF_3D_TYPE);
  const shapeDef = registry.get(SDF_SHAPE_TYPE);
  const combineDef = registry.get('sdf-combine');
  const modifyDef = registry.get('sdf-modify');
  if (!def3d || !shapeDef || !combineDef || !modifyDef) throw new Error('The SDF nodes are not available.');
  // a setting that is missing from an old node means what it meant then (`absent`), not today's default (Spin around)
  const p: Record<string, unknown> = { ...defaultParams(def3d) };
  for (const [key, d] of Object.entries(def3d.params as Record<string, ParamDef & { absent?: unknown }>)) if (input.params[key] === undefined && d.absent !== undefined) p[key] = d.absent;
  Object.assign(p, Object.fromEntries(Object.entries(input.params).filter(([, v]) => v !== undefined)));
  const wired = input.wired;
  const notes: string[] = [];
  const note = (s: string) => {
    if (!notes.includes(s)) notes.push(s);
  };
  const clamp = (def: ParamDef | undefined, v: number, what: string): number => {
    const d = def as { min?: number; max?: number } | undefined;
    let r = v;
    if (d?.max !== undefined && r > d.max) r = d.max;
    if (d?.min !== undefined && r < d.min) r = d.min;
    if (r !== v) note(`${what} was ${round(v)}; an SDF Scene allows ${round(r)} at most, so ${round(r)} is used.`);
    return r;
  };

  // --- the shapes that are actually drawn (the same rule as SDF 3D) --------------------------------------------------------
  const hasPicture = wired.has('shape2d');
  const slots: Slot[] = [];
  const gooey = num(p.gooey, 1);
  for (let i = 1; i <= SLOTS; i++) {
    const kind = String(p[`shape${i}`]);
    if (kind === 'off') continue;
    if (kind === 'image2d' && !hasPicture) {
      note(`Shape ${i} is a 2D picture but no picture is wired, so it was not drawn before and is left out.`);
      continue;
    }
    slots.push({ n: i, kind, op: (i > 1 ? p[`op${i}`] : 'union') as Slot['op'], smooth: i > 1 ? Math.max(0, num(p[`smooth${i}`]) * gooey) : 0, y: 0 });
  }
  const morph = p.morph === true && slots.length >= 2;
  if (morph) note(`Morph between shape ${slots[0].n} and ${slots[1].n} is not available in an SDF Scene yet; both shapes were kept as separate parts, joined with Union.`);

  // --- inner nodes and wires ---------------------------------------------------------------------------------------------
  const nodes: NodeInstance[] = [];
  const edges: Edge[] = [];
  const inputs: GroupPort[] = [{ id: 'camera', name: 'Camera', type: 'camera' }, { id: 'material', name: 'Material', type: 'material' }, { id: 'size', name: 'Size from', type: 'image' }];
  let edgeN = 0;
  const wire = (from: { node: string; port: string }, to: { node: string; port: string }) => edges.push({ id: `e${++edgeN}`, from, to });
  const ROW = 190;
  const COL = 250;
  const X0 = 40;
  const X1 = 380;

  const portMap: Record<string, string | null> = {};
  const usesPicture = slots.some((s) => s.kind === 'image2d');
  if (usesPicture) inputs.push({ id: 'picture', name: 'Picture', type: 'image' });

  const slotLabel = (key: string, n: number) => `Shape ${n} ${(def3d.params[`${key}${n}`] as ParamDef | undefined)?.label ?? key}`;
  // one group input per wired slot number that has a matching shape param (x1 -> Move X of that shape ...)
  const slotWire = (s: Slot, key: string, target: string, type: SocketType): void => {
    const port = `s${s.n}_${target}`;
    inputs.push({ id: port, name: slotLabel(key, s.n).slice(0, 24), type });
    wire({ node: GROUP_IN, port }, { node: `shape${s.n}`, port: target });
    portMap[`${key}${s.n}`] = port;
  };

  slots.forEach((s, a) => {
    s.y = 40 + a * ROW;
    const k = s.kind;
    const n = s.n;
    const size = [num(p[`size${n}`], 0.5), num(p[`sizeB${n}`], 0.5), num(p[`sizeC${n}`], 0.5)];
    const sp: Record<string, unknown> = { ...defaultParams(shapeDef), shape: k, color: structuredClone(p[`color${n}`]), posX: num(p[`x${n}`]), posY: num(p[`y${n}`]), posZ: num(p[`z${n}`]), objectScale: 1 };
    if (k !== 'sphere') Object.assign(sp, { rotX: num(p[`rx${n}`]), rotY: num(p[`ry${n}`]), rotZ: num(p[`rz${n}`]) });
    const d = shapeDef.params as Record<string, ParamDef>;
    // SDF 3D sizes are half sizes; the Shape node's widths are whole widths
    switch (k) {
      case 'box':
      case 'rbox':
        Object.assign(sp, { sizeX: clamp(d.sizeX, size[0] * 2, `Shape ${n} width`), sizeY: clamp(d.sizeY, size[1] * 2, `Shape ${n} height`), sizeZ: clamp(d.sizeZ, size[2] * 2, `Shape ${n} depth`) });
        break;
      case 'torus':
        Object.assign(sp, { radius: size[0], tube: clamp(d.tube, size[1], `Shape ${n} tube radius`) });
        break;
      case 'capsule':
      case 'cylinder':
      case 'cone':
        Object.assign(sp, { radius: size[0], sizeY: size[1] * 2 });
        break;
      case 'image2d':
        Object.assign(sp, { sizeX: size[0] * 2, sizeZ: size[1] * 2 });
        break;
      case 'plane':
        break;
      default:
        sp.radius = size[0];
    }
    nodes.push({ id: `shape${n}`, type: SDF_SHAPE_TYPE, x: X0, y: s.y, params: sp });
    if (k === 'image2d') wire({ node: GROUP_IN, port: 'picture' }, { node: `shape${n}`, port: 'picture' });

    // wires into this slot's params that a Shape param can take over
    const map: [string, string][] = [['x', 'posX'], ['y', 'posY'], ['z', 'posZ'], ['color', 'color']];
    if (k !== 'sphere') map.push(['rx', 'rotX'], ['ry', 'rotY'], ['rz', 'rotZ']);
    if (RADIUS_KINDS.includes(k)) map.push(['size', 'radius']);
    if (k === 'torus') map.push(['sizeB', 'tube']);
    for (const [key, target] of map) if (wired.has(`${key}${n}`)) slotWire(s, key, target, (def3d.params[`${key}${n}`] as ParamDef).type === 'color' ? 'color' : 'number');
  });

  // --- the combine chain, in slot order -----------------------------------------------------------------------------------
  let cur = slots.length ? `shape${slots[0].n}` : '';
  let open = null as { id: string; op: string } | null; // a hard Combine that a same-operator hard join can share
  let combines = 0;
  slots.forEach((s, j) => {
    if (j === 0) return;
    const op = morph && j === 1 ? 'union' : s.op;
    let smooth = s.smooth;
    if (smooth > 3) {
      note(`Shape ${s.n} blends with Smoothness x Gooeyness = ${round(smooth)}; an SDF Combine allows 3 at most, so 3 is used.`);
      smooth = 3;
    }
    const shape = `shape${s.n}`;
    if (open && smooth <= 0 && open.op === op) {
      wire({ node: shape, port: 'sdf' }, { node: open.id, port: 'items' });
      return;
    }
    combines++;
    const id = `combine${combines}`;
    nodes.push({ id, type: 'sdf-combine', x: X1 + (combines - 1) * COL, y: s.y, params: { ...defaultParams(combineDef), operation: op, smoothness: smooth } });
    wire({ node: cur, port: 'sdf' }, { node: id, port: 'items' });
    wire({ node: shape, port: 'sdf' }, { node: id, port: 'items' });
    cur = id;
    open = smooth <= 0 ? { id, op } : null;
  });

  // --- modifiers, in the order SDF 3D applies them (data flows from the shapes outwards: the last one is applied first) -------
  const mods: { id: string; params: Record<string, unknown> }[] = [];
  const md = modifyDef.params as Record<string, ParamDef>;
  const addMod = (id: string, params: Record<string, unknown>) => mods.push({ id, params: { ...defaultParams(modifyDef), ...params } });
  const dNoise = num(p.dNoise);
  if (dNoise !== 0) {
    addMod('displace', { modifier: 'displace', displaceAmount: dNoise, noiseScale: clamp(md.noiseScale, num(p.dNoiseScale, 1.5), 'Noise scale'), loops: Math.round(num(p.dNoiseCycles)) });
    note('Noise displace is approximated with the SDF Modify "Displace by noise": the bumps have the same size and strength but another pattern.');
  }
  const dInflate = num(p.dInflate);
  if (dInflate > 0) addMod('round', { modifier: 'round', roundAmount: clamp(md.roundAmount, dInflate, 'Inflate') });
  else if (dInflate < 0) note('Inflate with a negative amount (shrinking the whole surface) is not available in an SDF Scene; it was left out.');
  const shell = num(p.shell);
  if (shell > 0) addMod('shell', { modifier: 'shell', thickness: clamp(md.thickness, shell, 'Shell thickness') });
  const dBend = num(p.dBend);
  if (dBend !== 0) addMod('bend', { modifier: 'bend', axis: 'x', bendAmount: clamp(md.bendAmount, (dBend * 180) / Math.PI, 'Bend') });
  const dTwist = num(p.dTwist);
  // the Modify node turns the other way round, so the amount changes sign
  if (dTwist !== 0) addMod('twist', { modifier: 'twist', axis: 'y', twistAmount: clamp(md.twistAmount, -dTwist, 'Twist') });
  const mirror = [p.mirrorX === true, p.mirrorY === true, p.mirrorZ === true];
  if (mirror.some(Boolean)) addMod('mirror', { modifier: 'mirror', mirrorX: mirror[0], mirrorY: mirror[1], mirrorZ: mirror[2] });
  const rep = [p.repeatX === true, p.repeatY === true, p.repeatZ === true];
  const repAxes = rep.filter(Boolean).length;
  if (repAxes) {
    const c = REPEAT_COPIES[repAxes];
    const sp = clamp(md.spacingX, num(p.repeatSpacing, 3), 'Repeat spacing');
    addMod('repeat', { modifier: 'repeat', countX: rep[0] ? c : 1, countY: rep[1] ? c : 1, countZ: rep[2] ? c : 1, spacingX: sp, spacingY: sp, spacingZ: sp });
    note(`Repeat went on forever in SDF 3D; the scene makes ${c} copies along ${repAxes === 1 ? 'that direction' : 'each direction'}, centered on the middle. Raise Copies in the Repeat node for more.`);
  }
  // the SDF 3D chain: slots -> inflate -> shell -> twist/bend -> mirror -> repeat; the order above lists them inner to outer
  const yEnd = slots.length ? Math.max(40, slots[slots.length - 1].y) : 40;
  const xMods = X1 + Math.max(combines, 0) * COL;
  mods.forEach((m, i) => {
    nodes.push({ id: m.id, type: 'sdf-modify', x: xMods + i * COL, y: yEnd, params: m.params });
    if (cur) wire({ node: cur, port: 'sdf' }, { node: m.id, port: 'scene' });
    cur = m.id;
  });
  const renderDef = registry.get('sdf-render')!;
  nodes.push({ id: SDF_RENDER_ID, type: 'sdf-render', x: xMods + mods.length * COL, y: yEnd, params: defaultParams(renderDef) });
  if (cur) wire({ node: cur, port: 'sdf' }, { node: SDF_RENDER_ID, port: 'scene' });
  for (const port of inputs.map((i) => i.id).filter((id) => !id.includes('_') && id !== 'picture')) wire({ node: GROUP_IN, port }, { node: SDF_RENDER_ID, port });
  wire({ node: SDF_RENDER_ID, port: 'image' }, { node: '@out', port: 'image' });
  wire({ node: SDF_RENDER_ID, port: 'depth' }, { node: '@out', port: 'depth' });
  wire({ node: SDF_RENDER_ID, port: 'sdf' }, { node: '@out', port: 'sdf' });

  // --- features with no equivalent ------------------------------------------------------------------------------------------
  if (num(p.fold) >= 2) note('Kaleidoscope (copies around the vertical axis) is not available in an SDF Scene yet; it was left out.');
  if (wired.has('texture')) note('The Texture picture is not available in an SDF Scene yet; the shapes keep their plain colors.');
  if (wired.has('displaceMap')) note('The Displace map picture is not available in an SDF Scene yet; it was left out.');
  for (const [key, what] of [['dTaper', 'Taper'], ['dMelt', 'Melt'], ['dExplode', 'Explode'], ['dLowFi', 'Low-fi snap'], ['dMorph', 'Morph to sphere']] as const) {
    if (num(p[key]) !== 0) note(`${what} is not available in an SDF Scene yet; it was left out.`);
  }
  if (num(p.dMap) !== 0 && !wired.has('displaceMap')) note('Displace map has no picture wired, so it did nothing before; it is left out.');

  // --- the scene's own settings (camera, spin, light, shading, quality, picture) are the group's settings ---------------------
  const params: Record<string, unknown> = {};
  for (const key of Object.keys(SDF_SCENE_PARAMS)) if (key in p) params[key] = structuredClone(p[key]);
  const group = newSdfScene(registry, 'x', { x: 0, y: 0 }).params;
  Object.assign(group, params, { nodes, edges, inputs });

  // --- every other wired port --------------------------------------------------------------------------------------------------
  const bundles = paramBundles(def3d);
  const sceneKeys = new Set(Object.keys(SDF_SCENE_PARAMS));
  for (const port of wired) {
    if (port in portMap) continue;
    if (port === 'camera' || port === 'material' || port === 'size') portMap[port] = port;
    else if (port === 'shape2d') {
      portMap[port] = usesPicture ? 'picture' : null;
      if (!usesPicture) note('A picture is wired into 2D shape, but no shape uses it; the wire was not carried over.');
    } else if (sceneKeys.has(port)) portMap[port] = port;
    else {
      const b = bundles.find((x) => x.port === port);
      if (b && b.members.every((m) => sceneKeys.has(m))) portMap[port] = port;
      else portMap[port] = null;
    }
  }
  for (const [port, to] of Object.entries(portMap)) {
    if (to !== null) continue;
    if (port === 'texture' || port === 'displaceMap') continue; // said above
    if (port === 'shape2d') continue;
    const m = SLOT_KEY.exec(port);
    const label = m ? slotLabel(m[1], Number(m[2])) : ((def3d.params[port] as ParamDef | undefined)?.label ?? port);
    // a wired slot that is not drawn costs nothing
    if (m && !slots.some((s) => s.n === Number(m[2]))) continue;
    note(`${label} was wired to another node. The current value was used; the wire was not carried over.`);
  }
  return { params: group, portMap, notes };
}

const round = (v: number): string => String(Math.round(v * 100) / 100);

export interface SdfConversionApplied {
  graph: GraphDoc;
  /** The new SDF Scene's id (the old node's id when it was replaced). */
  id: string;
  notes: string[];
}

/**
 * The graph edit behind "Convert to SDF Scene": the SDF 3D node `nodeId` becomes an SDF Scene at the same place, with its outgoing wires
 * (Image, Depth) on the scene's outputs and its incoming wires on the matching scene inputs (wires that cannot go are dropped and named
 * in the notes). With `copy` the original stays and the scene is a new node beside it, wired to the same sources.
 */
export function applySdfConversion(graph: GraphDoc, registry: Pick<Registry, 'get'>, nodeId: string, copy = false): SdfConversionApplied | { error: string } {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== SDF_3D_TYPE) return { error: 'Only an SDF 3D node can be converted to an SDF Scene.' };
  const incoming = graph.edges.filter((e) => e.to.node === nodeId);
  const res = convertSdf3dToScene(registry, { params: node.params, wired: new Set(incoming.map((e) => e.to.port)) });
  const id = copy ? uid('n') : nodeId;
  const scene: NodeInstance = { id, type: GROUP_TYPE, x: node.x, y: copy ? node.y + 260 : node.y, params: res.params };
  if (node.label) scene.label = node.label;
  if (node.frame) scene.frame = node.frame;
  if (node.collapsed) scene.collapsed = true;
  if (node.bypass) scene.bypass = true;
  const carried: Edge[] = [];
  for (const e of incoming) {
    const port = res.portMap[e.to.port];
    if (port) carried.push({ ...e, id: copy ? uid('e') : e.id, to: { node: id, port } });
  }
  if (copy) return { graph: { ...graph, nodes: [...graph.nodes, scene], edges: [...graph.edges, ...carried] }, id, notes: res.notes };
  return {
    graph: {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === nodeId ? scene : n)),
      // incoming wires keep their place in the list (it is the order of a multi input); outgoing ones already name ports the scene has
      edges: graph.edges.flatMap((e) => (e.to.node !== nodeId ? [e] : carried.filter((c) => c.id === e.id))),
    },
    id,
    notes: res.notes,
  };
}
