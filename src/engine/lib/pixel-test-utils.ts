/** Test helpers for the pixel-art nodes: wire an image and palettes into a node through real `palette` nodes. */
import { addNode, connect, createGraph } from '../graph';
import type { Harness } from '../testing';
import type { ImageValue } from '../types';
import type { Rgb } from './pixel-color';

export async function runWithPalettes(
  t: Harness,
  type: string,
  params: Record<string, unknown>,
  image: ImageValue,
  palettes: Record<string, Rgb[]>,
): Promise<ImageValue> {
  let g = createGraph('pixel-test');
  const added = addNode(g, t.registry, type, { x: 0, y: 0 }, params);
  g = added.graph;
  const src = addNode(g, t.registry, t.source(image));
  g = connect(src.graph, t.registry, { node: src.node.id, port: 'out' }, { node: added.node.id, port: 'image' });
  for (const [port, colors] of Object.entries(palettes)) {
    const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'custom', custom: colors });
    g = connect(pal.graph, t.registry, { node: pal.node.id, port: 'palette' }, { node: added.node.id, port });
  }
  const value = (await t.evalGraph(g, added.node.id, { port: 'image' })) as ImageValue | null;
  if (!value || value.kind !== 'image') throw new Error(`${type} produced no image`);
  return value;
}

export const GREYS4: Rgb[] = [
  [0, 0, 0],
  [1 / 3, 1 / 3, 1 / 3],
  [2 / 3, 2 / 3, 2 / 3],
  [1, 1, 1],
];

export const BLACK_WHITE: Rgb[] = [
  [0, 0, 0],
  [1, 1, 1],
];

const GREY_LEVELS = new Set([0, 85, 170, 255]);

/**
 * Runs the given dither algorithms on a smooth horizontal gradient with a 4-grey palette and reports problems:
 * pixels that are not palette colours, lost alpha, or a quarter whose average brightness drifts from the source.
 * Default space is sRGB, where the mean of the encoded values is what dithering preserves. (In OKLab / linear the
 * perceptual mean is preserved instead, which shifts the sRGB mean of dark ramps by a few percent.)
 * (Counts instead of per-pixel `expect`s on purpose: see the note in dither-diffuse.test.ts.)
 */
export async function checkGradient(t: Harness, algorithms: string[], colorSpace: 'srgb' | 'oklab' | 'linear' = 'srgb', tolerance = 0.04): Promise<string[]> {
  const W = 256;
  const H = 32;
  const srcVal = (x: number) => Math.round((x / (W - 1)) * 255);
  const grad = t.fromFn(W, H, (x) => {
    const g = srcVal(x);
    return [g, g, g, 255];
  });
  const problems: string[] = [];
  for (const id of algorithms) {
    const px = await t.pixels(await runWithPalettes(t, 'dither', { algorithm: id, colorSpace }, grad, { palette: GREYS4 }));
    if (px.width !== W || px.height !== H) problems.push(`${id}: size ${px.width}x${px.height}`);
    const quarter = W / 4;
    let bad = 0;
    for (let q = 0; q < 4; q++) {
      let got = 0;
      let want = 0;
      for (let y = 0; y < H; y++) {
        for (let x = q * quarter; x < (q + 1) * quarter; x++) {
          const i = (y * W + x) * 4;
          const r = px.data[i];
          if (!GREY_LEVELS.has(r) || r !== px.data[i + 1] || r !== px.data[i + 2] || px.data[i + 3] !== 255) bad++;
          got += r / 255;
          want += srcVal(x) / 255;
        }
      }
      const n = quarter * H;
      // Hard threshold can only be as good as nearest-colour posterising (and OKLab midpoints are not sRGB midpoints).
      const tol = id === 'threshold' ? 0.08 : tolerance;
      if (Math.abs(got / n - want / n) >= tol) problems.push(`${id} quarter ${q}: got ${(got / n).toFixed(3)} want ${(want / n).toFixed(3)}`);
    }
    if (bad) problems.push(`${id}: ${bad} pixels are not palette colors / lost alpha`);
  }
  return problems;
}
