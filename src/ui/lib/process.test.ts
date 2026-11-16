import { describe, expect, it } from 'vitest';
import type { ProcessJob } from '../../io/api';
import { formatElapsed, jobLine, processBadge, processStateText } from './process';

const job = (p: Partial<ProcessJob>): ProcessJob => ({ id: 'j', project: 'p', node: 'n', title: 'Analyse clip', label: 'Track', state: 'running', progress: 0.42, gpu: false, queuedAt: 0, ...p });

describe('process badge and texts', () => {
  it('shows nothing for a node that never ran, the state otherwise', () => {
    expect(processBadge('Bake', 'none', null)).toBeNull();
    expect(processBadge('Bake', 'done', null)).toMatchObject({ text: 'done', kind: 'done' });
    expect(processBadge('Bake', 'stale', null)).toMatchObject({ text: 'stale', kind: 'stale' });
    expect(processBadge('Bake', 'missing', null)).toMatchObject({ text: 'lost', kind: 'missing' });
  });
  it('a job wins over the stored state', () => {
    expect(processBadge('Bake', 'done', job({ state: 'running' }))).toMatchObject({ text: '42%', kind: 'running' });
    expect(processBadge('Bake', 'none', job({ state: 'queued' }))).toMatchObject({ text: 'queued', kind: 'queued' });
    expect(processBadge('Bake', 'none', job({ state: 'paused', pausedFor: 'playback' }))).toMatchObject({ text: 'paused 42%', kind: 'paused' });
    expect(processBadge('Bake', 'stale', job({ state: 'failed', error: 'boom' }))).toMatchObject({ text: 'failed', kind: 'failed' });
    expect(processBadge('Bake', 'done', job({ state: 'done' }))).toMatchObject({ kind: 'done' }); // a finished job leaves the stored state in charge
  });
  it('explains what is shown meanwhile and that nothing restarts by itself', () => {
    expect(processStateText('Bake', 'bypass', 'none', null)).toMatch(/passes through/);
    expect(processStateText('Analyse clip', 'last', 'stale', null)).toMatch(/old result is still shown[\s\S]*never restarts/);
    expect(processStateText('Bake', 'placeholder', 'missing', null)).toMatch(/gone/);
    expect(processStateText('Bake', 'bypass', 'none', job({ state: 'failed', error: 'no GPU' }))).toMatch(/failed: no GPU/);
  });
  it('formats time and job lines', () => {
    expect(formatElapsed(4200)).toBe('4 s');
    expect(formatElapsed(125000)).toBe('2 min 05 s');
    expect(jobLine(job({}))).toBe('Analyse clip · Track · 42%');
    expect(jobLine(job({ state: 'paused', pausedFor: 'playback' }))).toBe('Analyse clip · Track · paused at 42% (playback)');
  });
});
