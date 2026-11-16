import { describe, expect, it, vi } from 'vitest';
import { movingSquareSource, scrollingTextureSource, stillSource } from '../../lib/video-art-testutil';
import { sourceChain } from '../../lib/util-testsource';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

const project = { loop: false, duration: 10, width: 32, height: 32 };
type H = Awaited<ReturnType<typeof harness>>;
const bytes = async (t: H, v: unknown) => new Uint8ClampedArray(await t.gpu.read(v as ImageValue, false));

describe('motion-smear', () => {
  it('holds the key frame and drags it along the motion', async () => {
    // 8x8 square moving 2 px/frame to the right; key frame at frame 0 (square at x 0..7). Plain textured motion is needed
    // for a reliable flow, so the square gets a smooth ground via the scrolling texture test below; here we check the held look.
    const t = await harness([movingSquareSource('ms-sq')]);
    const { graph, node } = sourceChain(t, 'ms-sq', 'motion-smear', { refresh: 100, block: 1, bleed: 1, resolution: 1 }, project);
    const at = async (f: number) => t.pixels((await t.evalGraph(graph, node, { seconds: f / 10 })) as ImageValue);
    const key = await at(0);
    expect(key.at(2, 16)[0]).toBe(255); // frame 0 = the square at x 0..7
    const later = await at(6); // the real square is at x 12..19; the smear starts from the held picture
    // the held picture still has material at its old place (x 0..7 was not wiped by a plain refresh)
    let heldLit = 0;
    for (let x = 0; x < 32; x++) if (later.at(x, 16)[0] > 100) heldLit++;
    expect(heldLit).toBeGreaterThan(3);
    // the real square at frame 6 would put full white at x=15; a held+smeared picture has it only where motion carried material
    expect(later.at(1, 16)[0]).toBeGreaterThan(20);
  });

  it('moves a textured picture by the measured motion (the smear follows the flow) and refreshes on schedule', async () => {
    const t = await harness([scrollingTextureSource('ms-scroll', [2, 0])]);
    const params = { refresh: 5, block: 1, bleed: 1, resolution: 1 };
    const { graph, node } = sourceChain(t, 'ms-scroll', 'motion-smear', params, { ...project, width: 64, height: 64 });
    const raw = sourceChain(t, 'ms-scroll', 'retime', {}, { ...project, width: 64, height: 64 });
    const at = async (g: typeof graph, n: string, f: number) => t.pixels((await t.evalGraph(g, n, { seconds: f / 10 })) as ImageValue);
    // at a key frame the picture is the clip itself
    const k = await at(graph, node, 5);
    const r5 = await at(raw.graph, raw.node, 5);
    expect(Math.abs(k.at(20, 20)[0] - r5.at(20, 20)[0])).toBeLessThanOrEqual(1);
    // three frames after the key frame, a pure translation is followed so closely that the smear stays near the real picture
    const m = await at(graph, node, 8);
    const r8 = await at(raw.graph, raw.node, 8);
    let err = 0;
    for (let y = 8; y < 56; y += 4) for (let x = 8; x < 56; x += 4) err += Math.abs(m.at(x, y)[0] - r8.at(x, y)[0]);
    expect(err / (12 * 12)).toBeLessThan(10);
    // with bleed 0 nothing moves: the picture stays the held key frame
    const frozen = sourceChain(t, 'ms-scroll', 'motion-smear', { ...params, bleed: 0 }, { ...project, width: 64, height: 64 });
    const z = await at(frozen.graph, frozen.node, 8);
    let errFrozen = 0;
    const r5b = r5;
    for (let y = 8; y < 56; y += 4) for (let x = 8; x < 56; x += 4) errFrozen += Math.abs(z.at(x, y)[0] - r5b.at(x, y)[0]);
    expect(errFrozen / (12 * 12)).toBeLessThan(1);
  });

  it('forward playback with the cache equals the fold from scratch, at one flow estimate per frame', async () => {
    const spy = { n: 0 };
    const params = { refresh: 6, block: 4, bleed: 1.5, resolution: 0.5 };
    const proj = { ...project, width: 64, height: 64 };
    const play = await harness([scrollingTextureSource('ms-scroll', [2, 1], spy)]);
    const a = sourceChain(play, 'ms-scroll', 'motion-smear', params, proj);
    const pass = vi.spyOn(play.gpu, 'pass');
    const lk: number[] = [];
    const srcN: number[] = [];
    const played: Uint8ClampedArray[] = [];
    for (let f = 0; f <= 9; f++) {
      pass.mockClear();
      const before = spy.n;
      played.push(await bytes(play, await play.evalGraph(a.graph, a.node, { seconds: f / 10 })));
      lk.push(pass.mock.calls.filter((c) => c[0].label === 'flow-lk').length);
      srcN.push(spy.n - before);
    }
    pass.mockRestore();
    // frames 7..9 continue the chain of key frame 6: one estimate (levels 3 x iterations 2 = 6 solver passes), the source renders once
    for (const f of [7, 8, 9]) {
      expect(lk[f], `frame ${f}`).toBe(6);
      expect(srcN[f], `frame ${f}`).toBe(1);
    }
    expect(lk[6]).toBe(0); // a key frame: no flow at all
    for (const f of [3, 8, 9]) {
      const cold = await harness([scrollingTextureSource('ms-scroll', [2, 1])]);
      const b = sourceChain(cold, 'ms-scroll', 'motion-smear', params, proj);
      const px = await bytes(cold, await cold.evalGraph(b.graph, b.node, { seconds: f / 10 }));
      expect(Buffer.from(px).equals(Buffer.from(played[f])), `frame ${f}`).toBe(true);
    }
  });

  it('a still picture comes back unchanged without pulls', async () => {
    const spy = { n: 0 };
    const t = await harness([stillSource('ms-still', spy)]);
    const { graph, node } = sourceChain(t, 'ms-still', 'motion-smear', {}, project);
    const a = await t.pixels((await t.evalGraph(graph, node, { seconds: 0.3 })) as ImageValue);
    await t.evalGraph(graph, node, { seconds: 0.7 });
    expect(a.at(16, 16)[0]).toBe(255);
    expect(spy.n).toBe(1);
  });
});
