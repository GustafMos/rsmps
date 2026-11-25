import { describe, expect, it } from 'vitest';
import { styleAiFacts, styleAiModelState, styleAiStateText } from './StyleAiPanel';

describe('AI Style Transfer panel texts', () => {
  it('says plainly that it has to be rendered, and what is shown meanwhile', () => {
    expect(styleAiStateText('none', null)).toMatch(/Not rendered yet: a plain dissolve.*too slow.*Press Render/);
    expect(styleAiStateText('missing', null)).toMatch(/gone.*plain dissolve.*Press Render/);
    expect(styleAiStateText('stale', null)).toMatch(/Out of date.*old painting is still shown.*Render again/);
  });
  it('held (no transition): what is shown meanwhile is picture A, not a dissolve', () => {
    expect(styleAiStateText('none', null, false, true)).toMatch(/Not rendered yet: picture A is shown as it is.*paint every frame once/);
    expect(styleAiStateText('missing', null, false, true)).toMatch(/gone.*picture A is shown as it is/);
    expect(styleAiStateText('none', { state: 'failed', error: 'no memory' }, false, true)).toBe('Render failed: no memory. Nothing was stored; picture A is shown as it is.');
  });
  it('leaves progress and "done" to the generic sentences', () => {
    expect(styleAiStateText('done', null)).toBeNull();
    expect(styleAiStateText('none', { state: 'running' })).toBeNull();
  });
  it('a failed render says why and what is on screen now', () => {
    expect(styleAiStateText('none', { state: 'failed', error: 'no memory' })).toBe('Render failed: no memory. Nothing was stored; a plain dissolve from A to B is shown.');
    expect(styleAiStateText('stale', { state: 'failed', error: 'no memory' }, true)).toBe('Render failed: no memory. Nothing was stored; the last painting is still shown.');
  });
  it('sums up the last render', () => {
    // a result from before the node had looks says nothing about the method: it was AdaIN
    expect(styleAiFacts({ count: 48, tiles: 2, provider: 'webgpu', secondsPerFrame: 0.42, item: null })).toBe('48 painted frames · AdaIN · 2 squares per frame · on the GPU · 0.4 s per frame');
    expect(styleAiFacts({ count: 1, tiles: 1, provider: 'wasm', secondsPerFrame: 14.6, item: 1, method: 'adain', passes: 1 })).toBe('1 painted frame · AdaIN · on the processor · 15 s per frame · batch item 2 only');
    expect(styleAiFacts({ count: 24, tiles: 1, provider: 'wasm', secondsPerFrame: 9.2, item: null, method: 'swap', material: 1, passes: 2, crawl: 0.6, source: 'style', drive: 'span' })).toBe('24 painted frames · style swap · 2 passes · crawling · material from Style · on the processor · 9.2 s per frame');
    expect(styleAiFacts({ count: 24, tiles: 1, provider: 'webgpu', secondsPerFrame: 0.3, item: null, method: 'swap', material: 0.5, passes: 1, crawl: 0, source: 'hold', drive: 'hold' })).toBe('24 painted frames · style swap 50% over AdaIN · held · on the GPU · 0.3 s per frame');
    expect(styleAiFacts({})).toBeNull();
  });
  it('the two files count as one download', () => {
    const sizes = [14, 16];
    expect(styleAiModelState([{ state: 'ready', bytes: 14 }, { state: 'ready', bytes: 16 }], sizes)).toMatchObject({ state: 'ready', received: 30, total: 30 });
    expect(styleAiModelState([{ state: 'absent' }, { state: 'absent' }], sizes)).toMatchObject({ state: 'absent', received: 0 });
    expect(styleAiModelState([{ state: 'ready', bytes: 14 }, { state: 'downloading', received: 4, total: 16, phase: 'downloading' }], sizes)).toMatchObject({ state: 'downloading', received: 18, total: 30 });
    // one file here and one failed is not "ready": the node cannot run on half a model
    expect(styleAiModelState([{ state: 'ready', bytes: 14 }, { state: 'failed', error: 'checksum' }], sizes)).toMatchObject({ state: 'failed', error: 'checksum' });
    expect(styleAiModelState([{ state: 'ready', bytes: 14 }, { state: 'absent' }], sizes).state).toBe('absent');
  });
});
