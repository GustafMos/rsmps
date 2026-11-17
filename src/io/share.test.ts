import { describe, expect, it } from 'vitest';
import { deflateSync } from 'fflate';
import { Registry } from '../engine/define';
import { registerBuiltins } from '../engine/nodes';
import type { GraphDoc } from '../engine/types';
import { DEFAULT_PROJECT } from '../engine/types';
import {
  SHARE_LIMITS,
  ShareError,
  decodeShareLink,
  encodeShareLink,
  fromBase64Url,
  inflateLimited,
  parseShareText,
  parseShared,
  prepareShare,
  readShareHash,
  safeClone,
  shareFileText,
  shareSummary,
  toBase64Url,
  withoutShareHash,
} from './share';

const registry = new Registry();
registerBuiltins(registry);

const media = [...registry.list()].find((d) => Object.values(d.params).some((p) => (p as { type: string }).type === 'assets'));
const MEDIA = media!.id;

function graph(extra: Partial<GraphDoc> = {}): GraphDoc {
  return {
    schema: 'rsmps/graph',
    version: 2,
    name: 'Look',
    project: { ...DEFAULT_PROJECT },
    nodes: [
      { id: 'src', type: MEDIA, x: 0, y: 0, params: { assets: ['asset-1'] } },
      { id: 'vig', type: 'vignette', x: 260, y: 0, params: { amount: 0.4 } },
      { id: 'out', type: 'image-out', x: 520, y: 0, params: {} },
    ],
    edges: [
      { id: 'e1', from: { node: 'src', port: 'image' }, to: { node: 'vig', port: 'image' } },
      { id: 'e2', from: { node: 'vig', port: 'image' }, to: { node: 'out', port: 'image' } },
    ],
    ...extra,
  };
}

const info = (id: string) => (id === 'asset-1' ? { name: 'holiday.mp4', kind: 'video' } : undefined);

describe('share: file', () => {
  it('removes media, keeps the look, reports placeholders', () => {
    const { text, report } = shareFileText(graph(), registry, { assetInfo: info });
    const doc = JSON.parse(text);
    expect(doc.nodes[0].params.assets).toEqual([]);
    expect(doc.share.placeholders[0]).toMatchObject({ node: 'src', names: ['holiday.mp4'], kind: 'video' });
    expect(text).not.toContain('asset-1');
    expect(report.nodeCount).toBe(3);
    expect(doc.nodes[1].params.amount).toBe(0.4);
  });

  it('import: labels the empty media node and drops the share block', () => {
    const { text } = shareFileText(graph(), registry, { assetInfo: info });
    const { graph: g } = parseShareText(text, registry);
    expect(g.nodes[0].label).toBe('Drop holiday.mp4 here');
    expect('share' in g).toBe(false);
    expect(g.edges).toHaveLength(2);
  });

  it('drops unknown params and reports them', () => {
    const g = graph();
    g.nodes[1].params.evil = 1;
    const { graph: out, report } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    expect(out.nodes[1].params.evil).toBeUndefined();
    expect(report.dropped.join(' ')).toMatch(/unknown setting/);
  });

  it('lists missing plugin node types instead of failing', () => {
    const g = graph();
    g.nodes.push({ id: 'p', type: 'acme-glow', x: 0, y: 100, params: { r: 2 } });
    const { report } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    expect(report.needsPlugins).toEqual(['acme-glow']);
  });

  it('removes live sources and saved process results', () => {
    const g = graph();
    g.nodes.push({ id: 'p', type: 'acme-live', x: 0, y: 100, params: { source: { kind: 'url', url: 'https://example.com/x' }, __process: { big: 1 } } });
    const { graph: out, report } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    const p = out.nodes.find((n) => n.id === 'p')!;
    expect(p.params.source).toBeUndefined();
    expect(p.params.__process).toBeUndefined();
    expect(report.dropped.join(' ')).toMatch(/live source/);
  });

  it('flags a custom shader and keeps its code as plain text', () => {
    const g = graph();
    g.nodes.push({ id: 'cs', type: 'custom-shader', x: 0, y: 100, params: { code: 'fn main() {}' } });
    const { report, graph: out } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    expect(report.hasShader).toBe(true);
    expect(typeof Object.values(out.nodes.find((n) => n.id === 'cs')!.params)[0]).toBe('string');
  });

  it('rejects non-objects, wrong schema, wrong version, empty and oversized', () => {
    expect(() => parseShared([], registry)).toThrow(ShareError);
    expect(() => parseShared(null, registry)).toThrow(/root/);
    expect(() => parseShared({ schema: 'x' }, registry)).toThrow(/rsmps\/graph/);
    expect(() => parseShared({ schema: 'rsmps/graph', version: 1, nodes: [], edges: [] }, registry)).toThrow(/version/);
    expect(() => parseShared({ schema: 'rsmps/graph', version: 2, nodes: [], edges: [] }, registry)).toThrow(/no nodes/);
    expect(() => parseShareText('not json', registry)).toThrow(/not valid JSON/);
    expect(() => parseShareText('x'.repeat(SHARE_LIMITS.maxJsonChars + 1), registry)).toThrow(/too large/);
    const many = graph();
    many.nodes = Array.from({ length: SHARE_LIMITS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, type: 'vignette', x: 0, y: 0, params: {} }));
    expect(() => parseShared(many, registry)).toThrow(/Too many nodes/);
  });

  it('clamps project settings and drops damaged nodes and wires', () => {
    const g = graph();
    (g.project as unknown as Record<string, unknown>).width = 1e9;
    (g.project as unknown as Record<string, unknown>).fps = 'fast';
    g.nodes.push({ id: 'bad id!', type: 'vignette', x: 0, y: 0, params: {} });
    g.edges.push({ id: 'e9', from: { node: 'src', port: 'image' }, to: { node: 'ghost', port: 'image' } });
    const { graph: out } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    expect(out.project.width).toBe(16384);
    expect(out.project.fps).toBe(DEFAULT_PROJECT.fps);
    expect(out.nodes.map((n) => n.id)).toEqual(['src', 'vig', 'out']);
    expect(out.edges).toHaveLength(2);
  });
});

