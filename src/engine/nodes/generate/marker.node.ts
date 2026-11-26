import { defineNode } from '../../define';
import { MARKER_CODES, MARKER_COUNT } from '../../lib/marker-code';

const ID_OPTIONS = Array.from({ length: MARKER_COUNT }, (_, i) => ({ value: String(i + 1), label: `Marker ${i + 1}` }));

/**
 * The square marker that Marker Camera looks for, as a picture: black on white with a white margin. Shown full screen on a second
 * device (a tablet or phone lying on the table) it does the job of a printed marker. The same cells as the printable sheet
 * (lib/marker-code.ts).
 */
export default defineNode({
  id: 'marker',
  title: 'AR Marker',
  category: 'generate',
  description:
    'The black and white square that Marker Camera looks for. Show it full screen on a tablet or a second phone lying flat and it works like a printed marker (turn the screen brightness down a little if the camera sees it blown out). To print one on paper, use the Print button of Marker Camera.',
  keywords: ['marker', 'ar', 'fiducial', 'aruco', 'tag', 'target', 'anchor', 'augmented reality', 'screen', 'qr'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    marker: { type: 'enum', default: '1', label: 'Marker', options: ID_OPTIONS, hint: 'Six different markers exist. Marker Camera can follow any, or one by number.' },
    fill: { type: 'number', default: 0.7, min: 0.1, max: 0.85, step: 0.01, unit: 'norm', label: 'Size', hint: 'Width of the black square as a fraction of the picture\'s shorter side. The rest stays white: the marker needs that white margin to be found.' },
    turn: {
      type: 'enum',
      default: '0',
      label: 'Top edge',
      options: [
        { value: '0', label: 'Up' },
        { value: '1', label: 'Right' },
        { value: '2', label: 'Down' },
        { value: '3', label: 'Left' },
      ],
      hint: 'Which way the marker\'s top edge points on the screen. The scene\'s "away" direction follows the top edge.',
    },
  },
  summary: (p) => `marker ${p.marker}`,
  render(ctx) {
    const p = ctx.params;
    const code = MARKER_CODES[(Number(p.marker) - 1 + MARKER_COUNT) % MARKER_COUNT];
    const image = ctx.gpu.pass({
      label: 'marker',
      size: ctx.in.size ?? ctx.canvas,
      // the 16 cells as two bytes: a float carries 8 bits exactly on every GPU
      uniforms: { hi: code >> 8, lo: code & 255, fill: p.fill, turn: Number(p.turn) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let short = min(u.size.x, u.size.y);
  // position inside the black square, 0..1 with (0, 0) at its top-left on screen
  var m = (px - u.size * 0.5) / (short * u.fill) + 0.5;
  // undo the turn: find where this point is on the upright marker
  let t = i32(u.turn);
  if (t == 1) { m = vec2f(m.y, 1.0 - m.x); }
  if (t == 2) { m = vec2f(1.0 - m.x, 1.0 - m.y); }
  if (t == 3) { m = vec2f(1.0 - m.y, m.x); }
  if (m.x < 0.0 || m.y < 0.0 || m.x >= 1.0 || m.y >= 1.0) { return vec4f(1.0); }
  let c = vec2i(floor(m * 6.0));
  var white = false;
  if (c.x >= 1 && c.x <= 4 && c.y >= 1 && c.y <= 4) {
    let bit = 15 - ((c.y - 1) * 4 + (c.x - 1));
    let word = select(u32(u.lo), u32(u.hi), bit >= 8);
    white = ((word >> u32(bit % 8)) & 1u) == 1u;
  }
  let v = select(0.0, 1.0, white);
  return vec4f(v, v, v, 1.0);
}`,
    });
    return { image };
  },
});
