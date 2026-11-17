import { defineNode } from '../../define';
import { cyclesPerLoop, snapNote, wholeCycles } from '../../lib/loop-snap';
import { mod } from '../../lib/util-time';

/**
 * Loop snapping (Loop on): the footage must come back to its start exactly when the project does, so the speed is a whole number (an even
 * one for ping-pong: there and back) and the stop-motion rate is a whole number of held frames per loop. Never 0 unless typed as 0.
 * Repeat off (hold the last frame) and Loop off are left alone. Pure: the node, its summary and the tests share it.
 */
export function retimeLoop(
  p: { speed: number; pingPong: boolean; repeat: boolean; holdFps: number },
  clock?: { loop: boolean; frames: number; fps: number },
): { speed: number; holdFps: number; notes: string[] } {
  if (!clock?.loop) return { speed: p.speed, holdFps: p.holdFps, notes: [] };
  let speed = p.speed;
  if (p.pingPong) speed = 2 * wholeCycles(p.speed / 2);
  else if (p.repeat) speed = wholeCycles(p.speed);
  let holdFps = p.holdFps;
  if (holdFps > 0) holdFps = cyclesPerLoop(holdFps, clock.frames / clock.fps) / (clock.frames / clock.fps);
  const notes = [snapNote('speed', p.speed, speed), snapNote('hold fps', p.holdFps, holdFps)].filter(Boolean);
  return { speed, holdFps, notes };
}

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
  summary: (p, _wired, clock) => {
    const r = retimeLoop(p, clock);
    const bits = [`${r.speed}×`];
    if (p.reverse) bits.push('reverse');
    if (p.pingPong) bits.push('ping-pong');
    if (r.holdFps > 0) bits.push(`${Math.round(r.holdFps * 100) / 100} fps`);
    return [...bits, ...r.notes].join(' · ');
  },
  async render(ctx) {
    const p = ctx.params;
    if (p.speed === 1 && !p.reverse && !p.pingPong && p.holdFps <= 0 && p.repeat) return { image: ctx.in.image };
    const { duration, fps } = ctx.time;
    const r = retimeLoop(p, { loop: ctx.time.loop, frames: Math.max(1, Math.round(duration * fps)), fps });
    let t = ctx.time.seconds;
    if (r.holdFps > 0) t = Math.floor(t * r.holdFps + 1e-6) / r.holdFps;
    const x = t * r.speed;
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
