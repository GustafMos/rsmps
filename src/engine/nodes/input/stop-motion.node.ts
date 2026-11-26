import { defineNode } from '../../define';
import { MAX_FPS, MIN_FPS, STOP_MOTION_ID, clampFps, describeShots, normalizeShots, shotAt, totalFrames, totalSeconds, type Shot } from '../../lib/stop-motion';
import type { ImageValue } from '../../types';

/**
 * Stop motion and time-lapse in one node. Wire a Webcam (or any picture) into it and press Take picture: the current input frame
 * is stored in Media as one shot (the UI does that; this node only READS params, assets and its input).
 *
 *   Shoot view  the live input with the previous shot(s) faintly over it (onion skin), so the next one can be lined up.
 *   Animation   every shot in order at "Frames per second", looping; a still lasts `hold` frames, a recorded snippet plays at its speed.
 *
 * Which one shows is the "Show" setting. "Automatic" means Shoot view while the project is paused and the animation while it plays;
 * the player tells the node it is paused by stamping the hidden `shootView` param (src/io/live-stamp.ts), so the node stays a pure
 * function of params, inputs and time. An export never stamps it, so an export is always the animation and never needs the input.
 */
export default defineNode({
  id: STOP_MOTION_ID,
  title: 'Stop Motion',
  category: 'input',
  description:
    'Make stop motion or a time-lapse: wire in a Webcam, press Take picture for each frame (or Auto shoot for a time-lapse), and the shots play back as a looping animation. Shows the previous shot faintly over the live picture so you can line up the next one..',
  keywords: ['stop motion', 'stopmotion', 'animation', 'frame by frame', 'onion skin', 'time lapse', 'timelapse', 'hyperlapse', 'interval', 'shoot', 'capture', 'photo', 'camera'],
  inputs: { image: { type: 'image', lazy: true, label: 'Picture' } },
  outputs: {
    image: { type: 'image', label: 'Image' },
    shots: { type: 'number', label: 'Shots' },
    shot: { type: 'number', label: 'Shot' },
  },
  params: {
    shots: { type: 'json', default: [], label: 'Shots', visibleIf: () => false },
    show: {
      type: 'enum',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'live', label: 'Live with onion skin' },
        { value: 'loop', label: 'The animation' },
      ],
      label: 'Show',
      hint: 'Automatic shows the live picture with the onion skin while the project is paused and the animation while it plays. Or force one of them.',
    },
    fps: { type: 'number', default: 12, min: MIN_FPS, max: MAX_FPS, step: 1, unit: 'hz', label: 'Frames per second', hint: 'How fast the animation plays. 6 to 12 looks like classic stop motion, 24 like film.' },
    onion: { type: 'bool', default: true, label: 'Onion skin', hint: 'Show the previous shot faintly over the live picture so you can line things up.' },
    onionStrength: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Onion strength', visibleIf: (p) => !!p.onion },
    onionFrames: { type: 'number', default: 1, min: 1, max: 3, step: 1, label: 'Onion shots', hint: 'How many previous shots show through (each one fainter).', visibleIf: (p) => !!p.onion },
    shotSize: {
      type: 'enum',
      default: 'full',
      options: [
        { value: 'full', label: 'Full size of the camera' },
        { value: '1080', label: '1080 on the longer side' },
        { value: '720', label: '720 on the longer side' },
      ],
      label: 'Shot size',
      group: 'Shooting',
      hint: 'How large new shots are stored. Smaller shots use much less memory and storage: good for a long time-lapse with hundreds of shots.',
    },
    interval: { type: 'number', default: 2, min: 0.2, max: 600, softMax: 60, step: 0.1, unit: 's', label: 'Auto shoot every', group: 'Shooting', hint: 'Seconds between pictures when Auto shoot is running (time-lapse, hyperlapse).' },
    stopAfter: { type: 'number', default: 0, min: 0, max: 9999, step: 1, label: 'Stop after shots', group: 'Shooting', hint: 'Auto shoot stops by itself after this many pictures. 0 = keep going until you stop it.' },
    setsLength: { type: 'bool', default: true, label: 'Set project length', hint: 'The project (playback and export) becomes exactly as long as the animation, so it loops on it. If other nodes also set the length the longest one wins.' },
    shootView: { type: 'string', default: '', label: 'Shoot view', visibleIf: () => false },
  },
  summary: (p) => `${describeShots(normalizeShots(p.shots), clampFps(p.fps))} · ${clampFps(p.fps)} fps`,
  projectLength: (p) => {
    if (!p.setsLength) return null;
    const s = totalSeconds(normalizeShots(p.shots), clampFps(p.fps));
    return s > 0 ? s : null;
  },
  async render(ctx) {
    const p = ctx.params;
    const shots = normalizeShots(p.shots);
    const fps = clampFps(p.fps);
    const gpu = ctx.gpu;
    const shoot = p.show === 'live' || (p.show === 'auto' && p.shootView === '1');

    const frameOf = async (shot: Shot, seconds: number): Promise<ImageValue> => {
      const info = ctx.host.assetInfo(shot.asset);
      if (!info) throw new Error('A shot is missing from Media. Retake it or delete it in the strip.');
      const long = Math.max(info.width, info.height);
      const maxSide = ctx.proxy < 0.999 ? Math.ceil(long * ctx.proxy) : 0;
      const frame = await ctx.host.assetFrame(shot.asset, seconds, maxSide);
      if (!frame) throw new Error(`Could not read a shot (${info.name}).`);
      return { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) };
    };

    if (shoot) {
      const live = await ctx.pull('image');
      if (live) {
        const want = p.onion ? Math.min(shots.length, Math.max(1, Math.round(p.onionFrames))) : 0;
        if (want === 0 || p.onionStrength <= 0) return { image: live, shots: shots.length, shot: shots.length };
        // nearest shot first; each earlier one is half as strong again
        const prev: ImageValue[] = [];
        for (let k = 1; k <= want; k++) {
          const s = shots[shots.length - k];
          prev.push(await frameOf(s, s.kind === 'clip' ? Math.max(0, (s.seconds ?? 0) - 1 / fps) : 0));
        }
        const tex: Record<string, ImageValue | null> = { src: live, p1: prev[0] ?? null, p2: prev[1] ?? null, p3: prev[2] ?? null };
        const image = gpu.pass({
          label: 'onion-skin',
          size: live,
          textures: tex,
          uniforms: { w1: p.onionStrength, w2: p.onionStrength * 0.5, w3: p.onionStrength * 0.25 },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = textureSampleLevel(src, smp, uv, 0.0);
  ${prev[2] ? 'c = mix(c, textureSampleLevel(p3, smp, uv, 0.0), u.w3);' : ''}
  ${prev[1] ? 'c = mix(c, textureSampleLevel(p2, smp, uv, 0.0), u.w2);' : ''}
  c = mix(c, textureSampleLevel(p1, smp, uv, 0.0), u.w1);
  return c;
}`,
        });
        return { image, shots: shots.length, shot: shots.length };
      }
    }

    if (shots.length === 0) {
      // nothing shot yet: the input passes through
      const live = shoot ? null : await ctx.pull('image');
      return { image: live, shots: 0, shot: 0 };
    }
    const at = shotAt(shots, fps, totalFrames(shots, fps) > 1 ? ctx.time.seconds : 0);
    if (!at) return { image: null, shots: shots.length, shot: 0 };
    const image = await frameOf(shots[at.index], at.local);
    return { image, shots: shots.length, shot: at.index + 1 };
  },
});
