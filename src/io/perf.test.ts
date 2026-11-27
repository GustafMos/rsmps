import { describe, expect, it } from 'vitest';
import { PerfAggregator, average, buildReport, decodeModeText, panelLines, percentile, scaleWords, slowestNodes, type PerfSnapshot } from './perf';

describe('percentile / average', () => {
  it('nearest rank', () => {
    const v = [5, 1, 3, 2, 4, 10, 9, 8, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 95)).toBe(0);
    expect(average(v)).toBe(5.5);
    expect(average([])).toBe(0);
  });
});

describe('PerfAggregator', () => {
  const sample = (at: number, evalMs: number, nodes: [string, number][], cached = false) => ({ at, evalMs, decodeMs: evalMs / 4, drawMs: 1, gpuWaitMs: 2, nodes: new Map(nodes), cached });

  it('averages the window and ranks the slowest nodes', () => {
    const a = new PerfAggregator(2000);
    for (let i = 0; i < 10; i++) a.add(sample(1000 + i * 100, 10 + i, [['media', 6], ['blur', 3], ['out', 0.5]]));
    const w = a.summary(2000);
    expect(w.frames).toBe(10);
    expect(w.shownPerSecond).toBeCloseTo(5, 5); // 10 frames in a 2 s window
    expect(w.evalAvg).toBeCloseTo(14.5, 5);
    expect(w.evalP95).toBe(19);
    expect(w.decodeAvg).toBeCloseTo(14.5 / 4, 5);
    expect(w.slowest.map((n) => n.id)).toEqual(['media', 'blur', 'out']);
    expect(w.slowest[0].ms).toBeCloseTo(6, 5);
  });

  it('a node that did not run in a frame counts as 0 for that frame; frames from the saved frames do not count as evaluations', () => {
    const a = new PerfAggregator(2000);
    a.add(sample(1000, 10, [['a', 8]]));
    a.add(sample(1100, 10, [])); // a was cached
    a.add({ at: 1200, evalMs: 0, decodeMs: 0, drawMs: 1, gpuWaitMs: 0, cached: true });
    const w = a.summary(1300);
    expect(w.nodeAvg).toEqual([{ id: 'a', ms: 4 }]);
    expect(w.cachedShare).toBeCloseTo(1 / 3, 5);
    expect(w.evalAvg).toBe(10);
  });

  it('forgets samples older than the window', () => {
    const a = new PerfAggregator(1000);
    a.add(sample(0, 50, [['x', 50]]));
    a.add(sample(5000, 5, [['y', 5]]));
    const w = a.summary(5000);
    expect(w.frames).toBe(1);
    expect(w.slowest.map((n) => n.id)).toEqual(['y']);
  });

  it('slowestNodes takes the top n of one evaluation', () => {
    expect(slowestNodes(new Map([['a', 1], ['b', 9], ['c', 5], ['d', 7]]), 3)).toEqual([{ id: 'b', ms: 9 }, { id: 'd', ms: 7 }, { id: 'c', ms: 5 }]);
  });
});

describe('plain words', () => {
  it('decode mode', () => {
    expect(decodeModeText({ requests: 0, sequential: 0, seeks: 0, browser: 0 })).toBe('no video frames needed');
    expect(decodeModeText({ requests: 120, sequential: 119, seeks: 1, browser: 0 })).toBe('sequential (fast)');
    expect(decodeModeText({ requests: 120, sequential: 10, seeks: 110, browser: 0 })).toMatch(/^seeking/);
    expect(decodeModeText({ requests: 0, sequential: 0, seeks: 0, browser: 120 })).toMatch(/browser video player/);
  });
  it('scale', () => {
    expect(scaleWords(1)).toBe('full size');
    expect(scaleWords(0.5)).toBe('half size');
    expect(scaleWords(0.6)).toBe('60% size');
  });
});

describe('report', () => {
  const snapshot: PerfSnapshot = {
    playing: true,
    projectFps: 30,
    window: { frames: 40, shownPerSecond: 20, evalAvg: 31.2, evalP95: 55, decodeAvg: 12.4, drawAvg: 1.1, gpuWaitAvg: 9, cachedShare: 0.25, slowest: [{ id: 'm1', ms: 14 }], nodeAvg: [{ id: 'm1', ms: 14 }, { id: 'r1', ms: 3.2 }] },
    skipped: 87,
    rendered: { width: 540, height: 960 },
    full: { width: 1080, height: 1920 },
    scale: 0.5,
    cachedFrames: 412,
    totalFrames: 772,
    decode: { requests: 300, sequential: 290, seeks: 10, browser: 0, repeats: 2, ahead: 100, waitMs: 3000 },
    uploads: { count: 300, pixels: 155_520_000, sizes: ['540x960'] },
    saving: { saved: 412, msEach: 18 },
    gpuName: 'qualcomm adreno-830',
    deviceMemoryGB: 8,
    gpuTimeMeasured: false,
  };
  const nameOf = (id: string) => ({ m1: 'Media In', r1: 'Region Overlay' })[id] ?? id;

  it('panel lines read in plain words', () => {
    const text = panelLines(snapshot, nameOf).join('\n');
    expect(text).toContain('Showing 20.0 frames per second (project: 30)');
    expect(text).toContain('Waiting for video frames: 12.4 ms');
    expect(text).toContain('Rendering at 540 x 960, half size');
    expect(text).toContain('Saved frames: 412 of 772 ready');
    expect(text).toContain('Frames skipped: 87');
    expect(text).toContain('Slowest: Media In 14.0 ms');
  });

  it('the report has the numbers, node names, types only for the graph, and says the times are estimates', () => {
    const text = buildReport({ snapshot, nameOf, nodeTypes: ['media-in', 'detect-blobs', 'track', 'region-overlay', 'output'], userAgent: 'TestAgent/1.0', appVersion: '9.9.9' });
    expect(text).toContain('app 9.9.9');
    expect(text).toContain('TestAgent/1.0');
    expect(text).toContain('Rendering at 540 x 960 (half size); full size is 1080 x 1920');
    expect(text).toContain('Saved frames: 412 of 772');
    expect(text).toContain('Media In: 14.0');
    expect(text).toContain('media-in > detect-blobs > track > region-overlay > output');
    expect(text).toContain('GPU time is not measured');
    expect(text).toContain('sequential (fast)');
    expect(text.split('\n').length).toBeLessThan(40);
  });
});
