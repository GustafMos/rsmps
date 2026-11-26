/**
 * Start-screen templates. A template is an ordinary graph in the preset format (`GraphDoc`) plus a little metadata. Most are generator
 * graphs that need no media; the rest reuse the built-in presets (a Media In shows its "Drop your clip here" label while it is empty).
 * Every template is evaluated at frame 0 against the real registry by templates.test.ts, so they cannot rot.
 */
import { DEFAULT_PROJECT, type Edge, type GraphDoc, type NodeInstance, type ProjectSettings } from '../engine/types';

export const TEMPLATE_GROUPS = ['Pixel art', 'Video art', '3D', 'Paper & scan', 'Audio-reactive', 'Color', 'Film', 'Captions'] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export type TemplateNeeds = 'clip' | 'image' | 'sound' | 'photos';
export const NEEDS_TEXT: Record<TemplateNeeds, string> = {
  clip: 'Needs a clip: drop yours on the Media In node',
  image: 'Needs a picture: drop yours on the Media In node',
  sound: 'Needs a clip with sound',
  photos: 'Made for photos of drawings',
};

export interface Template {
  id: string;
  title: string;
  group: TemplateGroup;
  description: string;
  needs?: TemplateNeeds;
  /** Node ids the template needs to exist in the registry (a missing one hides the template instead of breaking it). */
  requires: string[];
  graph: GraphDoc;
}

interface Spec {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  label?: string;
}

const PROJECT: ProjectSettings = { ...DEFAULT_PROJECT, width: 1280, height: 720, fps: 24, duration: 4, loop: true };

