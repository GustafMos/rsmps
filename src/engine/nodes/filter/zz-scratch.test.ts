import { it } from 'vitest';
import sharp from 'sharp';
import { harness } from '../../testing';
const OUT = 'C:/Users/balin/AppData/Local/Temp/claude/cb2722232bc2d362/c8b0fc84-d7f3-4bd4-af70-54bfd4c079fc/scratchpad';
async function save(t: any, img: any, name: string) {
  const px = await t.pixels(img);
  await sharp(Buffer.from(px.data), { raw: { width: px.width, height: px.height, channels: 4 } }).resize({ width: px.width * 3, kernel: "nearest" }).png().toFile(OUT + "/" + name + '.png');
}
it('render', async () => {
  const t = await harness();
  const W = 256, H = 192;
  // night scene: dark bg, coloured lights of varying size, some foliage-ish texture, a bar of text-like stripes
  const scene = t.fromFn(W, H, (x, y) => {
    let c = [18 + (y / H) * 20, 22 + (y / H) * 20, 40 + (y / H) * 30];
    const lights: [number, number, number, number[]][] = [[50, 50, 7, [255, 230, 160]], [110, 70, 2, [255, 120, 100]], [180, 50, 9, [140, 200, 255]], [210, 110, 2, [255, 255, 255]], [80, 130, 5, [180, 255, 160]]];
    for (const [lx, ly, r, col] of lights) if (Math.hypot(x - lx, y - ly) < r) c = col;
    if (y > 150 && (x % 16) < 8) c = [200, 200, 210];
    return [c[0], c[1], c[2], 255];
  });
  await save(t, scene, 'lb_src');
  for (const [name, params] of [['circle', {}], ['hex', { shape: 'hexagon', rotation: 15, radius: 22 }], ['oct', { shape: 'octagon' }], ['big', { radius: 40 }], ['draft', { quality: 'draft' }]] as const)
    await save(t, (await t.run('lens-blur', { radius: 16, ...params }, { image: scene })).image, 'lb_' + name);
  const depth = t.fromFn(W, H, (x, y) => { const v = Math.round((y / H) * 255); return [v, v, v, 255]; });
  await save(t, (await t.run('lens-blur', { radius: 18, focus: 0.5, range: 0.1 }, { image: scene, depth })).image, 'lb_depth');
  const sprite = t.fromFn(W, H, (x, y) => (Math.hypot(x - 128, y - 96) < 50 ? [255, 160, 40, 255] : [0, 0, 0, 0]));
  const sp = await t.pixels((await t.run('lens-blur', { radius: 14 }, { image: sprite })).image as any);
  // composite over mid-grey for viewing
  const d = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { const a = sp.data[i * 4 + 3] / 255; for (let c = 0; c < 3; c++) d[i * 3 + c] = sp.data[i * 4 + c] * a + 110 * (1 - a); }
  await sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT + '/lb_sprite.png');
});
