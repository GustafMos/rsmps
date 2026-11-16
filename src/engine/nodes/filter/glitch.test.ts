import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { addNode, connect, createGraph } from '../../graph';
import { glitchAt, type GlitchTimelineParams } from '../../lib/glitch-timeline';
import { seamRatio } from '../../lib/copy-testutil';
import { harness } from '../../testing';

const stripes = (x: number, y: number): [number, number, number, number] => [(x * 5 + y) % 256, (y * 7) % 256, (x * 3) % 256, 255];
type H = Awaited<ReturnType<typeof harness>>;

/** Only one kind of error, forced on every frame with the trigger. */
const only = (kind: string, extra: Record<string, unknown> = {}) => ({
  kBlock: 0, kTear: 0, kSplit: 0, kSmear: 0, kQuant: 0, kStutter: 0, kTimeTear: 0, kBitrot: 0, kScan: 0, kFlash: 0, calm: 1, trigger: 1, intensity: 1.5, ...{ [kind]: 1 }, ...extra,
});

const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};
const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
  return n / (a.length / 4);
};

async function series(t: H, params: Record<string, unknown>, frames = 48, src = t.fromFn(64, 64, stripes), size = 64) {
  const project = { fps: 24, duration: frames / 24, loop: true, width: size, height: size };
  const out: Uint8ClampedArray[] = [];
  for (let f = 0; f < frames; f++) out.push(await t.gpu.read((await t.run('glitch', params, { image: src }, { seconds: f / 24, project })).image as never, false));
  return out;
}

