import { describe, expect, it } from 'vitest';
import { BROWSER_NOTES, detectBrowser, failureFromMessage, guidance, ownNote, probeWebGpu } from './webgpuGuidance';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  ipadOs: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
};

describe('probeWebGpu', () => {
  it('says "insecure" when the API is hidden on a non-secure page', async () => {
    expect(await probeWebGpu({ gpu: undefined, isSecureContext: false })).toEqual({ ok: false, failure: 'insecure-context' });
  });
  it('says "missing" when the API is absent on a secure page', async () => {
    expect(await probeWebGpu({ gpu: null, isSecureContext: true })).toEqual({ ok: false, failure: 'api-missing' });
  });
  it('tells "adapter is null" (blocked / unsupported GPU) from "the API is missing"', async () => {
    expect(await probeWebGpu({ gpu: { requestAdapter: async () => null }, isSecureContext: true })).toEqual({ ok: false, failure: 'no-adapter' });
  });
  it('reports a throwing requestAdapter and a failing requestDevice separately', async () => {
    expect(await probeWebGpu({ gpu: { requestAdapter: async () => { throw new Error('boom'); } } })).toEqual({ ok: false, failure: 'adapter-error', detail: 'boom' });
    const gpu = { requestAdapter: async () => ({ requestDevice: async () => { throw new Error('lost'); } }) };
    expect(await probeWebGpu({ gpu })).toEqual({ ok: false, failure: 'device-failed', detail: 'lost' });
  });
  it('passes when a device can be made, and releases it', async () => {
    let destroyed = false;
    const gpu = { requestAdapter: async () => ({ requestDevice: async () => ({ destroy: () => { destroyed = true; } }) }) };
    expect(await probeWebGpu({ gpu })).toEqual({ ok: true, failure: null });
    expect(destroyed).toBe(true);
  });
});

describe('detectBrowser', () => {
  it('recognises the common cases', () => {
    expect(detectBrowser(UA.chromeAndroid)).toEqual({ platform: 'android', family: 'chrome' });
    expect(detectBrowser(UA.firefoxAndroid)).toEqual({ platform: 'android', family: 'firefox' });
    expect(detectBrowser(UA.safariIphone)).toEqual({ platform: 'ios', family: 'safari' });
    expect(detectBrowser(UA.chromeIphone)).toEqual({ platform: 'ios', family: 'chrome' });
    expect(detectBrowser(UA.ipadOs, 5, 'MacIntel')).toEqual({ platform: 'ios', family: 'safari' });
    expect(detectBrowser(UA.ipadOs, 0, 'MacIntel')).toEqual({ platform: 'desktop', family: 'safari' });
    expect(detectBrowser(UA.edgeDesktop)).toEqual({ platform: 'desktop', family: 'edge' });
  });
});

describe('guidance', () => {
  const firefoxAndroid = detectBrowser(UA.firefoxAndroid);
  it('says plainly that Firefox on Android will not work, and to use Chrome', () => {
    const g = guidance('api-missing', firefoxAndroid);
    expect(g.verdict).toMatch(/Firefox on Android does not have WebGPU/);
    expect(g.verdict).toMatch(/Chrome on the same phone/);
    expect(g.notes[0].id).toBe('android-firefox');
    expect(g.notes[0].blocked).toBe(true);
  });
  it('puts the visitor\'s own browser note first', () => {
    expect(guidance('no-adapter', detectBrowser(UA.safariIphone)).notes[0].id).toBe('ios');
    expect(guidance('no-adapter', detectBrowser(UA.chromeAndroid)).notes[0].id).toBe('android-chromium');
    expect(guidance('no-adapter', detectBrowser(UA.edgeDesktop)).notes[0].id).toBe('desktop');
    expect(ownNote(firefoxAndroid)).toBe('android-firefox');
  });
  it('explains the "no adapter" case as present-but-blocked, not as missing', () => {
    const g = guidance('no-adapter', detectBrowser(UA.edgeDesktop));
    expect(g.headline).toMatch(/has WebGPU, but no GPU/);
    expect(g.steps.join(' ')).toMatch(/hardware acceleration/);
  });
  it('points an insecure page to https instead of blaming the browser', () => {
    const g = guidance('insecure-context', detectBrowser(UA.chromeAndroid));
    expect(g.headline).toMatch(/secure connection/);
    expect(g.steps.join(' ')).toMatch(/dev:lan/);
  });
  it('states no version number except the 113 the app already named for Chrome and Edge', () => {
    const all = BROWSER_NOTES.map((n) => n.text).join(' ');
    const numbers = all.match(/\d+/g) ?? [];
    expect(numbers).toEqual(['113']);
  });
  it('is honest about what works without WebGPU', () => {
    const g = guidance('api-missing', detectBrowser(UA.edgeDesktop));
    expect(g.without.join(' ')).toMatch(/no fallback/);
    expect(g.without.join(' ')).toMatch(/phone-link page/);
  });
  it('includes the browser\'s own words when it gave any', () => {
    expect(guidance('device-failed', detectBrowser(UA.edgeDesktop), 'out of memory').what).toMatch(/out of memory/);
  });
});

describe('failureFromMessage', () => {
  it('maps the engine\'s error texts', () => {
    expect(failureFromMessage('WebGPU is not available in this browser. Use a current Chrome')).toBe('api-missing');
    expect(failureFromMessage('No WebGPU adapter found.')).toBe('no-adapter');
    expect(failureFromMessage('Failed to create device')).toBe('device-failed');
    expect(failureFromMessage('something else')).toBe('unknown');
  });
});
