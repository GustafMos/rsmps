import { describe, expect, it } from 'vitest';
import { ArSessionStats } from './ar-report';
import { wantsRoomLight } from './engine-source';
import { createGraph } from '../../engine/graph';
import type { GraphDoc } from '../../engine/types';

const meta = { appVersion: '0.63.0', steadying: 'auto', granted: ['hit-test', 'anchors'], route: 'canvas', picture: { width: 540, height: 960 }, groundShadow: true, antiAlias: 'edges', roomLight: true, roomLightSeen: true, physics: false, seconds: 42 };

describe('the AR report', () => {
  it('holds averages and worst values, the route, size, features and extras, and nothing personal', () => {
    const s = new ArSessionStats();
    s.add({ fps: 0, pictureFps: 0, renderMs: 0, copyMs: 0, pictureBehindMs: 0, zoom: 1 }); // loading: left out
    s.add({ fps: 30, pictureFps: 10, renderMs: 40, copyMs: 2, pictureBehindMs: 150, zoom: 1 });
    s.add({ fps: 20, pictureFps: 6, renderMs: 80, copyMs: 4, pictureBehindMs: 250, zoom: 2 });
    const t = s.report(meta);
    expect(t).toContain('app version: 0.63.0');
    expect(t).toContain('screen frames per second: average 25, worst 20');
    expect(t).toContain('object pictures per second: average 8, worst 6');
    expect(t).toContain('render per picture: average 60 ms, worst 80 ms');
    expect(t).toContain('object picture behind: average 200 ms, worst 250 ms');
    expect(t).toContain('picture route: canvas');
    expect(t).toContain('picture size: 540x960');
    expect(t).toContain('granted features: hit-test, anchors');
    expect(t).toContain('ground shadow on, anti-aliasing edges');
    expect(t).toContain('room light: on, estimates received');
    expect(t).toContain('largest zoom: 2.0x');
    expect(t).toContain('steadying: auto');
    expect(t).not.toMatch(/http|@/);
  });
  it('says so when nothing was sampled', () => {
    expect(new ArSessionStats().report({ ...meta, picture: null, granted: [] })).toContain('no samples');
  });
});

describe('wantsRoomLight', () => {
  const g = (params: Record<string, unknown> | null): GraphDoc => ({ ...createGraph('p'), nodes: params ? [{ id: 'c', type: 'world-ar', x: 0, y: 0, params }] : [] });
  it('is true while a World AR Camera matches the room light (the default), false when switched off or when there is none', () => {
    expect(wantsRoomLight(g({}))).toBe(true);
    expect(wantsRoomLight(g({ matchLight: false }))).toBe(false);
    expect(wantsRoomLight(g(null))).toBe(false);
  });
});
