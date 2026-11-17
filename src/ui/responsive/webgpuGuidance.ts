/**
 * What to tell someone whose browser cannot give RSMPS a WebGPU device. Pure functions (tested): `probeWebGpu` classifies WHAT failed
 * ("the API is missing" is not "the browser has it but no GPU is available"), `detectBrowser` picks which note to put first (this is
 * guidance copy only: it never decides the layout), `guidance` writes the page. The wording follows the README ("a browser with WebGPU is
 * required; there is no fallback") and states a version number only where the app already did (Chrome or Edge 113 on desktop).
 */
export type WebGpuFailure = 'insecure-context' | 'api-missing' | 'no-adapter' | 'adapter-error' | 'device-failed' | 'unknown';

export interface WebGpuProbe {
  ok: boolean;
  failure: WebGpuFailure | null;
  /** The browser's own words, when it gave any. */
  detail?: string;
}

interface GpuLike {
  requestAdapter(opts?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<{ requestDevice(): Promise<{ destroy?: () => void }> } | null>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Ask the browser the same questions the app does, one at a time, and say which one failed. */
export async function probeWebGpu(env: { gpu?: GpuLike | null; isSecureContext?: boolean }): Promise<WebGpuProbe> {
  if (!env.gpu) return { ok: false, failure: env.isSecureContext === false ? 'insecure-context' : 'api-missing' };
  let adapter: Awaited<ReturnType<GpuLike['requestAdapter']>>;
  try {
    adapter = await env.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e) {
    return { ok: false, failure: 'adapter-error', detail: msg(e) };
  }
  if (!adapter) return { ok: false, failure: 'no-adapter' };
  try {
    const device = await adapter.requestDevice();
    device.destroy?.();
  } catch (e) {
    return { ok: false, failure: 'device-failed', detail: msg(e) };
  }
  return { ok: true, failure: null };
}

/** When boot failed but a probe now passes (or cannot run), fall back to the error text. */
export function failureFromMessage(message: string): WebGpuFailure {
  if (/not available in this browser/i.test(message)) return 'api-missing';
  if (/no webgpu adapter/i.test(message)) return 'no-adapter';
  if (/device/i.test(message)) return 'device-failed';
  return 'unknown';
}

export type Platform = 'android' | 'ios' | 'desktop';
export type Family = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export interface BrowserEnv {
  platform: Platform;
  family: Family;
}

/** From the user-agent string, for the order of the notes only. iPadOS announces itself as a Mac with a touch screen. */
export function detectBrowser(ua: string, maxTouchPoints = 0, platform = ''): BrowserEnv {
  const iPadOs = /Macintosh|MacIntel/.test(`${ua} ${platform}`) && maxTouchPoints > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadOs;
  const android = /Android/i.test(ua);
  const edge = /EdgA|EdgiOS|Edg\//.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const chrome = /Chrome|CriOS/.test(ua);
  const safari = /Safari/.test(ua) || iPadOs;
  const family: Family = edge ? 'edge' : firefox ? 'firefox' : chrome ? 'chrome' : safari ? 'safari' : 'other';
  return { platform: ios ? 'ios' : android ? 'android' : 'desktop', family };
}

export interface BrowserNote {
  id: 'android-chromium' | 'android-firefox' | 'ios' | 'desktop';
  name: string;
  text: string;
  /** True for Firefox on Android: it cannot work, which is said without softening. */
  blocked?: boolean;
}

export const BROWSER_NOTES: readonly BrowserNote[] = [
  {
    id: 'android-chromium',
    name: 'Chrome or Edge on Android',
    text: 'WebGPU is available in recent versions of Chrome and Edge, on devices with a recent Android version and a GPU the browser supports. Update the browser from the Play Store and Android itself from Settings; older phones may not be supported.',
  },
  {
    id: 'android-firefox',
    name: 'Firefox on Android',
    text: 'WebGPU is not enabled in Firefox on Android, and RSMPS will not work there. Open RSMPS in Chrome on the same phone instead.',
    blocked: true,
  },
  {
    id: 'ios',
    name: 'iPhone and iPad (Safari)',
    text: 'WebGPU needs a recent iOS or iPadOS version that includes it: update in Settings, General, Software Update. Other browsers on iPhone and iPad generally use the same web engine as Safari, so switching browser does not help there.',
  },
  {
    id: 'desktop',
    name: 'Computers',
    text: 'Use a current Chrome or Edge (113 or newer), or another browser that ships WebGPU on your system. Recent Firefox and Safari releases have WebGPU on some systems only; check that yours has it. Make sure hardware acceleration is turned on in the browser settings.',
  },
];

/** Which note is "yours". */
export function ownNote(env: BrowserEnv): BrowserNote['id'] {
  if (env.platform === 'android') return env.family === 'firefox' ? 'android-firefox' : 'android-chromium';
  if (env.platform === 'ios') return 'ios';
  return 'desktop';
}

export interface Guidance {
  headline: string;
  /** What is missing, in one or two sentences. */
  what: string;
  /** Why this usually happens. */
  why: string;
  /** Things to try, most useful first. */
  steps: string[];
  /** The notes, yours first. */
  notes: BrowserNote[];
  /** What works without WebGPU (honestly: little). */
  without: string[];
  /** Firefox on Android gets a plain verdict above everything else. */
  verdict?: string;
}

export const README_URL = 'https://github.com/GustafMos/rsmps#quick-start';
export const LIMITATIONS_URL = 'https://github.com/GustafMos/rsmps#known-limitations';

const SECURE_STEP = 'Open the page over https, or from localhost on the same computer. To use your own computer from a phone, start it with npm run dev:lan: it serves https on your network (see "Phone as a camera" in the README).';

export function guidance(failure: WebGpuFailure, env: BrowserEnv, detail?: string): Guidance {
  const own = ownNote(env);
  const notes = [...BROWSER_NOTES].sort((a, b) => Number(b.id === own) - Number(a.id === own));
  const mobile = env.platform !== 'desktop';
  const base: Pick<Guidance, 'notes' | 'without'> = {
    notes,
    without: [
      'RSMPS itself cannot run without WebGPU. There is no fallback, so nothing is rendered or edited in this browser.',
      'Your projects stay saved in this browser and open as soon as WebGPU is available.',
      'The phone-link page (the camera page that opens from the QR code of a running RSMPS) is separate and does not need WebGPU.',
    ],
  };
  const verdict = own === 'android-firefox' ? 'Firefox on Android does not have WebGPU, so RSMPS cannot work in it. Open this page in Chrome on the same phone.' : undefined;

  switch (failure) {
    case 'insecure-context':
      return {
        ...base,
        verdict,
        headline: 'This page is not on a secure connection',
        what: 'Browsers only offer WebGPU to pages served over https (or from localhost). This page came over plain http, so the browser hides WebGPU from it.',
        why: 'This is the usual cause when a phone opens an address like http://192.168.x.x. It is not a problem with your phone or its GPU.',
        steps: [SECURE_STEP],
      };
    case 'api-missing':
      return {
        ...base,
        verdict,
        headline: 'This browser does not offer WebGPU',
        what: 'The browser has no WebGPU interface at all (navigator.gpu is missing), so RSMPS cannot reach the GPU.',
        why: mobile ? 'Either the browser or the system version is too old, or the browser does not ship WebGPU yet.' : 'Either the browser is too old, or it does not ship WebGPU on this system.',
        steps: own === 'android-firefox' ? ['Open this page in Chrome on the same phone.'] : ['Update the browser, and on a phone the system too.', 'Then use "Check again" below.'],
      };
    case 'no-adapter':
      return {
        ...base,
        verdict,
        headline: 'The browser has WebGPU, but no GPU is available for it',
        what: 'The browser answered the request for a graphics adapter with "none". WebGPU exists here, but the browser has blocked or cannot use this GPU.',
        why: mobile
          ? 'Some phone GPUs and Android versions are not supported by the browser yet, or the browser has put the GPU driver on its blocklist.'
          : 'Usual causes: hardware acceleration is switched off, the graphics driver is old or on the browser\'s blocklist, or the GPU is not supported.',
        steps: mobile
          ? ['Update the browser and the system, then use "Check again".', 'Try Chrome if you are using another browser.']
          : ['Turn on hardware acceleration in the browser settings (Chrome and Edge: Settings, System), then restart the browser.', 'Update your graphics driver.', 'In Chrome or Edge, open chrome://gpu or edge://gpu and look at the WebGPU line to see what the browser decided.'],
      };
    case 'adapter-error':
      return {
        ...base,
        verdict,
        headline: 'The browser failed when asked for the GPU',
        what: `WebGPU is present, but asking for the graphics adapter raised an error${detail ? `: ${detail}` : '.'}`,
        why: 'This points to a driver or browser problem rather than missing support.',
        steps: ['Restart the browser and use "Check again".', 'Update the browser and the graphics driver.'],
      };
    case 'device-failed':
      return {
        ...base,
        verdict,
        headline: 'The GPU was found but could not be started',
        what: `The browser found a graphics adapter, but starting a WebGPU device on it failed${detail ? `: ${detail}` : '.'}`,
        why: 'The GPU may be busy or out of memory, or the driver lost it.',
        steps: ['Close other heavy tabs and apps, then use "Check again".', 'If it keeps happening, restart the browser and update the graphics driver.'],
      };
    default:
      return {
        ...base,
        verdict,
        headline: 'RSMPS could not get a WebGPU device',
        what: detail ? `The browser said: ${detail}` : 'The browser could not provide a WebGPU device.',
        why: 'RSMPS needs WebGPU, and this browser could not provide it.',
        steps: ['Update the browser, make sure hardware acceleration is on, then use "Check again".'],
      };
  }
}
