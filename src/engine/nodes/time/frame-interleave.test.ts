import { afterEach, describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { addNode, connect, createGraph, effectiveDuration, moveWire, withEffectiveDuration } from '../../graph';
import { seamRatio } from '../../lib/copy-testutil';
import { reconcileMediaEdits } from '../../lib/media-edit-graph';
import { harness, RenderTally, type Harness } from '../../testing';
import type { GraphDoc, ImageValue, ProjectSettings } from '../../types';
import def from './frame-interleave.node';

/**
 * A source that encodes WHO and WHEN in its pixel: red = identity * 40, green = frame * 8 (so frame 5 of source 2 is [80, 40]).
 * `still` sources ignore the clock. Every render is counted and the last picture kept (to prove the node hands it on without a copy).
 */
const spy = { last: null as ImageValue | null };
const enc = defineNode({
  id: 'enc-src',
  title: 'enc',
  category: 'input',
  description: 'test source',
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: {
    ident: { type: 'number', default: 1, min: 0, max: 6, integer: true },
    still: { type: 'bool', default: false },
    size: { type: 'number', default: 8, min: 1, max: 64, integer: true },
  },
  render(ctx) {
    const frame = ctx.params.still ? 0 : ctx.time.frame;
    const s = ctx.params.size;
    const image = ctx.gpu.pass({
      label: 'enc-src',
      size: { width: s, height: s },
      uniforms: { c: [(ctx.params.ident * 40) / 255, Math.min(255, frame * 8) / 255, 0] },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.c, 1.0); }',
    });
    spy.last = image;
    return { image };
  },
});

interface Rig {
  t: Harness;
  graph: GraphDoc;
  node: string;
  srcs: string[];
}
async function rig(params: Record<string, unknown>, n: number, o: { still?: boolean; size?: number; project?: Partial<ProjectSettings> } = {}): Promise<Rig> {
  const t = await harness([enc]);
  let g = createGraph('t');
  g.project = { ...g.project, fps: 10, duration: 3, loop: true, width: 8, height: 8, ...o.project };
  const node = addNode(g, t.registry, 'frame-interleave', { x: 0, y: 0 }, { count: n, ...params });
  g = node.graph;
  const srcs: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = addNode(g, t.registry, 'enc-src', { x: 0, y: 0 }, { ident: i + 1, still: !!o.still, size: o.size ?? 8 });
    g = connect(s.graph, t.registry, { node: s.node.id, port: 'image' }, { node: node.node.id, port: 'sources' });
    srcs.push(s.node.id);
  }
  return { t, graph: g, node: node.node.id, srcs };
}

/** What the picture at output frame f says: [source identity, source frame]. */
async function look(r: Rig, f: number, graph: GraphDoc = r.graph) {
  const res = await r.t.engine.evaluate({ graph, node: r.node, seconds: f / graph.project.fps });
  if (res.errors.size) throw new Error([...res.errors.values()].join('; '));
  const px = (await r.t.pixels(res.value as ImageValue)).at(0, 0);
  return { who: px[0] / 40, frame: px[1] / 8, result: res };
}
const seq = async (r: Rig, frames: number) => {
  const out: string[] = [];
  for (let f = 0; f < frames; f++) {
    const { who, frame } = await look(r, f);
    out.push(`v${who}f${frame + 1}`);
  }
  return out;
};

/** Counts the passes the node itself makes (labels starting with "interleave"). */
let spied: { pass?: unknown } | null = null;
function spyPasses(t: Harness) {
  const labels: string[] = [];
  const gpu = t.gpu as unknown as { pass: (o: { label?: string }) => unknown };
  const orig = gpu.pass.bind(t.gpu);
  spied = gpu;
  gpu.pass = (o) => {
    labels.push(o.label ?? '');
    return orig(o);
  };
  return { mine: () => labels.filter((l) => l.startsWith('interleave')).length, reset: () => (labels.length = 0) };
}
afterEach(() => {
  // the gpu is shared by the whole file: drop the instance-level spy so it never leaks into the next test
  if (spied) delete spied.pass;
  spied = null;
});

