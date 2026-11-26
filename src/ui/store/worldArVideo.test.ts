// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorldTake, type WorldSample } from '../../engine/lib/world-take';
import type { GraphDoc } from '../../engine/types';
import type { ExportRequest, Io } from '../../io/api';
import type { Editor } from './editor';
import { WorldArVideoController } from './worldArVideo';

const samples: WorldSample[] = Array.from({ length: 30 }, (_, n) => ({ t: n / 30, frame: n, view: { p: [n / 30, 1.4, 0], q: [0, 0, 0, 1] }, lens: [1, 1, 0, 0], object: { p: [0, 0, -1.5], q: [0, 0, 0, 1], scale: 1 } }));
const take = { ...buildWorldTake(samples, { fps: 30 })!, clipAsset: 'clip1', shown: 'obj' };

const graph = (t: unknown = take): GraphDoc =>
  ({
    schema: 'rsmps/graph',
    version: 2,
    name: 't',
    project: { width: 1920, height: 1080, fps: 25, duration: 4, loop: false, lengthMode: 'relative', referenceSide: 1080 },
    nodes: [
      { id: 'ar', type: 'world-ar', x: 0, y: 0, params: { take: t } },
      { id: 'obj', type: 'object-3d', x: 0, y: 0, params: {} },
    ],
    edges: [{ id: 'e', from: { node: 'ar', port: 'camera' }, to: { node: 'obj', port: 'camera' } }],
  }) as unknown as GraphDoc;

