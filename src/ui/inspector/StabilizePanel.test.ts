import { describe, expect, it } from 'vitest';
import { stabilizeFacts, stabilizeStateText } from './StabilizePanel';

describe('Stabilize panel texts', () => {
  it('says what the node shows in every state', () => {
    expect(stabilizeStateText('none', null)).toMatch(/passes through unchanged/);
    expect(stabilizeStateText('none', null)).toMatch(/Press Analyse/);
    expect(stabilizeStateText('stale', null, true)).toMatch(/Analyse again/);
    expect(stabilizeStateText('missing', null)).toMatch(/Press Analyse/);
    expect(stabilizeStateText('done', null, true)).toMatch(/no new analysis/);
    expect(stabilizeStateText('none', { state: 'failed', error: 'boom' })).toMatch(/boom/);
  });

  it('reports frames, uncertain frames, repeated stills and the needed zoom', () => {
    expect(stabilizeFacts({})).toBeNull();
    expect(stabilizeFacts({ frames: 120, uncertain: 3, repeated: 0, zoom: 1.12 })).toBe('Analysed 120 frames, 3 uncertain · zoom 1.12x needed to hide the borders');
    expect(stabilizeFacts({ frames: 1, uncertain: 0, repeated: 4 })).toBe('Analysed 1 frame, 0 uncertain · 4 repeated stills skipped');
    expect(stabilizeFacts({ frames: 10, uncertain: 0, zoom: 2.1 }, { edges: 'zoom', maxZoom: 1.5 })).toMatch(/limit 1\.50x/);
    expect(stabilizeFacts({ frames: 10, uncertain: 0, zoom: 2.1 }, { edges: 'mirror', maxZoom: 1.5 })).not.toMatch(/limit/);
  });
});
