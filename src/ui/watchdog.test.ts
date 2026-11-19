// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RENDER_LIMIT_MS, SLOW_NOTICE_MS } from './safety';
import { RENDERING_NOTICE_MS, watchStep, type WatchState } from './watchdog';

/** Look at the player every 500 ms for `ms`, with the same input. */
function run(start: WatchState, ms: number, input: { since: number | null; hidden?: boolean; paused?: boolean }) {
  let state = start;
  let level = 'idle';
  for (let t = 0; t < ms; t += 500) ({ state, level } = watchStep(state, { since: input.since, dt: 500, hidden: input.hidden ?? false, paused: input.paused ?? false }));
  return { state, level };
}
const ZERO: WatchState = { job: null, busyMs: 0 };

describe('render watchdog', () => {
  it('an idle player never trips it, however long nothing is rendered', () => {
    expect(run(ZERO, 10 * 60_000, { since: null })).toEqual({ state: ZERO, level: 'idle' });
  });
  it('one evaluation that keeps going: rendering notice, then the slow bar, then stuck at the limit', () => {
    expect(run(ZERO, RENDERING_NOTICE_MS, { since: 100 }).level).toBe('working');
    expect(run(ZERO, RENDERING_NOTICE_MS + 600, { since: 100 }).level).toBe('rendering');
    expect(run(ZERO, SLOW_NOTICE_MS + 600, { since: 100 }).level).toBe('slow');
    expect(run(ZERO, RENDER_LIMIT_MS + 600, { since: 100 }).level).toBe('stuck');
    expect(run(ZERO, RENDER_LIMIT_MS - 600, { since: 100 }).level).toBe('slow');
  });
  it('many short evaluations (playback, a slider being dragged) never add up', () => {
    let state = ZERO;
    let level = 'idle';
    for (let i = 0; i < 400; i++) ({ state, level } = watchStep(state, { since: 1000 + i, dt: 500, hidden: false, paused: false })); // a new job at every look
    expect(level).toBe('working');
    expect(state.busyMs).toBe(0);
    // and a job that finished in between resets the count
    const a = run(ZERO, 4000, { since: 7 });
    const b = watchStep(a.state, { since: null, dt: 500, hidden: false, paused: false });
    expect(b).toEqual({ state: ZERO, level: 'idle' });
    expect(run(b.state, 4000, { since: 8 }).level).toBe('rendering');
  });
  it('time in a hidden tab is not counted, and paused rendering counts nothing', () => {
    const visible = run(ZERO, 4000, { since: 5 });
    const hidden = run(visible.state, 10 * 60_000, { since: 5, hidden: true });
    expect(hidden.state.busyMs).toBe(visible.state.busyMs);
    expect(hidden.level).toBe('rendering');
    expect(run(visible.state, 60_000, { since: 5, paused: true })).toEqual({ state: ZERO, level: 'idle' });
  });
});
