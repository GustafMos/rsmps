import { describe, expect, it } from 'vitest';
import { fitAudio } from './audio-util';
import { frameAtTime } from './clock';
import { RenderedFrameCache } from './frame-cache';
import { sizeBucket, detectKind } from './library';
import { ByteLru, TimedFrameStore } from './lru';
import { baseName, resolvePattern, sanitizeFileName, sequencePattern, uniqueName } from './naming';
import { collectDefs } from './plugins';
import { layoutSheet, sheetMetadata } from './spritesheet';
import { wrapLines } from './text';
import { renderHash, totalFramesOf } from './util';
import { createGraph, addNode, updateNode } from '../engine/graph';
import { Registry } from '../engine/define';
import { registerBuiltins } from '../engine/nodes';

describe('ByteLru', () => {
  it('evicts least recently used entries past the budget and reports them', () => {
    const evicted: string[] = [];
    const lru = new ByteLru<string, number>(100, (k) => evicted.push(k));
    lru.set('a', 1, 40);
    lru.set('b', 2, 40);
    lru.get('a'); // a is now newer than b
    lru.set('c', 3, 40);
    expect(evicted).toEqual(['b']);
    expect(lru.bytes).toBe(80);
    expect(lru.has('a') && lru.has('c')).toBe(true);
  });
  it('never evicts the entry just inserted, even when it alone is over budget', () => {
    const lru = new ByteLru<string, number>(10);
    lru.set('big', 1, 50);
    expect(lru.has('big')).toBe(true);
    lru.set('x', 2, 5);
    expect(lru.has('big')).toBe(false);
  });
  it('replacing a key releases the old value', () => {
    const evicted: number[] = [];
    const lru = new ByteLru<string, number>(100, (_k, v) => evicted.push(v));
    lru.set('a', 1, 10);
    lru.set('a', 2, 10);
    expect(evicted).toEqual([1]);
    expect(lru.bytes).toBe(10);
  });
});

describe('TimedFrameStore', () => {
  it('finds the frame covering a time and respects frame ends', () => {
    const s = new TimedFrameStore<string>(1000, () => {});
    s.put('v|0', 0, 0.04, 10, 'f0');
    s.put('v|0', 0.04, 0.08, 10, 'f1');
    s.put('v|0', 0.2, 0.24, 10, 'f5');
    expect(s.find('v|0', 0)).toBe('f0');
    expect(s.find('v|0', 0.039)).toBe('f0');
    expect(s.find('v|0', 0.04)).toBe('f1');
    expect(s.find('v|0', 0.1)).toBeUndefined(); // gap between f1 and f5
    expect(s.find('v|0', 0.21)).toBe('f5');
    expect(s.find('other', 0)).toBeUndefined();
  });
  it('evicts by bytes, drops the index entry and calls onEvict', () => {
    const evicted: string[] = [];
    const s = new TimedFrameStore<string>(25, (v) => evicted.push(v));
    s.put('g', 0, 1, 10, 'a');
    s.put('g', 1, 2, 10, 'b');
    s.put('g', 2, 3, 10, 'c');
    expect(evicted).toEqual(['a']);
    expect(s.find('g', 0.5)).toBeUndefined();
    expect(s.find('g', 1.5)).toBe('b');
  });
  it('dropGroups removes everything of an asset', () => {
    const evicted: string[] = [];
    const s = new TimedFrameStore<string>(1000, (v) => evicted.push(v));
    s.put('a1|0', 0, 1, 1, 'x');
    s.put('a1|64', 0, 1, 1, 'y');
    s.put('a2|0', 0, 1, 1, 'z');
    s.dropGroups('a1|');
    expect(evicted.sort()).toEqual(['x', 'y']);
    expect(s.find('a2|0', 0.5)).toBe('z');
  });
  it('replacing the same start keeps the index consistent', () => {
    const s = new TimedFrameStore<string>(1000, () => {});
    s.put('g', 0, 1, 1, 'old');
    s.put('g', 0, 2, 1, 'new');
    expect(s.find('g', 1.5)).toBe('new');
    expect(s.size).toBe(1);
  });
});

describe('RenderedFrameCache', () => {
  it('mirrors cached frame indices and keeps the sharper version', () => {
    const released: string[] = [];
    const c = new RenderedFrameCache<string>(100, (i) => released.push(i));
    expect(c.put(3, 'p50', 0.5, 10)).toBe(true);
    expect(c.frames.has(3)).toBe(true);
    expect(c.get(3, 1)).toBeUndefined(); // not sharp enough for a paused view
    expect(c.get(3, 0)?.image).toBe('p50');
    expect(c.put(3, 'p100', 1, 10)).toBe(true);
    expect(released).toEqual(['p50']);
    expect(c.put(3, 'p25', 0.25, 10)).toBe(false);
    expect(c.get(3, 1)?.image).toBe('p100');
  });
  it('evicting a frame removes it from the live set', () => {
    const c = new RenderedFrameCache<string>(20, () => {});
    c.put(0, 'a', 1, 10);
    c.put(1, 'b', 1, 10);
    c.put(2, 'c', 1, 10);
    expect([...c.frames].sort()).toEqual([1, 2]);
    c.clear();
    expect(c.frames.size).toBe(0);
  });
});

