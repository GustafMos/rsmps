import { defineNode } from '../../define';
import { mod } from '../../lib/util-time';

export default defineNode({
  id: 'retime',
  title: 'Retime',
  category: 'time',
  description: 'Change how footage plays: faster, slower, backwards, back-and-forth, or held to a lower frame rate for a stop-motion look.',
  keywords: ['speed', 'slow motion', 'fast', 'reverse', 'ping pong', 'boomerang', 'stop motion', 'fps', 'hold'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    speed: { type: 'number', default: 1, min: -16, max: 16, step: 0.05, label: 'Speed', hint: '1 = normal, 2 = twice as fast, 0.5 = half speed, negative plays backwards.' },
    reverse: { type: 'bool', default: false, label: 'Play backwards' },
    pingPong: { type: 'bool', default: false, label: 'Ping-pong', hint: 'Plays forward, then backward, then forward again. Use speed 2 to fit one there-and-back into the loop.' },
    repeat: { type: 'bool', default: true, label: 'Repeat', hint: 'Off holds the last frame instead of starting over.' },
    holdFps: { type: 'number', default: 0, min: 0, max: 120, step: 1, unit: 'hz', label: 'Stop-motion fps', hint: 'Show a new frame only this many times per second. 0 = off.' },
  },
  summary: (p) => {
    const bits = [`${p.speed}×`];
    if (p.reverse) bits.push('reverse');
    if (p.pingPong) bits.push('ping-pong');
    if (p.holdFps > 0) bits.push(`${p.holdFps} fps`);
    return bits.join(' · ');
  },
  async render(ctx) {
    const p = ctx.params;
    if (p.speed === 1 && !p.reverse && !p.pingPong && p.holdFps <= 0 && p.repeat) return { image: ctx.in.image };
    const { duration, fps } = ctx.time;
    let t = ctx.time.seconds;
    if (p.holdFps > 0) t = Math.floor(t * p.holdFps + 1e-6) / p.holdFps;
    const x = t * p.speed;
    let s: number;
    if (p.pingPong) {
      const m = mod(x, duration * 2);
      s = m < duration ? m : duration * 2 - m;
    } else if (p.repeat) s = mod(x, duration);
    else s = Math.min(duration, Math.max(0, x));
    if (p.reverse) s = Math.max(0, duration - 1 / fps - s);
    return { image: await ctx.pull('image', { seconds: s }) };
  },
});
