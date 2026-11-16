import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderGraph, makeGraph, pitchHz, SR } from '../../audio/testing';
import { defineNode } from '../../define';
import { addNode, connect, createGraph, effectiveDuration, moveWire, withEffectiveDuration } from '../../graph';
import {
  activeAt,
  appendSource,
  editEnd,
  moveClip,
  normalizeEdit,
  remapSources,
  removeClip,
  resolveFades,
  snapTime,
  splitAt,
  trimEnd,
  trimStart,
  weightAt,
  type EditClip,
  type MediaEdit,
} from '../../lib/media-edit';
import { reconcileMediaEdits } from '../../lib/media-edit-graph';
import { harness } from '../../testing';
import type { AnyNodeDef, GraphDoc, ImageValue } from '../../types';
import def from './media-timeline.node';

const clip = (o: Partial<EditClip> & { id: string }): EditClip => ({ kind: 'video', source: 0, track: 0, start: 0, in: 0, duration: 2, fadeIn: 0, fadeOut: 0, level: 1, ...o });
const edit = (...clips: EditClip[]): MediaEdit => ({ clips });

/* ------------------------------------------------------------------ pure edit math */

describe('edit math', () => {
  it('finds the active clips and their local time', () => {
    const e = edit(clip({ id: 'a', start: 0, duration: 2 }), clip({ id: 'b', source: 1, start: 2, duration: 3, in: 10 }));
    expect(activeAt(e, 'video', 1).map((a) => a.clip.id)).toEqual(['a']);
    expect(activeAt(e, 'video', 2).map((a) => a.clip.id)).toEqual(['b']); // half open: a ends exactly where b starts
    const b = activeAt(e, 'video', 3.5)[0];
    expect(b.local).toBeCloseTo(11.5, 9);
    expect(activeAt(e, 'video', 5)).toEqual([]);
    expect(activeAt(e, 'video', -1)).toEqual([]);
    expect(editEnd(e)).toBe(5);
  });

  it('stacks tracks bottom to top and later clips over earlier ones', () => {
    const e = edit(clip({ id: 'top', track: 1, source: 2 }), clip({ id: 'bottom', track: 0 }), clip({ id: 'later', track: 0, start: 1, source: 1 }));
    expect(activeAt(e, 'video', 1.5).map((a) => a.clip.id)).toEqual(['bottom', 'later', 'top']);
  });

  it('applies fades as linear opacity ramps and level as a multiplier', () => {
    const c = clip({ id: 'a', start: 1, duration: 4, fadeIn: 1, fadeOut: 2, level: 0.5 });
    expect(weightAt(c, 1)).toBeCloseTo(0, 9);
    expect(weightAt(c, 1.5)).toBeCloseTo(0.25, 9);
    expect(weightAt(c, 3)).toBeCloseTo(0.5, 9);
    expect(weightAt(c, 4)).toBeCloseTo(0.25, 9); // halfway down the 2 s fade out
    expect(weightAt(c, 5)).toBe(0);
    // a clip that is fully faded out is not "active" (it would only cost an evaluation)
    expect(activeAt(edit(c), 'video', 1)).toEqual([]);
  });

  it('cross-dissolves clips that overlap on the same track (only the later one fades in)', () => {
    const e = edit(clip({ id: 'a', start: 0, duration: 3 }), clip({ id: 'b', source: 1, start: 2, duration: 3 }));
    const f = resolveFades(e);
    expect(f.get('b')).toEqual({ fadeIn: 1, fadeOut: 0 });
    expect(f.get('a')).toEqual({ fadeIn: 0, fadeOut: 0 });
    const mid = activeAt(e, 'video', 2.5);
    expect(mid.map((a) => [a.clip.id, Number(a.weight.toFixed(3))])).toEqual([['a', 1], ['b', 0.5]]);
    // different tracks: no automatic dissolve, the upper clip is simply on top
    const stacked = edit(clip({ id: 'a', duration: 3 }), clip({ id: 'b', source: 1, track: 1, start: 2, duration: 3 }));
    expect(resolveFades(stacked).get('b')).toEqual({ fadeIn: 0, fadeOut: 0 });
    // sound dissolves both ways so the level stays even
    const s = edit(clip({ id: 'a', kind: 'audio', duration: 3 }), clip({ id: 'b', kind: 'audio', start: 2, duration: 3 }));
    expect(resolveFades(s).get('a')).toEqual({ fadeIn: 0, fadeOut: 1 });
  });

  it('moves, trims, splits and deletes linked clips together', () => {
    const e = edit(clip({ id: 'v', link: 'l', start: 1, in: 0, duration: 4 }), clip({ id: 'a', kind: 'audio', source: -1, asset: 'x', link: 'l', start: 1, in: 2, duration: 4 }));
    const m = moveClip(e, 'v', 3, 1);
    expect(m.clips.map((c) => [c.id, c.start, c.track])).toEqual([['v', 3, 1], ['a', 3, 0]]);
    expect(moveClip(e, 'v', -5).clips.map((c) => c.start)).toEqual([0, 0]); // never before zero
    const ts = trimStart(e, 'v', 2);
    expect(ts.clips.map((c) => [c.start, c.in, c.duration])).toEqual([[2, 1, 3], [2, 3, 3]]);
    expect(trimStart(e, 'v', -9).clips[0].in).toBe(0); // cannot reveal footage before the source starts
    const te = trimEnd(e, 'a', 3);
    expect(te.clips.map((c) => c.duration)).toEqual([2, 2]);
    expect(trimEnd(e, 'a', 1).clips[0].duration).toBeGreaterThan(0);
    const s = splitAt(e, 'v', 2.5);
    expect(s.edit.clips).toHaveLength(4);
    const right = s.edit.clips.filter((c) => s.right.includes(c.id));
    expect(right.map((c) => [c.start, c.in, c.duration])).toEqual([[2.5, 1.5, 2.5], [2.5, 3.5, 2.5]]);
    expect(right[0].link).toBe(right[1].link);
    expect(right[0].link).not.toBe('l');
    expect(splitAt(e, 'v', 9).right).toEqual([]);
    expect(removeClip(e, 'a').clips).toEqual([]);
  });

  it('snaps to the nearest target within the threshold only', () => {
    expect(snapTime(2.04, [0, 2, 5], 0.1)).toBe(2);
    expect(snapTime(3, [0, 2, 5], 0.1)).toBe(3);
  });

  it('normalizeEdit repairs rubbish', () => {
    expect(normalizeEdit(null).clips).toEqual([]);
    const n = normalizeEdit({ clips: [{ id: 'a', duration: 2, start: -4, fadeIn: 9, level: -1 }, { id: 'a', duration: 1 }, { duration: 0 }, 7] });
    expect(n.clips).toHaveLength(2);
    expect(n.clips[0]).toMatchObject({ start: 0, fadeIn: 2, level: 0, kind: 'video', source: 0 });
    expect(new Set(n.clips.map((c) => c.id)).size).toBe(2);
  });
});

