/** Test helpers shared by the Material 2D, Normal Map and Displace by Map tests: shapes, a graph runner and the repo base scene. Tests only. */
import { join } from 'node:path';
import { addNode, connect, createGraph } from '../graph';
import { harness } from '../testing';
import type { ImageValue, Value } from '../types';
import type { Img } from './gen-3d-testutil';
import { readPngFile } from './png-testutil';

let shared: ReturnType<typeof harness> | null = null;
export const H = () => (shared ??= harness());

/** Signed distance of a logo-like shape: a ring with a bar through it. */
export const sdLogo = (x: number, y: number, s: number): number => {
  const cx = x - s / 2;
  const cy = y - s / 2;
  const r = Math.hypot(cx, cy);
  const ring = Math.max(r - s * 0.4, s * 0.22 - r);
  const bar = Math.max(Math.abs(cx) - s * 0.46, Math.abs(cy + s * 0.02) - s * 0.07);
  return Math.min(ring, bar);
};
/** Pixel function of the logo (anti-aliased, one colour on transparent). */
export const logoPx =
  (s: number, rgb: [number, number, number] = [0, 0, 0]) =>
  (x: number, y: number): [number, number, number, number] => {
    const a = Math.min(1, Math.max(0, 0.5 - sdLogo(x + 0.5, y + 0.5, s)));
    return [rgb[0], rgb[1], rgb[2], Math.round(a * 255)];
  };

export const at = (px: Img, x: number, y: number): number[] => [0, 1, 2, 3].map((c) => px.data[(y * px.width + x) * 4 + c]);
export const px8 = (px: Img, x: number, y: number, c: number): number => px.data[(y * px.width + x) * 4 + c];
export const lum = (px: Img, x: number, y: number): number => {
  const [r, g, b] = at(px, x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Run `node` (default Material 2D) with `image`, optionally behind a Material node, plus extra pictures on named inputs. */
export async function lit(
  image: ImageValue,
  mat: Record<string, unknown> | null,
  params: Record<string, unknown> = {},
  extra: Record<string, ImageValue> = {},
  opts: { seconds?: number; port?: string; matInputs?: Record<string, ImageValue>; node?: string } = {},
): Promise<{ image: Value | null; px: Img }> {
  const t = await H();
  let g = createGraph('m2d');
  g.project = { ...g.project, width: image.width, height: image.height, fps: 10, duration: 2, loop: true };
  const src = addNode(g, t.registry, t.source(image));
  g = src.graph;
  const n = addNode(g, t.registry, opts.node ?? 'material-2d', { x: 300, y: 0 }, params);
  g = connect(n.graph, t.registry, { node: src.node.id, port: 'out' }, { node: n.node.id, port: 'image' });
  if (mat) {
    const m = addNode(g, t.registry, 'material', { x: 100, y: 100 }, mat);
    g = m.graph;
    for (const [port, img] of Object.entries(opts.matInputs ?? {})) {
      const s = addNode(g, t.registry, t.source(img));
      g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: m.node.id, port });
    }
    g = connect(g, t.registry, { node: m.node.id, port: 'material' }, { node: n.node.id, port: 'material' });
  }
  for (const [port, img] of Object.entries(extra)) {
    const s = addNode(g, t.registry, t.source(img));
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: n.node.id, port });
  }
  const r = await t.engine.evaluate({ graph: g, node: n.node.id, port: opts.port ?? 'image', seconds: opts.seconds ?? 0 });
  if (r.errors.size) throw new Error([...r.errors.values()].join('; '));
  return { image: r.value, px: await t.pixels(r.value as ImageValue) };
}

/** The repo's base scene, shrunk 3x (box filter) so it stays quick. */
export async function baseScene(): Promise<ImageValue> {
  const t = await H();
  const full = readPngFile(join(process.cwd(), 'scripts/screenshots/assets/base-scene.png'));
  const w = Math.floor(full.width / 3);
  const h = Math.floor(full.height / 3);
  return t.fromFn(w, h, (x, y) => {
    const o = [0, 0, 0, 0];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) for (let c = 0; c < 4; c++) o[c] += full.data[((y * 3 + j) * full.width + x * 3 + i) * 4 + c] / 9;
    return [o[0], o[1], o[2], 255];
  });
}

/** The logo centred in a frame of w x h. */
export async function centredLogo(w: number, h: number, s: number, rgb: [number, number, number] = [0, 0, 0]): Promise<ImageValue> {
  const t = await H();
  const f = logoPx(s, rgb);
  return t.fromFn(w, h, (x, y) => {
    const lx = x - Math.round((w - s) / 2);
    const ly = y - Math.round((h - s) / 2);
    return lx < 0 || ly < 0 || lx >= s || ly >= s ? [rgb[0], rgb[1], rgb[2], 0] : f(lx, ly);
  });
}

/** An opaque 96 x 96 block inside a 128 x 128 transparent frame. */
export async function block(rgb: [number, number, number] = [255, 255, 255]): Promise<ImageValue> {
  const t = await H();
  return t.fromFn(128, 128, (x, y) => (x >= 16 && x < 112 && y >= 16 && y < 112 ? [rgb[0], rgb[1], rgb[2], 255] : [0, 0, 0, 0]));
}

/** Composite straight RGBA `fg` over `bg` (same size) for looking at. */
export function over(fg: Img, bg: Img): Img {
  const out = new Uint8ClampedArray(fg.data.length);
  for (let i = 0; i < fg.data.length; i += 4) {
    const a = fg.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = fg.data[i + c] * a + bg.data[i + c] * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, width: fg.width, height: fg.height };
}
