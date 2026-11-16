import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { ballCloud, terrainCloud } from '../../lib/splat-gen';
import { parsePly, writeSplatPly } from '../../lib/splat-ply';
import { sortBackToFront } from '../../lib/splat-math';
import { resetSplatDebug, splatDebug } from '../../lib/splat-render';
import { buildNode, cam, evalPort, putCloud, splatHost } from '../../lib/splat-testutil';
import type { ImageValue } from '../../types';

/**
 * Frame cost of the splat nodes at 1920x1080 on the headless GPU (run with BENCH_SPLAT=1 to print the table; a tiny smoke version always
 * runs). Numbers are medians over several frames; "moving" re-sorts every frame, "still" reuses the cached order.
 */
const BIG = !!process.env.BENCH_SPLAT;
const files = new Map<string, ArrayBuffer>();

it('frame cost table (BENCH_SPLAT=1 for 1920x1080)', { timeout: 900_000 }, async () => {
  const t = await harness([], splatHost(files));
  const [w, h, counts, n] = BIG ? [1920, 1080, [100_000, 500_000, 1_000_000], 7] : [160, 90, [2000], 2];
  const rows: string[] = [];
  const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  const time = async (params: Record<string, unknown>, file: string, move: boolean) => {
    const times: number[] = [];
    resetSplatDebug();
    for (let i = 0; i < n + 2; i++) {
      const pos: [number, number, number] = move ? [Math.sin(i) * 3, 1.2, -Math.cos(i) * 3] : [0, 1.2, -3];
      const g = buildNode(t, 'splat-3d', { file: [file], orientation: 'asis', ...params, exposure: 0.0001 * (i + 1) }, { camera: cam({ position: pos, fov: 40 }) }, { width: w, height: h });
      const t0 = performance.now();
      await evalPort(t, g);
      await t.gpu.device.queue.onSubmittedWorkDone();
      if (i >= 2) times.push(performance.now() - t0);
    }
    return { ms: median(times), sorts: splatDebug.sorts };
  };
  for (const count of counts) {
    const cloud = count === 100_000 ? terrainCloud(count, 5) : ballCloud(count, 5);
    const t0 = performance.now();
    const bytes = writeSplatPly(cloud, '+y');
    const tWrite = performance.now() - t0;
    const t1 = performance.now();
    const parsed = parsePly(bytes);
    const tParse = performance.now() - t1;
    expect(parsed.count).toBe(count);
    files.set(`b${count}`, bytes);
    // pure sort cost (CPU)
    const sortTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s0 = performance.now();
      sortBackToFront(parsed.positions, parsed.count, { pos: [Math.sin(i) * 3, 1, -3], fwd: [0, 0, 1], persp: true, near: 0.02, key: '' });
      sortTimes.push(performance.now() - s0);
    }
    rows.push(`${`${count.toLocaleString('en-US')} splats: parse .ply (${(bytes.byteLength / 1048576).toFixed(0)} MB)`.padEnd(52)} ${tParse.toFixed(0).padStart(7)} ms   (write ${tWrite.toFixed(0)} ms)`);
    rows.push(`${`${count.toLocaleString('en-US')} splats: CPU counting sort alone`.padEnd(52)} ${median(sortTimes).toFixed(1).padStart(7)} ms`);
    const first = await time({ quality: 'sorted' }, `b${count}`, false); // includes upload on first frame only (warm-up frames are dropped)
    rows.push(`${`${count.toLocaleString('en-US')} splats: sorted, camera still (cached order)`.padEnd(52)} ${first.ms.toFixed(1).padStart(7)} ms   sorts ${first.sorts}`);
    const moving = await time({ quality: 'sorted' }, `b${count}`, true);
    rows.push(`${`${count.toLocaleString('en-US')} splats: sorted, camera moving (re-sort each frame)`.padEnd(52)} ${moving.ms.toFixed(1).padStart(7)} ms   sorts ${moving.sorts}`);
    const draft = await time({ quality: 'draft' }, `b${count}`, true);
    rows.push(`${`${count.toLocaleString('en-US')} splats: draft (no sort)`.padEnd(52)} ${draft.ms.toFixed(1).padStart(7)} ms   sorts ${draft.sorts}`);
    const dm = await time({ quality: 'draft' }, `b${count}`, true);
    void dm;
    files.delete(`b${count}`);
  }
  // picture to splats at the default density (640 across: 640 x 360 = 230,400 splats)
  const pw = BIG ? 1920 : 160;
  const ph = BIG ? 1080 : 90;
  const image = t.fromFn(pw, ph, (x, y) => [(x * 7) % 256, (y * 5) % 256, 128, 255]);
  const depth = t.fromFn(pw, ph, (x, y) => { const g = Math.round(128 + 100 * Math.sin(x / 90) * Math.cos(y / 70)); return [g, g, g, 255]; });
  for (const density of BIG ? [640, 1280] : [64]) {
    const times: number[] = [];
    for (let i = 0; i < n + 2; i++) {
      const g = buildNode(t, 'image-to-splats', { density }, { image, depth, camera: cam({ position: [Math.sin(i) * 0.8, 0.2, -4.5], target: [0, 0, 0] }) }, { width: pw, height: ph });
      const t0 = performance.now();
      await evalPort(t, g);
      await t.gpu.device.queue.onSubmittedWorkDone();
      if (i >= 2) times.push(performance.now() - t0);
    }
    const gw = Math.round(density), gh = Math.round(density * (ph / pw));
    rows.push(`${`image-to-splats ${density} across (${(gw * gh).toLocaleString('en-US')} splats), moving camera`.padEnd(52)} ${median(times).toFixed(1).padStart(7)} ms`);
  }
  const depthTimes: number[] = [];
  for (let i = 0; i < n + 2; i++) {
    const g = buildNode(t, 'image-to-splats', { density: 640 }, { image, depth, camera: cam({ position: [Math.sin(i) * 0.8, 0.2, -4.5], target: [0, 0, 0] }) }, { width: pw, height: ph });
    const t0 = performance.now();
    await evalPort(t, g, 'depth');
    await t.gpu.device.queue.onSubmittedWorkDone();
    if (i >= 2) depthTimes.push(performance.now() - t0);
  }
  rows.push(`${'image-to-splats 640 across, depth output'.padEnd(52)} ${median(depthTimes).toFixed(1).padStart(7)} ms`);
  void (putCloud as unknown);
  const out = (await evalPort(t, buildNode(t, 'image-to-splats', { density: 64 }, { image, depth }, { width: pw, height: ph }))) as ImageValue;
  expect(out.width).toBe(pw);
  console.log(`\nSplat frame cost, ${w}x${h}, headless GPU\n${rows.join('\n')}\n`);
});