/** A source that changes every frame and counts how often it is rendered. */
const counter = { renders: 0 };
const mover = defineNode({
  id: 'zz-mover',
  title: 'mover',
  category: 'input',
  description: 'test source that moves',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: {},
  render(ctx) {
    counter.renders++;
    const f = ctx.time.frame;
    return { image: ctx.gpu.pass({ size: { width: 48, height: 48, unit: 1 }, uniforms: { f }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(fract(uv.x * 3.0 + u.f * 0.07), uv.y, fract(u.f * 0.13), 1.0); }' }) };
  },
});

async function movingFrames(t: H, params: Record<string, unknown>, frames: number, only?: number[]) {
  let g = createGraph('t');
  g.project = { ...g.project, fps: 24, duration: frames / 24, loop: true, width: 48, height: 48 };
  const a = addNode(g, t.registry, 'zz-mover', { x: 0, y: 0 });
  g = a.graph;
  const b = addNode(g, t.registry, 'glitch', { x: 0, y: 0 }, params);
  g = connect(b.graph, t.registry, { node: a.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
  const out: Uint8ClampedArray[] = [];
  for (let f = 0; f < frames; f++) if (!only || only.includes(f)) out.push(await t.gpu.read((await t.evalGraph(g, b.node.id, { seconds: f / 24 })) as never, false));
  return out;
}

describe('glitch timeline', () => {
  const tp: GlitchTimelineParams = { seed: 1, rate: 4, burst: 0.65, hold: 3, calm: 0.9, intensity: 1, fps: 24, kinds: [0.9, 0.7, 0.6, 0.3, 0.35, 0.2, 0.12, 0.25, 0.3, 0.06] };

  it('is a pure function of the seed and the frame', () => {
    const a = JSON.stringify(Array.from({ length: 48 }, (_, f) => glitchAt(f, 48, tp)));
    expect(JSON.stringify(Array.from({ length: 48 }, (_, f) => glitchAt(f, 48, tp)))).toBe(a);
    expect(JSON.stringify(Array.from({ length: 48 }, (_, f) => glitchAt(f, 48, { ...tp, seed: 2 })))).not.toBe(a);
  });

  it('events are held for 1-16 frames; an event near the end continues into the first frames (the loop closes)', () => {
    let wrapped = false;
    let held = 0;
    let events = 0;
    for (let seed = 1; seed < 40; seed++) {
      const p = { ...tp, seed, calm: 1 };
      for (let f = 0; f < 96; f++) {
        const e = glitchAt(f, 96, p);
        if (!e) continue;
        if (e.age === 0) events++;
        if (e.age > 0) held++;
        expect(e.len).toBeLessThanOrEqual(16);
        if (f === 0 && e.age > 0) wrapped = true;
      }
    }
    expect(wrapped).toBe(true);
    expect(held).toBeGreaterThan(events); // events last more than one frame on average
  });

  it('rate is events per second (the mean over many seeds)', () => {
    let starts = 0;
    for (let seed = 1; seed <= 60; seed++) for (let f = 0; f < 96; f++) if (glitchAt(f, 96, { ...tp, seed, calm: 1 })?.age === 0) starts++;
    const perSecond = starts / 60 / 4; // 96 frames at 24 fps = 4 s
    expect(perSecond).toBeGreaterThan(2.4);
    expect(perSecond).toBeLessThan(5.6);
  });
});

describe('glitch', () => {
  it('is deterministic by seed, differs between seeds', async () => {
    const t = await harness();
    const a = await series(t, { seed: 5 }, 24);
    const a2 = await series(t, { seed: 5 }, 24);
    const b = await series(t, { seed: 6 }, 24);
    expect(a.every((f, i) => diff(f, a2[i]) === 0)).toBe(true);
    expect(a.some((f, i) => diff(f, b[i]) > 0)).toBe(true);
  });

  it('loops: the step across the wrap is an ordinary step', async () => {
    const t = await harness();
    const src = t.fromFn(48, 48, stripes);
    const r = await seamRatio(t, 'glitch', { rate: 6, burst: 0.3, calm: 0.9 }, { image: src }, 24);
    expect(r.motion).toBeGreaterThan(0);
    expect(r.wrap).toBeLessThanOrEqual(r.max * 1.001); // never a pop larger than the biggest ordinary jump
  });

  it('is abrupt: the frame-to-frame difference spikes instead of easing', async () => {
    const t = await harness();
    for (const seed of [1, 2, 3]) {
      const fr = await series(t, { seed }, 48);
      const d = fr.slice(1).map((f, i) => diff(fr[i], f));
      const sorted = [...d].sort((a, b) => a - b);
      const median = Math.max(sorted[Math.floor(d.length / 2)], 0.02);
      expect(sorted[sorted.length - 1] / median).toBeGreaterThan(3.5);
      expect(d.filter((x) => x < 0.5 * sorted[sorted.length - 1]).length).toBeGreaterThan(10); // many quiet-ish steps next to the bursts
    }
  });

  it('rate 0 with calm 1, intensity 0 and every amount 0 are clean pass-throughs', async () => {
    const t = await harness();
    const src = t.fromFn(48, 48, stripes);
    expect((await t.run('glitch', { rate: 0, calm: 1 }, { image: src })).image).toBe(src);
    expect((await t.run('glitch', { intensity: 0, trigger: 1 }, { image: src })).image).toBe(src);
    expect((await t.run('glitch', only('kBlock', { kBlock: 0 }), { image: src })).image).toBe(src);
  });

  it('every picture kind alone changes the picture; the trigger forces it', async () => {
    const t = await harness();
    const src = t.fromFn(96, 96, stripes);
    const ref = await t.gpu.read(src, false);
    for (const k of ['kBlock', 'kTear', 'kSplit', 'kSmear', 'kQuant', 'kBitrot', 'kScan', 'kFlash']) {
      const out = await t.gpu.read((await t.run('glitch', only(k, { block: 12, seed: 3 }), { image: src }, { seconds: 0 })).image as never, false);
      expect(diff(out, ref), k).toBeGreaterThan(0.2);
    }
    const off = await t.run('glitch', only('kBlock', { trigger: 0, rate: 0 }), { image: src });
    expect(off.image).toBe(src);
  });

  it('proxy and full size have similar coverage', async () => {
    const t = await harness();
    const f = (unit: number) => (x: number, y: number): [number, number, number, number] => stripes(Math.floor(x / unit), Math.floor(y / unit));
    const small = t.fromFn(96, 96, f(1), 1);
    const big = t.fromFn(192, 192, f(2), 2);
    let a = 0;
    let b = 0;
    for (let s = 0; s < 8; s++) {
      const p = only('kBlock', { block: 12, seed: s + 1, kTear: 1 });
      a += changed(await t.gpu.read((await t.run('glitch', p, { image: small }, { seconds: 0 })).image as never, false), await t.gpu.read(small, false));
      b += changed(await t.gpu.read((await t.run('glitch', p, { image: big }, { seconds: 0 })).image as never, false), await t.gpu.read(big, false));
    }
    expect(a).toBeGreaterThan(0.2);
    expect(b / a).toBeGreaterThan(0.6);
    expect(b / a).toBeLessThan(1.6);
  });

  it('moving sliders compiles nothing new', async () => {
    const t = await harness();
    const src = t.fromFn(48, 48, stripes);
    await t.run('glitch', {}, { image: src }, { seconds: 0.3 });
    const before = t.gpu.stats().objects.pipelinesCreated;
    for (const [k, v] of Object.entries({ rate: 9, burst: 0.1, hold: 6, calm: 0.2, reroll: 5, intensity: 1.7, kBlock: 0.2, kQuant: 1, kFlash: 1, block: 17, shift: 300, split: 33, seed: 77 })) {
      for (const s of [0, 0.4, 0.9]) await t.run('glitch', { [k]: v, trigger: 1 }, { image: src }, { seconds: s });
    }
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
  });

  it('fetches a second moment only for stutter / time tear events', async () => {
    // one frame on a fresh engine: the input is rendered once for the frame itself, plus once per pull
    const renders = async (params: Record<string, unknown>) => {
      const t = await harness([mover]);
      counter.renders = 0;
      await movingFrames(t, params, 12, [5]);
      return counter.renders;
    };
    expect(await renders(only('kBlock'))).toBe(1);
    expect(await renders(only('kSplit', { calm: 0.9, trigger: 0 }))).toBe(1);
    expect(await renders(only('kStutter'))).toBe(2);
    expect(await renders(only('kTimeTear'))).toBe(2);
    expect(await renders({ rate: 0, calm: 1 })).toBe(1);
  });

  it('stutter holds an earlier picture; time tear mixes two moments', async () => {
    const t = await harness([mover]);
    const clean = await movingFrames(t, { rate: 0, calm: 1 }, 12);
    const stut = await movingFrames(t, only('kStutter', { hold: 8 }), 12);
    let held = 0;
    for (let f = 1; f < 12; f++) if (diff(stut[f], stut[f - 1]) < 0.01) held++;
    expect(held).toBeGreaterThan(2);
    expect(diff(stut[6], clean[6])).toBeGreaterThan(1);
    const tear = await movingFrames(t, only('kTimeTear'), 12);
    // the top part (or the bottom) still shows the current frame, the other part does not
    let rowsSame = 0;
    for (let y = 0; y < 48; y++) {
      let d = 0;
      for (let x = 0; x < 48; x++) d += Math.abs(tear[6][(y * 48 + x) * 4] - clean[6][(y * 48 + x) * 4]);
      if (d === 0) rowsSame++;
    }
    expect(rowsSame).toBeGreaterThan(4);
    expect(rowsSame).toBeLessThan(46);
  });

  it('blocks honour the art grid', async () => {
    const t = await harness();
    const art = t.fromFn(96, 96, (x, y) => stripes(Math.floor(x / 4), Math.floor(y / 4)));
    const out = await t.pixels((await t.run('glitch', only('kBlock', { block: 12, seed: 2 }), { image: { ...art, cell: 4 } }, { seconds: 0 })).image as never);
    let bad = 0;
    for (let cy = 0; cy < 24; cy++) for (let cx = 0; cx < 24; cx++) {
      const c0 = out.at(cx * 4, cy * 4).join();
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (out.at(cx * 4 + x, cy * 4 + y).join() !== c0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('freeze is one fixed glitch that does not move', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, stripes);
    const r = await t.loopCheck('glitch', { freeze: true, seed: 4 }, { image: src });
    expect(r.motion).toBe(0);
    const out = await t.run('glitch', { freeze: true, seed: 4 }, { image: src });
    expect(await t.diff(out.image as never, src)).toBeGreaterThan(0.2);
  });

  it('presets differ and alpha survives', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, stripes);
    const seen = new Set<string>();
    for (const preset of ['light', 'broken', 'datamosh', 'gpu', 'signal', 'stutter']) {
      const px = await t.pixels((await t.run('glitch', { preset, freeze: true, seed: 3 }, { image: src })).image as never);
      seen.add(Array.from(px.data.slice(0, 4000)).join());
    }
    expect(seen.size).toBeGreaterThan(3);
    const clear = await t.pixels((await t.run('glitch', { trigger: 1, kSplit: 1 }, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(5, 5)[3]).toBe(0);
  });
});