/* ------------------------------------------------------------------ project length */

describe('project length', () => {
  const build = async (params: Record<string, unknown>, project: Partial<GraphDoc['project']> = {}) => {
    const t = await harness();
    const a = addNode(createGraph(), t.registry, 'media-timeline', { x: 0, y: 0 }, params);
    return { t, graph: { ...a.graph, project: { ...a.graph.project, fps: 24, duration: 4, ...project } }, id: a.node.id };
  };
  const e = { clips: [clip({ id: 'a', start: 0, duration: 5 }), clip({ id: 'b', start: 5, duration: 7.5 })] };

  it('follows the end of the last clip only when ticked', async () => {
    const off = await build({ edit: e });
    expect(effectiveDuration(off.graph, off.t.registry)).toBeNull();
    expect(withEffectiveDuration(off.graph, off.t.registry)).toBe(off.graph);
    const on = await build({ edit: e, setsLength: true });
    expect(effectiveDuration(on.graph, on.t.registry)).toBe(12.5);
    expect(withEffectiveDuration(on.graph, on.t.registry).project.duration).toBe(12.5);
  });

  it('is a whole number of frames, at least one, and idempotent', async () => {
    const odd = await build({ edit: { clips: [clip({ id: 'a', duration: 1.01 })] }, setsLength: true }, { fps: 10 });
    expect(effectiveDuration(odd.graph, odd.t.registry)).toBe(1);
    const once = withEffectiveDuration(odd.graph, odd.t.registry);
    expect(withEffectiveDuration(once, odd.t.registry)).toBe(once);
    const empty = await build({ setsLength: true });
    expect(effectiveDuration(empty.graph, empty.t.registry)).toBeNull(); // no clips: the project keeps its length
  });

  it('ignores bypassed nodes and takes the longest of several', async () => {
    const x = await build({ edit: e, setsLength: true });
    const second = addNode(x.graph, x.t.registry, 'media-timeline', { x: 0, y: 0 }, { edit: { clips: [clip({ id: 'z', duration: 20 })] }, setsLength: true });
    expect(effectiveDuration(second.graph, x.t.registry)).toBe(20);
    const bypassed = { ...second.graph, nodes: second.graph.nodes.map((n) => (n.id === second.node.id ? { ...n, bypass: true } : n)) };
    expect(effectiveDuration(bypassed, x.t.registry)).toBe(12.5);
  });

  it('summary reads "3 clips · 00:12.5"', () => {
    const three = { clips: [clip({ id: 'a', duration: 4 }), clip({ id: 'b', start: 4, duration: 4 }), clip({ id: 'c', start: 8, duration: 4.5 })] };
    expect(def.summary!({ edit: three, setsLength: false, fit: 'contain', background: [0, 0, 0, 0] } as never)).toBe('3 clips · 00:12.5');
  });
});