describe('frameAtTime', () => {
  it('follows wall time and drops frames', () => {
    expect(frameAtTime(0, 0, 24, 96, true).frame).toBe(0);
    expect(frameAtTime(0, 1000, 24, 96, true).frame).toBe(24);
    expect(frameAtTime(10, 500, 24, 96, true).frame).toBe(22);
    // A 300 ms stall jumps ahead instead of drifting.
    expect(frameAtTime(0, 42, 24, 96, true).frame).toBe(1);
    expect(frameAtTime(0, 341.7, 24, 96, true).frame).toBe(8);
  });
  it('wraps when looping and reports the cycle', () => {
    const r = frameAtTime(0, 4500, 24, 96, true);
    expect(r.cycle).toBe(1);
    expect(r.frame).toBe(12);
  });
  it('stops at the last frame when not looping', () => {
    const r = frameAtTime(0, 10_000, 24, 96, false);
    expect(r.ended).toBe(true);
    expect(r.frame).toBe(95);
    expect(frameAtTime(0, 1000, 24, 96, false).ended).toBe(false);
  });
});

describe('naming', () => {
  const t = { name: 'hero.png', index: 0, count: 12, width: 64, height: 32, frame: 7, frameCount: 96 };
  it('resolves tokens', () => {
    expect(resolvePattern('{name}_{width}x{height}', t)).toBe('hero_64x32');
    expect(resolvePattern('sprite_{index}', t)).toBe('sprite_01');
    expect(resolvePattern('f{frame}', t)).toBe('f0007');
    expect(resolvePattern('', t)).toBe('hero');
    expect(resolvePattern('{nope}x', t)).toBe('x');
  });
  it('pads {index} to the batch size and is 1-based', () => {
    expect(resolvePattern('{index}', { ...t, index: 11, count: 120 })).toBe('012');
  });
  it('strips a typed extension and illegal characters', () => {
    expect(resolvePattern('out/{name}.png', t)).toBe('out_hero');
    expect(sanitizeFileName('a:b*c?')).toBe('a_b_c_');
    expect(sanitizeFileName('   ')).toBe('output');
    expect(baseName('a.b.png')).toBe('a.b');
  });
  it('sequence patterns always contain {frame}', () => {
    expect(sequencePattern('{name}')).toBe('{name}_{frame}');
    expect(sequencePattern('x_{frame}')).toBe('x_{frame}');
    expect(sequencePattern('x.png')).toBe('x_{frame}');
  });
  it('makes names unique before the extension', () => {
    const used = new Set<string>();
    expect(uniqueName(used, 'a.png')).toBe('a.png');
    expect(uniqueName(used, 'a.png')).toBe('a-2.png');
    expect(uniqueName(used, 'a.png')).toBe('a-3.png');
  });
});

describe('spritesheet', () => {
  it('auto columns is about square and covers every frame', () => {
    const l = layoutSheet(10, 16, 16, 0, 0);
    expect(l.columns).toBe(4);
    expect(l.rows).toBe(3);
    expect(l.width).toBe(64);
    expect(l.height).toBe(48);
    expect(l.rects).toHaveLength(10);
    expect(l.rects[9]).toEqual({ x: 16, y: 32, w: 16, h: 16 });
  });
  it('honours columns and padding between frames', () => {
    const l = layoutSheet(6, 10, 20, 3, 2);
    expect(l.columns).toBe(3);
    expect(l.rows).toBe(2);
    expect(l.width).toBe(3 * 10 + 2 * 2);
    expect(l.height).toBe(2 * 20 + 2);
    expect(l.rects[4]).toEqual({ x: 12, y: 22, w: 10, h: 20 });
  });
  it('never makes more columns than frames', () => {
    expect(layoutSheet(2, 8, 8, 64, 0).columns).toBe(2);
    expect(layoutSheet(1, 8, 8, 0, 0).width).toBe(8);
  });
  it('metadata carries fps and loop for Godot', () => {
    const m = sheetMetadata(layoutSheet(4, 8, 8, 2, 0), 'x.png', 12, true);
    expect(m).toMatchObject({ image: 'x.png', fps: 12, loop: true, frameCount: 4, columns: 2, rows: 2 });
    expect(m.frames[3]).toMatchObject({ index: 3, x: 8, y: 8, w: 8, h: 8 });
  });
});