/** Build a graph: `wires` are "from>to" (image sockets) or "from.port>to.port". Nodes are laid out left to right by depth. */
function build(name: string, specs: Spec[], wires: string[], project: Partial<ProjectSettings> = {}): GraphDoc {
  const edges: Edge[] = wires.map((w, i) => {
    const [a, b] = w.split('>');
    const [fn, fp = 'image'] = a.split('.');
    const [tn, tp = 'image'] = b.split('.');
    return { id: `e${i + 1}`, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
  });
  const depth = new Map<string, number>();
  const dep = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...edges.filter((e) => e.to.node === id).map((e) => dep(e.from.node, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const lane = new Map<number, number>();
  const nodes: NodeInstance[] = specs.map((s) => {
    const d = dep(s.id);
    const l = lane.get(d) ?? 0;
    lane.set(d, l + 1);
    return { id: s.id, type: s.type, x: d * 260, y: l * 170, params: s.params ?? {}, ...(s.label ? { label: s.label } : {}) };
  });
  return { schema: 'rsmps/graph', version: 2, name, project: { ...PROJECT, ...project }, nodes, edges };
}

const OUT: Spec = { id: 'out', type: 'image-out' };

const builtinModules = import.meta.glob('./presets/*.json', { eager: true, import: 'default' }) as Record<string, GraphDoc>;
function builtin(stem: string): GraphDoc {
  const g = builtinModules[`./presets/${stem}.json`];
  if (!g) throw new Error(`Missing built-in preset ${stem}`);
  return structuredClone(g);
}
const typesOf = (g: GraphDoc): string[] => [...new Set(g.nodes.map((n) => n.type))];

function make(t: Omit<Template, 'requires'> & { requires?: string[] }): Template {
  return { ...t, graph: { ...t.graph, name: t.title }, requires: t.requires ?? typesOf(t.graph) };
}

const gold = [0.95, 0.72, 0.25, 1];

export const TEMPLATES: Template[] = [
  /* ------------------------------------------ Pixel art ------------------------------------------ */
  make({
    id: 'pixel-dither',
    title: 'Pixel art with dither',
    group: 'Pixel art',
    description: 'A soft gradient turned into chunky pixels and a 16-color dither. Swap the generator for your picture.',
    graph: build(
      'Pixel art with dither',
      [
        { id: 'src', type: 'gradient', params: { kind: 'radial', scale: 1.1 }, label: 'Replace with your picture' },
        { id: 'pix', type: 'pixelate', params: { mode: 'fixed-height', value: 90 } },
        { id: 'dith', type: 'dither', params: { fallback: 'sweetie-16', algorithm: 'bayer-4', strength: 0.9 } },
        OUT,
      ],
      ['src>pix', 'pix>dith', 'dith>out'],
      { width: 640, height: 360 },
    ),
  }),
  make({
    id: 'gameboy-plasma',
    title: 'Game Boy plasma',
    group: 'Pixel art',
    description: 'Scrolling noise in the four greens of a handheld, with scanlines. Loops exactly.',
    graph: build(
      'Game Boy plasma',
      [
        { id: 'src', type: 'noise', params: { scale: 90, octaves: 3 } },
        { id: 'scr', type: 'scroll', params: { cyclesX: 1, cyclesY: 0 } },
        { id: 'pix', type: 'pixelate', params: { mode: 'fixed-height', value: 144 } },
        { id: 'pal', type: 'quantize', params: { fallback: 'gameboy-dmg' } },
        { id: 'lines', type: 'scanlines', params: { spacing: 3, strength: 0.2 } },
        OUT,
      ],
      ['src>scr', 'scr>pix', 'pix>pal', 'pal>lines', 'lines>out'],
      { width: 640, height: 576 },
    ),
  }),
  make({ id: 'pixel-crt', title: 'Pixel art on a CRT', group: 'Pixel art', description: 'Your pixel art or clip, cleaned and shown on a curved arcade monitor.', needs: 'image', graph: builtin('pixel-art-crt') }),

  /* ------------------------------------------ Video art ------------------------------------------ */
  make({
    id: 'logo-zoom',
    title: 'Logo fall with Infinite Zoom',
    group: 'Video art',
    description: 'A letter that keeps falling into its own hole. Type another letter, or put a logo with a hole in it in place of the text.',
    graph: build(
      'Logo fall with Infinite Zoom',
      [
        { id: 'bg', type: 'voronoi', params: { mode: 'cells', scale: 140, motion: 0 } },
        { id: 'logo', type: 'text', params: { text: 'O', fontSize: 760, weight: 900 }, label: 'Your logo here' },
        { id: 'zoom', type: 'infinite-zoom', params: { scale: 0.32, levels: 8, speed: 1, dissolve: 0.3 } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        { id: 'glow', type: 'bloom', params: { intensity: 0.5 } },
        OUT,
      ],
      ['logo>zoom', 'bg>comp.background', 'zoom>comp.foreground', 'comp>glow', 'glow>out'],
    ),
  }),
  make({
    id: 'feedback-tunnel',
    title: 'Feedback tunnel',
    group: 'Video art',
    description: 'A spinning star fed back into itself: a color-shifting tunnel with a glow.',
    graph: build(
      'Feedback tunnel',
      [
        { id: 'bg', type: 'solid', params: { color: [0.02, 0.02, 0.05, 1] } },
        { id: 'star', type: 'shape', params: { kind: 'star', width: 0.28, height: 0.28, fill: [1, 0.55, 0.25, 1], rotation: 12 } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        { id: 'fb', type: 'feedback', params: { decay: 0.93, zoom: 1.03, rotate: 2, hueShift: 8 } },
        { id: 'glow', type: 'bloom', params: { intensity: 0.7 } },
        OUT,
      ],
      ['bg>comp.background', 'star>comp.foreground', 'comp>fb', 'fb>glow', 'glow>out'],
    ),
  }),
  make({
    id: 'vhs-card',
    title: 'VHS look',
    group: 'Video art',
    description: 'A test card through tape wobble, color bleed, scanlines and grain. Put your clip in front of the analog node to use it.',
    graph: build(
      'VHS look',
      [
        { id: 'card', type: 'gradient', params: { kind: 'linear', angle: 0 }, label: 'Replace with your clip' },
        { id: 'txt', type: 'text', params: { text: 'PLAY', fontSize: 160, color: [0.9, 0.95, 0.9, 1] } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        { id: 'vhs', type: 'analog-video', params: { preset: 'vhs', animate: true } },
        { id: 'ca', type: 'chromatic-aberration', params: { amount: 3 } },
        { id: 'lines', type: 'scanlines', params: { spacing: 3, strength: 0.18 } },
        { id: 'grain', type: 'grain', params: { amount: 0.14, animated: true } },
        { id: 'vig', type: 'vignette', params: { amount: 0.4 } },
        OUT,
      ],
      ['card>comp.background', 'txt>comp.foreground', 'comp>vhs', 'vhs>ca', 'ca>lines', 'lines>grain', 'grain>vig', 'vig>out'],
    ),
  }),
  make({
    id: 'kaleido-glow',
    title: 'Kaleidoscope',
    group: 'Video art',
    description: 'Six-fold mirror of a slowly turning color field. Loops exactly.',
    graph: build(
      'Kaleidoscope',
      [
        { id: 'src', type: 'gradient', params: { kind: 'angular', cycles: 2, animate: 'rotate' } },
        { id: 'kal', type: 'kaleidoscope', params: { segments: 8, spin: 1 } },
        { id: 'glow', type: 'bloom', params: { intensity: 0.6 } },
        OUT,
      ],
      ['src>kal', 'kal>glow', 'glow>out'],
    ),
  }),

  /* ------------------------------------------ 3D ------------------------------------------ */
  make({
    id: 'lit-logo',
    title: 'Lit 2D logo',
    group: '3D',
    description: 'Flat text turned into a bevelled gold object lit by a sweeping light. Replace the text with your logo.',
    graph: build(
      'Lit 2D logo',
      [
        { id: 'logo', type: 'text', params: { text: 'LOGO', fontSize: 300, weight: 900 }, label: 'Your logo here' },
        { id: 'mat', type: 'material', params: { model: 'metal', baseColor: gold, roughness: 0.25, metallic: 1 } },
        { id: 'lit', type: 'material-2d', params: { bevelWidth: 22, depth: 1.2, sweep: 1, shadow: 0.6 } },
        { id: 'bg', type: 'gradient', params: { kind: 'radial', scale: 1.4 } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        OUT,
      ],
      ['logo>lit', 'mat.material>lit.material', 'bg>comp.background', 'lit>comp.foreground', 'comp>out'],
    ),
  }),

  make({
    id: 'marker-object',
    title: 'An object standing on a marker',
    group: '3D',
    description: 'Augmented reality with a printed marker. Put a Webcam (back camera) in place of the marker picture, print the marker from Marker Camera, and walk round it.',
    graph: build(
      'An object standing on a marker',
      [
        { id: 'cam', type: 'marker', params: { marker: '1', fill: 0.3 }, label: 'Replace with a Webcam (back camera)' },
        { id: 'track', type: 'marker-camera', params: { marker: 'any', fov: 45, objectSize: 1, floor: -0.55, lost: 'fade' }, label: 'Print the marker here' },
        { id: 'obj', type: 'object-3d', params: { shape: 'cube', rotX: 0, rotY: 30, rotZ: 0, baseColor: gold } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        OUT,
      ],
      ['cam>track', 'track.camera>obj.camera', 'track.picture>obj.size', 'track.picture>comp.background', 'obj>comp.foreground', 'comp>out'],
    ),
  }),

  /* ------------------------------------------ Paper & scan ------------------------------------------ */
  make({ id: 'scan-cleanup', title: 'Scanned drawing cleanup', group: 'Paper & scan', description: 'Photos or scans of pencil drawings: remove the paper, keep the line.', needs: 'photos', graph: builtin('scanned-drawing-cleanup') }),
  make({ id: 'scan-relief', title: 'Scan line relief', group: 'Paper & scan', description: 'Turns scanned lines into lit, raised relief.', needs: 'photos', graph: builtin('scan-line-relief') }),

  /* ------------------------------------------ Audio-reactive ------------------------------------------ */
  make({
    id: 'pulse-circle',
    title: 'Pulse to the beat',
    group: 'Audio-reactive',
    description: 'A circle that swells with the loudness of your clip. Drop a clip with sound on the Media In node.',
    needs: 'sound',
    graph: build(
      'Pulse to the beat',
      [
        { id: 'src', type: 'media-in', label: 'Drop your clip with sound here' },
        { id: 'level', type: 'audio-level', params: { attack: 10, release: 160 } },
        { id: 'bg', type: 'gradient', params: { kind: 'radial', scale: 1.3 } },
        { id: 'dot', type: 'shape', params: { kind: 'ellipse', width: 0.2, height: 0.2, fill: [1, 0.55, 0.25, 1] } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        { id: 'glow', type: 'bloom', params: { intensity: 0.8 } },
        OUT,
      ],
      ['src.audio>level.audio', 'level.level>dot.width', 'level.level>dot.height', 'bg>comp.background', 'dot>comp.foreground', 'comp>glow', 'glow>out'],
    ),
  }),

  /* ------------------------------------------ Color ------------------------------------------ */
  make({
    id: 'teal-orange',
    title: 'Teal and orange grade',
    group: 'Color',
    description: 'The classic split-tone look on a colorful test field. Move the same nodes in front of your clip.',
    graph: build(
      'Teal and orange grade',
      [
        { id: 'src', type: 'voronoi', params: { mode: 'cells', scale: 160, motion: 0 }, label: 'Replace with your clip' },
        { id: 'wheels', type: 'color-wheels', params: { liftColor: [0.4, 0.52, 0.56, 1], gainColor: [0.56, 0.5, 0.42, 1], contrast: 1.1, saturation: 1.1 } },
        { id: 'lv', type: 'levels', params: { gamma: 1.05 } },
        { id: 'vig', type: 'vignette', params: { amount: 0.35 } },
        OUT,
      ],
      ['src>wheels', 'wheels>lv', 'lv>vig', 'vig>out'],
    ),
  }),
  make({
    id: 'halftone-poster',
    title: 'Halftone poster',
    group: 'Color',
    description: 'Newsprint dots in cyan, magenta, yellow and black from a smooth gradient.',
    graph: build(
      'Halftone poster',
      [
        { id: 'src', type: 'gradient', params: { kind: 'radial', scale: 1.2 }, label: 'Replace with your picture' },
        { id: 'ht', type: 'halftone', params: { mode: 'cmyk', dotSize: 10 } },
        OUT,
      ],
      ['src>ht', 'ht>out'],
    ),
  }),

  /* ------------------------------------------ Film ------------------------------------------ */
  make({
    id: 'film-super8',
    title: 'Super 8 home movie',
    group: 'Film',
    description: 'Warm consumer film, a wide red halo, heavy grain, dust, an unsteady gate at 18 frames a second, a held camera and light leaks. Put your clip in place of the first node.',
    graph: build(
      'Super 8 home movie',
      [
        { id: 'src', type: 'voronoi', params: { mode: 'cells', scale: 160, motion: 0 }, label: 'Replace with your clip' },
        { id: 'shake', type: 'camera-shake', params: { look: 'calm' } },
        { id: 'stock', type: 'film-stock', params: { stock: 'gold200', exposure: 0.3 } },
        { id: 'halo', type: 'halation', params: { look: 'super8' } },
        { id: 'gauge', type: 'film-gauge', params: { gauge: 'super8', ownWeave: false } },
        { id: 'weave', type: 'gate-weave', params: { look: 'super8', rate: '18' } },
        { id: 'leak', type: 'light-leak', params: { look: 'subtle' } },
        OUT,
      ],
      ['src>shake', 'shake>stock', 'stock>halo', 'halo>gauge', 'gauge>weave', 'weave>leak', 'leak>out'],
    ),
  }),
  make({
    id: 'film-16-documentary',
    title: '16mm documentary',
    group: 'Film',
    description: 'Black-and-white 16mm from the shoulder: classic 400 stock, a white halo, visible grain, a nervous camera and a gate that never sits still.',
    graph: build(
      '16mm documentary',
      [
        { id: 'src', type: 'voronoi', params: { mode: 'cells', scale: 160, motion: 0 }, label: 'Replace with your clip' },
        { id: 'shake', type: 'camera-shake', params: { look: 'documentary' } },
        { id: 'stock', type: 'film-stock', params: { stock: 'bw400' } },
        { id: 'halo', type: 'halation', params: { look: 'bw' } },
        { id: 'gauge', type: 'film-gauge', params: { gauge: 'film16', ownWeave: false } },
        { id: 'weave', type: 'gate-weave', params: { look: 'film16' } },
        OUT,
      ],
      ['src>shake', 'shake>stock', 'stock>halo', 'halo>gauge', 'gauge>weave', 'weave>out'],
    ),
  }),
  make({
    id: 'film-35-cinema',
    title: '35mm cinema',
    group: 'Film',
    description: 'The quiet version: cinema daylight stock, the thin halo of 35mm, fine grain, a camera breathing on its tripod and a gate that is almost steady.',
    graph: build(
      '35mm cinema',
      [
        { id: 'src', type: 'voronoi', params: { mode: 'cells', scale: 160, motion: 0 }, label: 'Replace with your clip' },
        { id: 'shake', type: 'camera-shake', params: { look: 'tripod' } },
        { id: 'stock', type: 'film-stock', params: { stock: 'daylight250' } },
        { id: 'halo', type: 'halation', params: { look: 'film35' } },
        { id: 'gauge', type: 'film-gauge', params: { gauge: 'film35', ownWeave: false } },
        { id: 'weave', type: 'gate-weave', params: { look: 'camera35' } },
        OUT,
      ],
      ['src>shake', 'shake>stock', 'stock>halo', 'halo>gauge', 'gauge>weave', 'weave>out'],
    ),
  }),

  /* ------------------------------------------ Captions ------------------------------------------ */
  make({
    id: 'karaoke-captions',
    title: 'Karaoke captions',
    group: 'Captions',
    description: 'Word-by-word highlighted captions over a gradient. Type your lines in the Captions node or load a subtitle file.',
    graph: build(
      'Karaoke captions',
      [
        { id: 'bg', type: 'gradient', params: { kind: 'linear', angle: 90 } },
        { id: 'cap', type: 'subtitles', params: { preset: 'karaoke', mode: 'karaoke', position: 'center' } },
        { id: 'comp', type: 'merge', params: { mode: 'normal' } },
        OUT,
      ],
      ['bg>cap', 'bg>comp.background', 'cap>comp.foreground', 'comp>out'],
      { width: 720, height: 1280 },
    ),
  }),
];

export const templateGroups = (list: readonly Template[] = TEMPLATES): { group: TemplateGroup; items: Template[] }[] =>
  TEMPLATE_GROUPS.map((group) => ({ group, items: list.filter((t) => t.group === group) })).filter((g) => g.items.length);

/** Templates whose nodes all exist in this registry (a missing node type hides the template; it never breaks the gallery). */
export function availableTemplates(registry: { get(id: string): unknown }): Template[] {
  return TEMPLATES.filter((t) => t.requires.every((id) => !!registry.get(id)));
}

/** A fresh copy of a template's graph (templates are shared constants; never hand the original to the editor). */
export const templateGraph = (t: Template): GraphDoc => structuredClone(t.graph);

/** True when a project has nothing in it yet: only empty media sources and outputs (what a new tab starts with). */
export function isBlankGraph(graph: GraphDoc, registry: { get(id: string): { category?: string } | undefined }): boolean {
  if (graph.nodes.length > 4) return false;
  return graph.nodes.every((n) => {
    const cat = registry.get(n.type)?.category;
    if (cat === 'output') return true;
    if (cat === 'input') return !Array.isArray(n.params.assets) || n.params.assets.length === 0;
    return false;
  });
}

/** Short stable hash of a template (cache key for its thumbnail: editing the template makes a new picture). */
export function templateHash(t: Template): string {
  const s = JSON.stringify(t.graph);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