/* ------------------------------------------------------------------ wiring */

describe('wiring a source appends a clip', () => {
  const describeSource = (info: Record<string, { name: string; duration: number; asset?: string; hasAudio?: boolean; assetIn?: number }>) => (from: { node: { id: string } }) => info[from.node.id] ?? { name: 'Source', duration: 0 };

  it('first wires become a sequence without opening any editor', async () => {
    const t = await harness();
    let g = createGraph('wire');
    const tl = addNode(g, t.registry, 'media-timeline');
    g = tl.graph;
    const srcs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = addNode(g, t.registry, 'noise');
      g = s.graph;
      srcs.push(s.node.id);
    }
    const info: Record<string, { name: string; duration: number; asset?: string; hasAudio?: boolean }> = {
      [srcs[0]]: { name: 'Clip A', duration: 3 },
      [srcs[1]]: { name: 'Clip B', duration: 0 }, // unknown length: 5 s
      [srcs[2]]: { name: 'Clip C', duration: 2, asset: 'file', hasAudio: true },
    };
    let prev = g;
    for (const s of srcs) {
      const next = connect(prev, t.registry, { node: s, port: 'image' }, { node: tl.node.id, port: 'clips' });
      g = reconcileMediaEdits(prev, next, describeSource(info));
      prev = g;
    }
    const e = normalizeEdit(g.nodes.find((n) => n.id === tl.node.id)!.params.edit);
    const video = e.clips.filter((c) => c.kind === 'video');
    expect(video.map((c) => [c.source, c.start, c.duration, c.name])).toEqual([[0, 0, 3, 'Clip A'], [1, 3, 5, 'Clip B'], [2, 8, 2, 'Clip C']]);
    const sound = e.clips.filter((c) => c.kind === 'audio');
    expect(sound).toHaveLength(1);
    expect(sound[0]).toMatchObject({ asset: 'file', start: 8, source: -1 });
    expect(sound[0].link).toBe(video[2].link);
    expect(editEnd(e)).toBe(10);
  });

  it('removing or reordering a wire keeps every clip on its own source', async () => {
    const t = await harness();
    let g = createGraph('wire');
    const tl = addNode(g, t.registry, 'media-timeline');
    g = tl.graph;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = addNode(g, t.registry, 'noise');
      g = connect(s.graph, t.registry, { node: s.node.id, port: 'image' }, { node: tl.node.id, port: 'clips' });
      ids.push(s.node.id);
    }
    const base = { clips: ids.map((_, i) => clip({ id: `c${i + 1}`, source: i, start: i * 2 })) };
    g = { ...g, nodes: g.nodes.map((n) => (n.id === tl.node.id ? { ...n, params: { ...n.params, edit: base } } : n)) };
    const edges = g.edges.filter((e) => e.to.node === tl.node.id);
    const moved = moveWire(g, edges[0].id, 1); // first wire now second
    const re = reconcileMediaEdits(g, moved, describeSource({}));
    const sources = normalizeEdit(re.nodes.find((n) => n.id === tl.node.id)!.params.edit).clips.map((c) => [c.id, c.source]);
    expect(sources).toEqual([['c1', 1], ['c2', 0], ['c3', 2]]);
    const removed = { ...g, edges: g.edges.filter((e) => e.id !== edges[1].id) };
    const after = normalizeEdit(reconcileMediaEdits(g, removed, describeSource({})).nodes.find((n) => n.id === tl.node.id)!.params.edit).clips.map((c) => [c.id, c.source]);
    expect(after).toEqual([['c1', 0], ['c3', 1]]);
  });

  it('pure helpers: appendSource for sounds, remapSources', () => {
    const e = appendSource({ clips: [] }, 'sounds', 0, { name: 'Tone', duration: 4 });
    expect(e.clips[0]).toMatchObject({ kind: 'audio', source: 0, start: 0, duration: 4 });
    const again = appendSource(appendSource({ clips: [] }, 'clips', 0, { name: 'V', duration: 2, asset: 'f', hasAudio: true }), 'sounds', 0, { name: 'V', duration: 2, asset: 'f' });
    expect(again.clips.filter((c) => c.kind === 'audio')).toHaveLength(1); // its sound already plays with the picture
    expect(remapSources(e, 'sounds', ['x'], []).clips).toEqual([]);
  });
});

