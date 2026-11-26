import { describe, expect, it } from 'vitest';
import type { GraphDoc } from '../engine/types';
import { SHOOT_VIEW_PARAM, shootingIds, shootNodeIds, stampShoot, withoutIdleStopMotionInputs } from './live-stamp';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params });
const edge = (from: string, to: string, port = 'image') => ({ id: `${from}-${to}`, from: { node: from, port: 'image' }, to: { node: to, port } });
const graph = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]) => ({ project: { fps: 10 }, nodes, edges }) as unknown as GraphDoc;
const shots = [{ asset: 'a', kind: 'still' }];

describe('Stop Motion shoot view stamp', () => {
  const g = graph([node('cam', 'camera-in'), node('sm', 'stop-motion', { shots }), node('sm2', 'stop-motion', { shots }), node('blur', 'blur')], [edge('cam', 'sm'), edge('sm', 'blur')]);

  it('only the selected Stop Motion is a candidate', () => {
    expect([...shootNodeIds(g, ['sm'], 'blur')]).toEqual(['sm']);
    expect([...shootNodeIds(g, [], 'blur')]).toEqual([]);
    expect([...shootNodeIds(g, ['blur'], 'blur')]).toEqual([]);
  });

  it('multi-selection: the primary (last selected) one counts, and only if it is a Stop Motion', () => {
    expect([...shootNodeIds(g, ['sm', 'sm2'], 'blur')]).toEqual(['sm2']);
    expect([...shootNodeIds(g, ['sm2', 'sm'], 'blur')]).toEqual(['sm']);
    expect([...shootNodeIds(g, ['sm', 'blur'], 'blur')]).toEqual([]);
  });

  it('paused + selected shoots; paused + not selected, playing + selected give the animation', () => {
    const sel = shootNodeIds(g, ['sm'], 'blur');
    expect(shootingIds(g, sel, true).has('sm')).toBe(true);
    expect(shootingIds(g, shootNodeIds(g, [], 'blur'), true).has('sm')).toBe(false);
    expect(shootingIds(g, sel, false).has('sm')).toBe(false);
  });

  it('exports never stamp: without a stamp nothing shoots in Automatic', () => {
    expect(stampShoot(g, new Set())).toBe(g);
    expect(shootingIds(g, new Set(), true).size).toBe(0);
  });

  it('the forced Show values do not depend on selection or play state', () => {
    const f = graph([node('a', 'stop-motion', { show: 'live', shots }), node('b', 'stop-motion', { show: 'loop', shots })], []);
    const stamped = new Set(['a', 'b']);
    for (const paused of [true, false]) expect([...shootingIds(f, stamped, paused)]).toEqual(['a']);
    expect([...shootingIds(f, new Set(), false)]).toEqual(['a']);
  });

  it('stamps the hidden param on the chosen node only', () => {
    const out = stampShoot(g, new Set(['sm']));
    expect(out.nodes.find((n) => n.id === 'sm')!.params[SHOOT_VIEW_PARAM]).toBe('1');
    expect(out.nodes.find((n) => n.id === 'sm2')!.params[SHOOT_VIEW_PARAM]).toBeUndefined();
  });

  describe('Media Timeline', () => {
    const t = graph([node('sm', 'stop-motion', { shots }), node('tl', 'media-timeline')], [edge('sm', 'tl')]);
    it('a Stop Motion feeding the shown timeline always gives the animation', () => {
      expect(shootNodeIds(t, ['sm'], 'tl').size).toBe(0);
    });
    it('viewing the Stop Motion itself is not affected by the timeline downstream', () => {
      expect([...shootNodeIds(t, ['sm'], 'sm')]).toEqual(['sm']);
    });
  });

  describe('live sources', () => {
    it('an idle Stop Motion with shots does not need its input; a shooting one or an empty one does', () => {
      const idle = withoutIdleStopMotionInputs(g, new Set());
      expect(idle.edges.some((e) => e.to.node === 'sm')).toBe(false);
      expect(idle.edges.some((e) => e.to.node === 'blur')).toBe(true);
      expect(withoutIdleStopMotionInputs(g, new Set(['sm'])).edges.length).toBe(2);
      const empty = graph([node('cam', 'camera-in'), node('sm', 'stop-motion', { shots: [] })], [edge('cam', 'sm')]);
      expect(withoutIdleStopMotionInputs(empty, new Set())).toBe(empty);
    });
  });
});