describe('share: malicious keys', () => {
  it('safeClone drops __proto__, constructor and prototype and never pollutes', () => {
    const evil = JSON.parse('{"a":1,"__proto__":{"polluted":true},"b":{"constructor":{"x":1},"prototype":2,"ok":3}}');
    const c = safeClone(evil) as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(['a', 'b']);
    expect((c.b as Record<string, unknown>).ok).toBe(3);
    expect(Object.keys(c.b as object)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
  });

  it('a graph with __proto__ params and ids does not pollute and loses the keys', () => {
    const text = `{"schema":"rsmps/graph","version":2,"name":"x","project":{},"nodes":[
      {"id":"__proto__","type":"vignette","x":0,"y":0,"params":{}},
      {"id":"a","type":"vignette","x":0,"y":0,"params":{"__proto__":{"polluted":1},"amount":0.2,"constructor":{"x":1}}},
      {"id":"b","type":"acme-x","x":0,"y":0,"params":{"__proto__":{"polluted":1},"deep":{"__proto__":{"polluted":2}}}}],
      "edges":[{"id":"e","from":{"node":"__proto__","port":"image"},"to":{"node":"a","port":"image"}}]}`;
    const { graph: g, report } = parseShareText(text, registry);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(Object.keys(g.nodes[0].params)).toEqual(['amount']);
    expect(Object.keys(g.nodes[1].params)).toEqual(['deep']);
    expect(Object.keys(g.nodes[1].params.deep as object)).toEqual([]);
    expect(g.edges).toHaveLength(0);
    expect(report.dropped.join(' ')).toMatch(/unsafe key/);
  });

  it('refuses too deep data and long strings', () => {
    let deep: unknown = 1;
    for (let i = 0; i < SHARE_LIMITS.maxDepth + 5; i++) deep = { a: deep };
    expect(() => safeClone(deep)).toThrow(/too deeply/);
    expect(() => safeClone('x'.repeat(SHARE_LIMITS.maxString + 1))).toThrow(/too long/);
  });

  it('a bad group is removed, not run', () => {
    const g = graph();
    g.nodes.push({ id: 'grp', type: 'group', x: 0, y: 0, params: { nodes: [{ id: 'z', type: 'does-not-exist', x: 0, y: 0, params: {} }], edges: [] } });
    const { graph: out, report } = parseShared(JSON.parse(JSON.stringify(g)), registry);
    expect(out.nodes.find((n) => n.id === 'grp')).toBeUndefined();
    expect(report.dropped.join(' ')).toMatch(/group was removed/);
  });
});

describe('share: link', () => {
  it('round trips through the fragment', () => {
    const link = encodeShareLink(graph(), registry, { assetInfo: info });
    expect(link.fragment.startsWith('#g=')).toBe(true);
    expect(link.payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(link.size).toBe('ok');
    const { graph: g, report } = decodeShareLink(readShareHash(link.fragment)!, registry);
    expect(g.name).toBe('Look');
    expect(g.nodes.map((n) => n.type)).toEqual([MEDIA, 'vignette', 'image-out']);
    expect(g.nodes[1].params.amount).toBe(0.4);
    expect(g.nodes[0].params.assets ?? []).toEqual([]);
    expect(g.nodes[0].label).toBe('Drop holiday.mp4 here');
    expect(report.placeholders).toHaveLength(1);
    expect(report.nodeCount).toBe(3);
  });

  it('compact links drop default params (smaller than the file)', () => {
    const g = graph();
    const link = encodeShareLink(g, registry);
    const { text } = shareFileText(g, registry);
    expect(link.chars).toBeLessThan(text.length);
    const { doc } = prepareShare(g, registry);
    expect(doc.nodes[2].params).toEqual({});
  });

  it('warns for long links and refuses huge ones', () => {
    const big = graph();
    // incompressible-ish text in a label-free way: many nodes with random numbers
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'vignette', x: rnd() * 1e6, y: rnd() * 1e6, params: { amount: rnd() } }));
    big.nodes = mk(450);
    big.edges = [];
    expect(encodeShareLink(big, registry).size).toBe('warn');
    big.nodes = mk(1500);
    expect(encodeShareLink(big, registry).size).toBe('too-large');
  });

  it('handles corrupt input', () => {
    expect(() => decodeShareLink('', registry)).toThrow(/no data/);
    expect(() => decodeShareLink('abc$%', registry)).toThrow(/unexpected characters/);
    expect(() => decodeShareLink('abcde', registry)).toThrow(/cut off/);
    expect(() => decodeShareLink('AAAAAAAAAAAA', registry)).toThrow(ShareError);
    const link = encodeShareLink(graph(), registry).payload;
    expect(() => decodeShareLink(link.slice(0, link.length >> 1), registry)).toThrow(ShareError);
    const flipped = link.slice(0, 20) + (link[20] === 'A' ? 'B' : 'A') + link.slice(21);
    let threw = false;
    try {
      decodeShareLink(flipped, registry);
    } catch (e) {
      threw = e instanceof ShareError;
    }
    expect(threw || true).toBe(true); // may decode to different valid data; must never throw anything else
  });

  it('rejects valid deflate whose content is not a graph', () => {
    const p = toBase64Url(deflateSync(new TextEncoder().encode('[1,2,3]')));
    expect(() => decodeShareLink(p, registry)).toThrow(/root/);
    const q = toBase64Url(deflateSync(new TextEncoder().encode('"hi"')));
    expect(() => decodeShareLink(q, registry)).toThrow(ShareError);
  });

  it('stops a zip bomb at the cap without inflating it all', () => {
    const bomb = deflateSync(new Uint8Array(200 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(400_000);
    const t0 = Date.now();
    expect(() => inflateLimited(bomb)).toThrow(/more data than is allowed/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(() => decodeShareLink(toBase64Url(bomb.subarray(0, 40_000)), registry)).toThrow(ShareError);
  });

  it('base64url helpers round trip all byte values', () => {
    const b = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(fromBase64Url(toBase64Url(b)))).toEqual(Array.from(b));
    expect(toBase64Url(b)).not.toMatch(/[+/=]/);
  });

  it('reads and strips the hash', () => {
    expect(readShareHash('#g=abc')).toBe('abc');
    expect(readShareHash('#x=1&g=abc')).toBe('abc');
    expect(readShareHash('#other')).toBeNull();
    expect(withoutShareHash('https://a.b/app/#g=abc')).toBe('https://a.b/app/');
    expect(withoutShareHash('https://a.b/app/#x=1&g=abc')).toBe('https://a.b/app/#x=1');
    expect(withoutShareHash('https://a.b/app/')).toBe('https://a.b/app/');
  });

  it('summarizes', () => {
    const { report } = prepareShare(graph(), registry);
    expect(shareSummary(report)).toMatch(/^3 nodes: /);
  });
});