/* ------------------------------------------------------------------ GPU: compositing and laziness */

/** A solid-colour source that counts how often it really renders and reads the clock (so it re-renders per frame). */
const solidSource = (id: string, rgb: [number, number, number], spy: { n: number }, size = 8): AnyNodeDef =>
  defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test source',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      spy.n++;
      void ctx.time.seconds;
      return { image: ctx.gpu.pass({ size: { width: size, height: size }, uniforms: { c: rgb }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.c, 1.0); }' }) };
    },
  });

async function twoSourceGraph(edit: MediaEdit, params: Record<string, unknown> = {}) {
  const a = { n: 0 };
  const b = { n: 0 };
  const t = await harness([solidSource('src-red', [1, 0, 0], a), solidSource('src-blue', [0, 0, 1], b)]);
  let g = createGraph('mt');
  g.project = { ...g.project, width: 8, height: 8, fps: 10, duration: 6, loop: false };
  const tl = addNode(g, t.registry, 'media-timeline', { x: 0, y: 0 }, { edit, ...params });
  g = tl.graph;
  for (const type of ['src-red', 'src-blue']) {
    const s = addNode(g, t.registry, type);
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'image' }, { node: tl.node.id, port: 'clips' });
  }
  return { t, g, node: tl.node.id, a, b };
}
const px = async (t: Awaited<ReturnType<typeof harness>>, g: GraphDoc, node: string, seconds: number) => {
  const img = (await t.evalGraph(g, node, { seconds })) as ImageValue;
  return { img, p: await t.pixels(img) };
};