describe('frame interleave: the right source AND the right frame appear', () => {
  it('alternate (in-step), 3 sources', async () => {
    const r = await rig({ mode: 'in-step' }, 3);
    expect(await seq(r, 8)).toEqual(['v1f1', 'v2f2', 'v3f3', 'v1f4', 'v2f5', 'v3f6', 'v1f7', 'v2f8']);
  });
  it('every frame of every source, longer', async () => {
    const r = await rig({ mode: 'every-frame', timing: 'longer' }, 2);
    expect(await seq(r, 8)).toEqual(['v1f1', 'v2f1', 'v1f2', 'v2f2', 'v1f3', 'v2f3', 'v1f4', 'v2f4']);
  });
  it('every frame, keep the length', async () => {
    const r = await rig({ mode: 'every-frame', timing: 'same-length' }, 2);
    expect(await seq(r, 8)).toEqual(['v1f1', 'v2f1', 'v1f3', 'v2f3', 'v1f5', 'v2f5', 'v1f7', 'v2f7']);
  });
  it('pattern, hold and offsets reach the pictures', async () => {
    const r = await rig({ mode: 'every-frame', timing: 'longer', pattern: '2,1', hold: 2, offsets: '0,5' }, 2);
    expect(await seq(r, 12)).toEqual(['v1f1', 'v1f1', 'v1f2', 'v1f2', 'v2f6', 'v2f6', 'v1f3', 'v1f3', 'v1f4', 'v1f4', 'v2f7', 'v2f7']);
  });
  it('an invalid pattern falls back to 1 each and says so in the summary', async () => {
    const r = await rig({ mode: 'every-frame', pattern: '2,1' }, 3);
    expect(await seq(r, 6)).toEqual(['v1f1', 'v2f1', 'v3f1', 'v1f2', 'v2f2', 'v3f2']);
    expect(def.summary!({ ...paramsOf(r), pattern: '2,1' } as never)).toContain('pattern needs 3 numbers, has 2');
  });
  it('reordering the wires changes the sequence', async () => {
    const r = await rig({ mode: 'every-frame', timing: 'longer' }, 3);
    expect(await seq(r, 3)).toEqual(['v1f1', 'v2f1', 'v3f1']);
    const first = r.graph.edges.filter((e) => e.to.node === r.node)[0];
    const moved = moveWire(r.graph, first.id, 1); // first source is now second
    const out: string[] = [];
    for (let f = 0; f < 3; f++) out.push(`v${(await look(r, f, moved)).who}`);
    expect(out).toEqual(['v2', 'v1', 'v3']);
  });
});

const paramsOf = (r: Rig) => ({ ...Object.fromEntries(Object.entries(def.params).map(([k, p]) => [k, (p as { default: unknown }).default])), ...r.graph.nodes.find((n) => n.id === r.node)!.params });