describe('library helpers', () => {
  it('detects kinds by mime and extension', () => {
    expect(detectKind({ name: 'a.PNG', type: '' })).toBe('image');
    expect(detectKind({ name: 'a.mov', type: '' })).toBe('video');
    expect(detectKind({ name: 'a.mp3', type: 'audio/mpeg' })).toBe('audio');
    expect(detectKind({ name: 'a.mid', type: 'audio/midi' })).toBe('midi');
    expect(detectKind({ name: 'a.txt', type: 'text/plain' })).toBeNull();
  });
  it('buckets requested sizes and caps at the device limit', () => {
    expect(sizeBucket(1920, 1080, 0, 8192)).toEqual({ bucket: 0, width: 1920, height: 1080 });
    expect(sizeBucket(1920, 1080, 960, 8192)).toEqual({ bucket: 960, width: 960, height: 540 });
    expect(sizeBucket(1920, 1080, 5000, 8192).bucket).toBe(0);
    const big = sizeBucket(16000, 8000, 0, 8192);
    expect(big.width).toBe(8192);
    expect(big.height).toBe(4096);
    // Near-identical requests share a bucket.
    expect(sizeBucket(1920, 1080, 961, 8192).bucket).toBe(sizeBucket(1920, 1080, 962, 8192).bucket);
  });
});

describe('text wrapping', () => {
  const measure = (s: string) => s.length * 10;
  it('keeps explicit newlines and wraps at spaces', () => {
    expect(wrapLines('ab\ncd', 0, measure)).toEqual(['ab', 'cd']);
    expect(wrapLines('hello big world', 100, measure)).toEqual(['hello big', 'world']);
  });
  it('splits a word wider than the box', () => {
    expect(wrapLines('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('fitAudio', () => {
  const pcm = { sampleRate: 4, channels: [Float32Array.from([1, 2, 3, 4])] };
  it('loops the source to fill the duration', () => {
    expect(Array.from(fitAudio(pcm, 0, 2, true).channels[0])).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });
  it('pads with silence when not looping and applies the start offset', () => {
    expect(Array.from(fitAudio(pcm, 0.5, 1, false).channels[0])).toEqual([3, 4, 0, 0]);
  });
});

describe('renderHash', () => {
  const registry = new Registry();
  registerBuiltins(registry);
  it('ignores node positions but not params or wiring', () => {
    let g = createGraph('t');
    const a = addNode(g, registry, 'noise', { x: 0, y: 0 });
    g = a.graph;
    const h0 = renderHash(g, a.node.id, undefined);
    const moved = updateNode(g, a.node.id, { x: 500, y: 40, label: 'hi' });
    expect(renderHash(moved, a.node.id, undefined)).toBe(h0);
    const changed = updateNode(g, a.node.id, { params: { ...a.node.params, seed: 99 } });
    expect(renderHash(changed, a.node.id, undefined)).not.toBe(h0);
    expect(renderHash(g, 'other', undefined)).not.toBe(h0);
  });
  it('counts project frames', () => {
    expect(totalFramesOf({ duration: 4, fps: 24 })).toBe(96);
    expect(totalFramesOf({ duration: 0, fps: 24 })).toBe(1);
  });
});

describe('plugin module scanning', () => {
  it('finds a default export object or array and named exports', () => {
    const def = (id: string) => ({ id, title: 't', inputs: {}, outputs: {}, params: {} });
    expect(collectDefs({ default: def('a/b') }).map((d) => d.id)).toEqual(['a/b']);
    expect(collectDefs({ default: [def('a/b'), def('a/c')], other: def('a/d'), junk: 5 }).map((d) => d.id)).toEqual(['a/b', 'a/c', 'a/d']);
    expect(collectDefs({ default: { nope: 1 } })).toEqual([]);
  });
});

import { isGlbMagic, sniffModel } from './library';

describe('3D model files', () => {
  it('detects models by extension and mime', () => {
    expect(detectKind({ name: 'ship.GLB', type: '' })).toBe('model');
    expect(detectKind({ name: 'a.gltf', type: 'model/gltf+json' })).toBe('model');
    expect(detectKind({ name: 'thing.obj', type: '' })).toBe('model');
    expect(detectKind({ name: 'x', type: 'model/gltf-binary' })).toBe('model');
    expect(detectKind({ name: 'readme.txt', type: 'text/plain' })).toBeNull();
  });
  it('checks the magic bytes of a GLB and the shape of the other formats', () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(isGlbMagic(glb)).toBe(true);
    expect(isGlbMagic(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(sniffModel('glb', glb).ok).toBe(true);
    expect(sniffModel('glb', new Uint8Array(16)).ok).toBe(false);
    expect(sniffModel('gltf', new TextEncoder().encode('  {"asset":{"version":"2.0"}}')).ok).toBe(true);
    expect(sniffModel('gltf', new TextEncoder().encode('not json')).reason).toMatch(/not JSON/);
    expect(sniffModel('obj', new TextEncoder().encode('v 0 0 0')).ok).toBe(true);
    expect(sniffModel('obj', new Uint8Array(0)).ok).toBe(false);
  });
});