describe('media-timeline picture', () => {
  it('shows the clip that is active, with gaps transparent', async () => {
    const { t, g, node } = await twoSourceGraph(edit(clip({ id: 'r', source: 0, start: 0, duration: 2 }), clip({ id: 'b', source: 1, start: 3, duration: 2 })));
    expect((await px(t, g, node, 1)).p.at(4, 4)).toEqual([255, 0, 0, 255]);
    expect((await px(t, g, node, 2.5)).p.at(4, 4)[3]).toBe(0); // the gap
    expect((await px(t, g, node, 4)).p.at(4, 4)).toEqual([0, 0, 255, 255]);
    expect((await px(t, g, node, 5.5)).p.at(4, 4)[3]).toBe(0); // after the last clip
  });

  it('background colour fills the gaps', async () => {
    const { t, g, node } = await twoSourceGraph(edit(clip({ id: 'r', source: 0, start: 0, duration: 1 })), { background: [0, 1, 0, 1] });
    expect((await px(t, g, node, 3)).p.at(4, 4)).toEqual([0, 255, 0, 255]);
  });

  it('never evaluates a source that is not on screen', async () => {
    const { t, g, node, a, b } = await twoSourceGraph(edit(clip({ id: 'r', source: 0, start: 0, duration: 2 }), clip({ id: 'b', source: 1, start: 3, duration: 2 })));
    for (const s of [0, 0.5, 1, 1.5, 2.5]) await px(t, g, node, s);
    expect(a.n).toBeGreaterThan(0);
    expect(b.n).toBe(0);
    await px(t, g, node, 4);
    expect(b.n).toBeGreaterThan(0);
  });

  it('pulls the source at the clip-local time, not the project time', async () => {
    const seen: number[] = [];
    const probe = defineNode({
      id: 'src-probe',
      title: 'p',
      category: 'input',
      description: 'records the time it is asked for',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render(ctx) {
        seen.push(Math.round(ctx.time.seconds * 100) / 100);
        return { image: ctx.gpu.pass({ size: { width: 8, height: 8 }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(1.0); }' }) };
      },
    });
    const t = await harness([probe]);
    let g = createGraph('probe');
    g.project = { ...g.project, width: 8, height: 8, fps: 10, duration: 10, loop: false };
    const tl = addNode(g, t.registry, 'media-timeline', { x: 0, y: 0 }, { edit: edit(clip({ id: 'a', start: 4, in: 1.5, duration: 3 })) });
    const s = addNode(tl.graph, t.registry, 'src-probe');
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'image' }, { node: tl.node.id, port: 'clips' });
    await t.evalGraph(g, tl.node.id, { seconds: 5 });
    expect(seen).toContain(2.5); // 1.5 + (5 - 4)
  });

  it('cross-dissolves overlapping clips and fades opacity over a lower track', async () => {
    // same track, 1 s overlap: halfway the colour is the mean of both
    const dis = await twoSourceGraph(edit(clip({ id: 'r', source: 0, start: 0, duration: 3 }), clip({ id: 'b', source: 1, start: 2, duration: 3 })));
    const mid = (await px(dis.t, dis.g, dis.node, 2.5)).p.at(4, 4);
    expect(mid[0]).toBeGreaterThan(110);
    expect(mid[0]).toBeLessThan(145);
    expect(mid[2]).toBeGreaterThan(110);
    expect(mid[2]).toBeLessThan(145);
    expect(mid[3]).toBe(255);
    // different tracks, top clip fading in: half opacity over the bottom clip
    const fade = await twoSourceGraph(edit(clip({ id: 'r', source: 0, duration: 4 }), clip({ id: 'b', source: 1, track: 1, duration: 4, fadeIn: 2 })));
    const half = (await px(fade.t, fade.g, fade.node, 1)).p.at(4, 4);
    expect(half[0]).toBeGreaterThan(110);
    expect(half[0]).toBeLessThan(145);
    expect(half[2]).toBeGreaterThan(110);
    expect(half[2]).toBeLessThan(145);
  });

  it('fits sources of another shape inside the frame (contain) or over it (cover)', async () => {
    const t = await harness();
    const wide = t.solid(16, 4, [255, 255, 0, 255]);
    const id = t.source(wide);
    let g = createGraph('fit');
    g.project = { ...g.project, width: 8, height: 8, fps: 10, duration: 3, loop: false };
    const tl = addNode(g, t.registry, 'media-timeline', { x: 0, y: 0 }, { edit: edit(clip({ id: 'a', duration: 2 })) });
    const s = addNode(tl.graph, t.registry, id);
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'out' }, { node: tl.node.id, port: 'clips' });
    const contain = (await px(t, g, tl.node.id, 0.5)).p;
    expect(contain.at(4, 4)).toEqual([255, 255, 0, 255]);
    expect(contain.at(4, 0)[3]).toBe(0); // letterbox
    const cover = { ...g, nodes: g.nodes.map((n) => (n.id === tl.node.id ? { ...n, params: { ...n.params, fit: 'cover' } } : n)) };
    expect((await px(t, cover, tl.node.id, 0.5)).p.at(4, 0)).toEqual([255, 255, 0, 255]);
  });

  it('two frames of a small edit look right (PNG written when MT_PNG_DIR is set)', async () => {
    const t = await harness();
    const scene = t.scene(64, 36);
    const tall = t.fromFn(24, 48, (x, y) => [Math.round((y / 47) * 255), 60, Math.round((x / 23) * 255), 255]);
    const s1 = t.source(scene);
    const s2 = t.source(tall);
    let g = createGraph('png');
    g.project = { ...g.project, width: 96, height: 54, fps: 10, duration: 6, loop: false };
    const e = edit(
      clip({ id: 'a', source: 0, start: 0, duration: 4, fadeOut: 0 }),
      clip({ id: 'b', source: 1, track: 1, start: 1, duration: 3, fadeIn: 1, fadeOut: 1 }),
    );
    const tl = addNode(g, t.registry, 'media-timeline', { x: 0, y: 0 }, { edit: e, background: [0.1, 0.1, 0.12, 1] });
    g = tl.graph;
    for (const [i, s] of [s1, s2].entries()) {
      const n = addNode(g, t.registry, s);
      g = connect(n.graph, t.registry, { node: n.node.id, port: 'out' }, { node: tl.node.id, port: 'clips' });
      void i;
    }
    const f1 = await px(t, g, tl.node.id, 0.5); // only the scene
    const f2 = await px(t, g, tl.node.id, 2.5); // scene with the tall clip fully on top
    expect(f1.p.at(48, 27)).not.toEqual(f2.p.at(48, 27));
    expect(f2.p.at(48, 27)[2]).toBeGreaterThan(100); // tall clip's blue gradient is in the centre
    const dir = process.env.MT_PNG_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'frame-0.5s.png'), png(f1.p.data, f1.p.width, f1.p.height));
      writeFileSync(join(dir, 'frame-2.5s.png'), png(f2.p.data, f2.p.width, f2.p.height));
    }
  });
});