function setup(o: { clip?: boolean; run?: (req: ExportRequest) => Promise<{ name: string; blob: Blob }[]>; busy?: string; recorderBusy?: string; active?: boolean; take?: unknown } = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const added: string[] = [];
  const requests: ExportRequest[] = [];
  const g = graph(o.take === undefined ? take : o.take);
  const ed = {
    state: { graph: g, viewedNodeId: 'obj', item: 0 },
    exportBlocked: null as string | null,
    get exportBusy(): string | null {
      return o.busy ?? (this as unknown as { exportBlocked: string | null }).exportBlocked;
    },
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor;
  const io = {
    worldAr: { active: o.active ? {} : null },
    registry: { get: () => ({ outputs: { image: { type: 'image' } } }) },
    player: { getState: () => ({ playing: true }), pause: () => log.push('pause'), play: () => log.push('play') },
    library: {
      assetInfo: (id: string) => (id === 'clip1' && o.clip !== false ? { id, name: 'AR.mp4', kind: 'video', width: 1080, height: 1920, duration: 1, fps: 30, hasAudio: false } : null),
      assetAudio: async () => null,
      add: async (files: File[]) => (added.push(...files.map((f) => f.name)), files.map((f) => ({ id: 'video1', name: f.name }))),
    },
    exporter: {
      run: async (req: ExportRequest) => {
        requests.push(req);
        req.onProgress?.({ fraction: 0.5 } as never);
        log.push(`blocked: ${(ed as unknown as { exportBlocked: string | null }).exportBlocked ? 'yes' : 'no'}`);
        return o.run ? o.run(req) : [{ name: 'out.mp4', blob: new Blob(['video']) }];
      },
    },
  } as unknown as Io;
  let clock = 0;
  const ctl = new WorldArVideoController(ed, io, () => o.recorderBusy ?? null, { saveFile: (f) => void log.push(`file ${f.name}`), now: () => (clock += 4000) });
  return { ctl, ed, log, toasts, added, requests, g };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('Save as video for an AR take', () => {
  beforeEach(() => vi.stubGlobal('File', class { constructor(public parts: unknown[], public name: string, public opts: { type: string }) {} }));

  it('renders the clip frame by frame at the clip clock, saves the file and adds it to Media, and leaves the project alone', async () => {
    const t = setup();
    const before = JSON.stringify(t.ed.state.graph);
    const done = t.ctl.start('ar');
    expect(t.ctl.store.get()).toMatchObject({ phase: 'rendering', nodeId: 'ar' });
    expect(await done).toBe(true);
    const req = t.requests[0];
    expect(req.take!.frames).toBe(30); // 1 s clip at 30 fps
    expect(req.take!.at(15).seconds).toBeCloseTo(0.5, 6);
    expect(req.outputs).toHaveLength(1);
    expect(req.graph.project).toMatchObject({ width: 720, height: 1280, fps: 30 });
    expect(t.log).toEqual(['pause', 'blocked: yes', expect.stringMatching(/^file AR take .*\.mp4$/), 'play']);
    expect(t.added).toHaveLength(1);
    expect(t.toasts.at(-1)).toMatch(/Saved to your downloads and to Media.*The AR recording and its camera clip are unchanged/);
    expect(t.ctl.store.get()).toMatchObject({ phase: 'idle', nodeId: null, progress: 0 });
    expect(t.ctl.store.get().lastName).toMatch(/\.mp4$/);
    expect((t.ed as unknown as { exportBlocked: string | null }).exportBlocked).toBeNull();
    expect(JSON.stringify(t.ed.state.graph)).toBe(before); // the take and the nodes are as they were
    t.ctl.saveLast();
    expect(t.log.at(-1)).toMatch(/^file AR take/);
  });

  it('shows progress with the time left while rendering', async () => {
    let seen: { progress: number; remaining: number | null } | null = null;
    const t = setup({
      run: async () => {
        seen = t.ctl.store.get();
        return [{ name: 'a.mp4', blob: new Blob(['v']) }];
      },
    });
    await t.ctl.start('ar');
    expect(seen!.progress).toBe(0.5);
    expect(seen!.remaining).not.toBeNull();
  });

  it('Cancel stops it, says so, keeps the take and lets Save as video start again', async () => {
    let release!: () => void;
    const t = setup({
      run: (req) =>
        new Promise((resolve) => {
          release = () => resolve([{ name: 'a.mp4', blob: new Blob(['v']) }]);
          req.signal!.addEventListener('abort', release);
        }),
    });
    const first = t.ctl.start('ar');
    await settle();
    t.ctl.cancel();
    expect(await first).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/cancelled.*unchanged.*try again/);
    expect(t.added).toHaveLength(0);
    expect(t.ctl.store.get().phase).toBe('idle');
    expect(t.ed.state.graph.nodes[0].params.take).toBe(take);
    expect((t.ed as unknown as { exportBlocked: string | null }).exportBlocked).toBeNull();
    expect(t.log.at(-1)).toBe('play');
    expect(t.ctl.busy()).toBeNull();
  });

  it('a failed rendering says why in plain words, keeps the take and the clip and is not busy afterwards', async () => {
    const t = setup({ run: async () => [{ name: 'errors.txt', blob: new Blob(['AR video: this device cannot encode video\nmore']) }] });
    expect(await t.ctl.start('ar')).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/could not be made: this device cannot encode video\. The AR recording and its camera clip are unchanged\. Press "Save as video"/);
    expect(t.added).toHaveLength(0);
    expect(t.ctl.store.get().phase).toBe('idle');
    const thrown = setup({ run: async () => Promise.reject(new Error('GPU lost')) });
    expect(await thrown.ctl.start('ar')).toBe(false);
    expect(thrown.toasts.at(-1)).toMatch(/GPU lost/);
    expect(thrown.ctl.busy()).toBeNull();
  });

  it('refuses while an export, a Recorder render, another video or the AR view is running, and starts nothing', async () => {
    for (const o of [{ busy: 'An export is already running.' }, { recorderBusy: 'A recording is in progress.' }, { active: true }]) {
      const t = setup(o);
      expect(await t.ctl.start('ar')).toBe(false);
      expect(t.requests).toHaveLength(0);
      expect(t.toasts).toHaveLength(1);
      expect(t.log).toEqual([]);
    }
    const t = setup({ run: () => new Promise(() => undefined) });
    void t.ctl.start('ar');
    await settle();
    expect(await t.ctl.start('ar')).toBe(false); // the second press
    expect(t.toasts.at(-1)).toMatch(/already being saved/);
    expect(t.requests).toHaveLength(1);
    // and while it renders, an Export is refused through the shared flag
    expect((t.ed as unknown as { exportBusy: string }).exportBusy).toMatch(/video of an AR recording is being rendered/);
  });

  it('no camera clip: says so and offers the object alone; with alone it renders the viewed node over black', async () => {
    const t = setup({ take: { ...take, clipAsset: undefined } });
    expect(t.ctl.plan('ar')).toMatchObject({ clipAsset: null, clipMissing: false });
    expect(await t.ctl.start('ar')).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/no camera picture.*object alone, over black/);
    expect(t.requests).toHaveLength(0);
    expect(await t.ctl.start('ar', { alone: true })).toBe(true);
    const g = t.requests[0].graph;
    expect(g.nodes.some((n) => n.type === 'merge')).toBe(false);
    expect(t.requests[0].take!.frames).toBe(take.frames);
    // a clip that was deleted from Media is the same case, said differently
    const gone = setup({ clip: false });
    expect(gone.ctl.plan('ar')).toMatchObject({ clipAsset: null, clipMissing: true });
    expect(await gone.ctl.start('ar')).toBe(false);
    expect(gone.toasts.at(-1)).toMatch(/no longer in Media/);
  });

  it('a node without a take has nothing to make a video from', async () => {
    const t = setup({ take: null });
    expect(t.ctl.plan('ar')).toBeNull();
    expect(await t.ctl.start('ar')).toBe(false);
    expect(t.requests).toHaveLength(0);
  });
});