describe('frame interleave: laziness, pulls and passes', () => {
  it('evaluates only the source it shows: other sources render 0 times, exactly one source render per output frame', async () => {
    const r = await rig({ mode: 'in-step' }, 3);
    const tally = new RenderTally();
    for (let f = 0; f < 9; f++) {
      const { result } = await look(r, f);
      const ids = tally.add(result);
      expect(ids.filter((id) => r.srcs.includes(id))).toEqual([r.srcs[f % 3]]); // exactly one pull, the right wire
    }
    expect(r.srcs.map((s) => tally.get(s))).toEqual([3, 3, 3]);
    expect(tally.get(r.node)).toBe(9);
  });
  it('a source that is never reached is never evaluated (pattern gives wire 3 no turn within the frames asked)', async () => {
    const r = await rig({ mode: 'in-step', pattern: '1,1,6' }, 3);
    const tally = new RenderTally();
    for (let f = 0; f < 2; f++) tally.add((await look(r, f)).result);
    expect(tally.get(r.srcs[2])).toBe(0);
  });
  it('default configuration: no pass, no copy: the output IS the pulled picture', async () => {
    const r = await rig({ mode: 'in-step' }, 2);
    const passes = spyPasses(r.t);
    for (let f = 0; f < 6; f++) {
      const { result } = await look(r, f);
      expect((result.value as ImageValue).texture).toBe(spy.last!.texture);
    }
    expect(passes.mine()).toBe(0);
  });
  it('fit "as is" hands on a source of another size untouched; fit inside makes exactly one pass', async () => {
    const asIs = await rig({ fit: 'as-is' }, 2, { size: 16 });
    const p1 = spyPasses(asIs.t);
    const a = await look(asIs, 0);
    expect((a.result.value as ImageValue).width).toBe(16);
    expect(p1.mine()).toBe(0);

    const fit = await rig({ fit: 'contain' }, 2, { size: 16 });
    const p2 = spyPasses(fit.t);
    const b = await look(fit, 0);
    expect((b.result.value as ImageValue).width).toBe(8);
    expect(b.who).toBe(1);
    expect(p2.mine()).toBe(1);
  });
  it('blend: two pulls and one pass per frame, and the picture is the mix of this step and the previous one', async () => {
    const r = await rig({ mode: 'in-step', blend: 0.5 }, 2, { project: { loop: false } });
    const passes = spyPasses(r.t);
    const first = await look(r, 0); // nothing before it: passed through
    expect(first.who).toBe(1);
    expect(passes.mine()).toBe(0);
    const tally = new RenderTally();
    const px = (await (async () => {
      const res = await r.t.engine.evaluate({ graph: r.graph, node: r.node, seconds: 0.3 });
      tally.add(res);
      return r.t.pixels(res.value as ImageValue);
    })()).at(0, 0);
    // output frame 3 = v2 at its frame 3 (r 80, g 24); the previous output = v1 at frame 2 (r 40, g 16)
    expect(Math.abs(px[0] - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(px[1] - 20)).toBeLessThanOrEqual(1);
    expect(r.srcs.reduce((a, s) => a + tally.get(s), 0)).toBe(2);
    expect(passes.mine()).toBe(1);
  });
  it('still sources: rendered once in total, no blend pass when the previous picture is the same source', async () => {
    const r = await rig({ mode: 'every-frame', pattern: '2,1', blend: 0.5 }, 2, { still: true, project: { loop: false } });
    const passes = spyPasses(r.t);
    const tally = new RenderTally();
    for (let f = 0; f < 12; f++) tally.add((await look(r, f)).result);
    expect(tally.get(r.srcs[0])).toBe(1);
    expect(tally.get(r.srcs[1])).toBe(1);
    // wires: v1 v1 v2 v1 v1 v2 ...  frame 0 has no predecessor; frames 1, 4, 7, 10 follow the same still source: nothing to blend
    expect(passes.mine()).toBe(12 - 1 - 4);
  });
});

describe('frame interleave: project length', () => {
  const build = async (params: Record<string, unknown>) => {
    const t = await harness();
    const a = addNode(createGraph(), t.registry, 'frame-interleave', { x: 0, y: 0 }, params);
    return { t, graph: { ...a.graph, project: { ...a.graph.project, fps: 24, duration: 4 } } as GraphDoc };
  };
  const len = async (p: Record<string, unknown>) => {
    const b = await build(p);
    return effectiveDuration(b.graph, b.t.registry);
  };
  it('every frame / longer / setsLength: N times the length of one source', async () => {
    expect(await len({ mode: 'every-frame', timing: 'longer', setsLength: true, baseSeconds: 4, count: 3 })).toBe(12);
    expect(await len({ mode: 'every-frame', timing: 'longer', setsLength: true, baseSeconds: 5, count: 2, hold: 2 })).toBe(20);
    expect(await len({ mode: 'every-frame', timing: 'longer', setsLength: true, baseSeconds: 4, count: 2, pattern: '2,1' })).toBe(12);
  });
  it('otherwise the project keeps its length', async () => {
    const ok = { mode: 'every-frame', timing: 'longer', setsLength: true, baseSeconds: 4, count: 3 };
    expect(await len({ ...ok, setsLength: false })).toBeNull();
    expect(await len({ ...ok, mode: 'in-step' })).toBeNull();
    expect(await len({ ...ok, timing: 'same-length' })).toBeNull();
    expect(await len({ ...ok, baseSeconds: 0 })).toBeNull();
    expect(await len({ ...ok, count: 1 })).toBeNull();
  });
  it('withEffectiveDuration writes it onto the project', async () => {
    const b = await build({ mode: 'every-frame', timing: 'longer', setsLength: true, baseSeconds: 4, count: 2 });
    expect(withEffectiveDuration(b.graph, b.t.registry).project.duration).toBe(8);
  });
  it('summary: "3 sources · every frame · 3× longer" and the loop hint', () => {
    const p = { mode: 'every-frame', timing: 'longer', count: 3, pattern: '', hold: 1, frames: 96 };
    expect(def.summary!(p as never)).toBe('3 sources · every frame · 3× longer');
    expect(def.summary!({ ...p, mode: 'in-step', hold: 5 } as never)).toBe('3 sources · alternate · hold 5 · cycle of 15 does not divide 96 frames');
    expect(def.summary!({ ...p, frames: 97 } as never)).toContain('cycle of 3 does not divide 97 frames');
  });
});

describe('frame interleave: kept in step with the wires', () => {
  const describeLen = (info: Record<string, number>) => (from: { node: { id: string } }) => ({ name: 'x', duration: info[from.node.id] ?? 0 });
  it('count, base length and project frames follow the wires', async () => {
    const t = await harness();
    let g = createGraph('w');
    g.project = { ...g.project, fps: 10, duration: 6 };
    const n = addNode(g, t.registry, 'frame-interleave', { x: 0, y: 0 }, { mode: 'every-frame', timing: 'longer', setsLength: true });
    g = n.graph;
    const srcs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = addNode(g, t.registry, 'noise');
      g = s.graph;
      srcs.push(s.node.id);
    }
    const info = { [srcs[0]]: 0, [srcs[1]]: 4, [srcs[2]]: 9 };
    let prev = g;
    for (const s of srcs.slice(0, 2)) {
      const next = connect(prev, t.registry, { node: s, port: 'image' }, { node: n.node.id, port: 'sources' });
      g = reconcileMediaEdits(prev, next, describeLen(info));
      prev = g;
    }
    const p = () => g.nodes.find((x) => x.id === n.node.id)!.params;
    expect(p()).toMatchObject({ count: 2, baseSeconds: 4, frames: 80 }); // 2 x 4 s at 10 fps
    // a third source does not overwrite the base length that is already set
    g = reconcileMediaEdits(prev, connect(prev, t.registry, { node: srcs[2], port: 'image' }, { node: n.node.id, port: 'sources' }), describeLen(info));
    expect(p()).toMatchObject({ count: 3, baseSeconds: 4, frames: 120 });
    // and the project length now follows
    expect(effectiveDuration(g, t.registry)).toBe(12);
    // nothing changed: same object back
    expect(reconcileMediaEdits(g, g, describeLen(info))).toBe(g);
    const again = reconcileMediaEdits(g, { ...g }, describeLen(info));
    expect(again.nodes).toBe(g.nodes);
    // removing a wire lowers the count
    const removed = { ...g, edges: g.edges.filter((e) => e.id !== g.edges.filter((x) => x.to.node === n.node.id)[2].id) };
    expect(reconcileMediaEdits(g, removed, describeLen(info)).nodes.find((x) => x.id === n.node.id)!.params.count).toBe(2);
  });
});

describe('frame interleave: loops', () => {
  it('alternating two sources closes the loop when the length is a whole number of cycles, and visibly cuts it when not', async () => {
    const t = await harness();
    const a = t.solid(48, 48, [255, 0, 0, 255]);
    const b = t.solid(48, 48, [0, 0, 255, 255]);
    const params = { mode: 'in-step', count: 2 };
    const even = await seamRatio(t, 'frame-interleave', params, { sources: [a, b] } as never, 16);
    expect(even.typical).toBeGreaterThan(10);
    expect(even.wrap).toBeGreaterThan(even.typical * 0.9); // A B A B ... B -> A: the loop keeps alternating
    const odd = await seamRatio(t, 'frame-interleave', params, { sources: [a, b] } as never, 15);
    expect(odd.wrap).toBeLessThan(odd.typical * 0.1); // ... A -> A: the last cycle was cut, a held frame at the seam
  });
});