/** Minimal RGBA PNG encoder for looking at test output. */
function png(data: Uint8ClampedArray, w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ sound */

describe('media-timeline sound', () => {
  const FR = 4 * SR;
  // Sample value = seconds into the file / 10, so the value tells which part of the file is heard.
  const ramp = new Float32Array(FR).map((_, i) => i / SR / 10);
  const doc = (e: MediaEdit) => makeGraph({ nodes: [{ id: 'tl', type: 'media-timeline', params: { edit: e } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['tl.audio -> out.audio'] }, { duration: 4 });
  const at = (x: Float32Array, s: number) => x[Math.round(s * SR)];

  it('plays a file at the clip offset, only while the clip is on, with fades', () => {
    const e = edit(clip({ id: 'a', kind: 'audio', source: -1, asset: 'f', start: 1, in: 0.5, duration: 1.5, fadeIn: 0.5 }));
    const r = renderGraph(doc(e), 3, { assets: { f: { sampleRate: SR, channels: [ramp, ramp] } } });
    expect(Math.abs(at(r.left, 0.5))).toBe(0); // before the clip
    expect(at(r.left, 1.5)).toBeCloseTo(((0.5 + 0.5) / 10) * 1, 3); // fade in finished: 1.0 s into the file
    expect(at(r.left, 1.25)).toBeCloseTo(((0.5 + 0.25) / 10) * 0.5, 3); // halfway up the fade
    expect(Math.abs(at(r.left, 2.6))).toBe(0); // after the clip
  });

  it('the file starts exactly where the clip starts (sample accurate)', () => {
    const e = edit(clip({ id: 'a', kind: 'audio', source: -1, asset: 'f', start: 1, in: 0, duration: 1 }));
    const r = renderGraph(doc(e), 3, { assets: { f: { sampleRate: SR, channels: [ramp, ramp] } } });
    expect(r.left[SR - 1]).toBe(0);
    expect(r.left[SR + 480]).toBeCloseTo(0.001, 4);
  });

  it('gates and fades a wired live sound per wire', () => {
    const e = edit(clip({ id: 'a', kind: 'audio', source: 1, start: 1, duration: 1 }));
    const tone = (v: number) => ({ id: `t${v}`, type: 'test-dc', params: {} }) as never;
    void tone;
    // Two constant sources are not available as audio nodes; drive the kernel with two wires directly.
    const st = def.audio!.create({ sampleRate: SR, blockSize: 128, nodeId: 'x' });
    const w0: [Float32Array, Float32Array] = [new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)];
    const w1: [Float32Array, Float32Array] = [new Float32Array(128).fill(0.3), new Float32Array(128).fill(0.3)];
    const run = (seconds: number) => {
      const out: [Float32Array, Float32Array] = [new Float32Array(128), new Float32Array(128)];
      def.audio!.process(st, { frames: 128, sampleRate: SR, in: {}, inWires: { sounds: [w0, w1] }, midiIn: {}, out: { audio: out }, midiOut: {}, params: { edit: e }, signal: () => {}, time: { seconds, sample: seconds * SR, bpm: 120, playing: true, loop: false, duration: 0, item: 0 }, assets: { get: () => undefined }, live: { mic: null, deviceMidi: [], uiMidi: [] } } as never);
      return out[0];
    };
    expect(run(0.5)[0]).toBe(0); // before the clip
    expect(run(1.5)[0]).toBeCloseTo(0.3, 6); // wire 1 only, wire 0 is not selected
    expect(run(2.5)[0]).toBe(0);
  });

  it('through the runner: only the wire the clip points at is heard, and only during the clip', () => {
    const e = edit(clip({ id: 'a', kind: 'audio', source: 1, start: 1, duration: 1 }));
    const d = makeGraph({
      nodes: [
        { id: 'o1', type: 'oscillator', params: { frequency: 440 } },
        { id: 'o2', type: 'oscillator', params: { frequency: 1000 } },
        { id: 'tl', type: 'media-timeline', params: { edit: e } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['o1.audio -> tl.sounds', 'o2.audio -> tl.sounds', 'tl.audio -> out.audio'],
    });
    const r = renderGraph(d, 3);
    const rmsOf = (from: number, to: number) => Math.sqrt(r.left.slice(Math.round(from * SR), Math.round(to * SR)).reduce((s, v) => s + v * v, 0) / ((to - from) * SR));
    expect(rmsOf(0.1, 0.9)).toBe(0);
    expect(rmsOf(1.1, 1.9)).toBeGreaterThan(0.01);
    expect(rmsOf(2.1, 2.9)).toBe(0);
    expect(pitchHz(r.left, SR, Math.round(1.2 * SR))).toBeGreaterThan(900); // the 1000 Hz wire, not the 440 Hz one
  });
});
