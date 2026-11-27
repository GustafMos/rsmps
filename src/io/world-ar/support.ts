/**
 * Can this browser do World AR, and what to tell the user when it cannot or when starting fails (pure; the browser is passed in).
 *
 * What is knowable and what is not:
 *  - Before the button: whether the page is secure, whether the browser has WebXR at all, and its own answer to "is an AR session
 *    supported". Asking that needs no permission and shows nothing.
 *  - After the button: Chrome rejects the request with the same NotSupportedError whether the user refused the camera, declined to
 *    install or update "Google Play Services for AR", or the device cannot do it after all (Chromium's xr_system.cc turns every
 *    failed session into "The specified session configuration is not supported"). So that one message lists all three; pretending
 *    to know which it was would send the user the wrong way.
 */
import type { XrSystemLike } from './xr-api';

export type WorldArSupportState = 'checking' | 'ok' | 'insecure' | 'no-webxr' | 'unsupported' | 'no-gl';

export interface WorldArSupport {
  state: WorldArSupportState;
  /** One or two plain sentences for the panel. */
  message: string;
}

export interface SupportEnv {
  secure: boolean;
  xr: XrSystemLike | null;
  /** The browser's user agent string, only used to word the "not supported" sentence. */
  userAgent: string;
  /** XRWebGLLayer exists (the session draws through it). */
  hasLayer: boolean;
}

export function browserSupportEnv(): SupportEnv {
  const w = typeof window === 'undefined' ? null : (window as unknown as { XRWebGLLayer?: unknown; isSecureContext?: boolean });
  const nav = typeof navigator === 'undefined' ? null : (navigator as unknown as { xr?: XrSystemLike; userAgent?: string });
  return { secure: !!w?.isSecureContext, xr: nav?.xr ?? null, userAgent: nav?.userAgent ?? '', hasLayer: !!w?.XRWebGLLayer };
}

const NEEDS = 'World AR needs an Android phone or tablet with Chrome and Google Play Services for AR (ARCore).';

/** Why a device is left out, in words that fit the device. */
export function unsupportedMessage(userAgent: string): string {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))) return `Browsers on iPhone and iPad do not offer this kind of AR to web pages. ${NEEDS} The AR Camera node (turning only) works here.`;
  if (/Android/i.test(userAgent)) return `This browser or device cannot start an AR session. ${NEEDS} Use Chrome, and check in the Play Store that "Google Play Services for AR" can be installed on this device.`;
  return `Computers have no AR camera. ${NEEDS} Open this project on the phone to use it; a recorded take plays back here.`;
}

/** Ask the browser. Never throws, asks for no permission, shows nothing. */
export async function checkWorldAr(env: SupportEnv): Promise<WorldArSupport> {
  if (!env.secure) return { state: 'insecure', message: 'AR only works on a secure page (https). Open the app through its https address.' };
  if (!env.xr) return { state: 'no-webxr', message: unsupportedMessage(env.userAgent) };
  let ok = false;
  try {
    ok = await env.xr.isSessionSupported('immersive-ar');
  } catch {
    ok = false; // a browser setting or a permissions policy blocks the question itself
  }
  if (!ok) return { state: 'unsupported', message: unsupportedMessage(env.userAgent) };
  if (!env.hasLayer) return { state: 'no-gl', message: 'This browser can track the room but cannot draw into the AR view (no XRWebGLLayer).' };
  return { state: 'ok', message: 'This device can do World AR. Nothing is asked for until you press the button; the camera picture stays on this device.' };
}

/** The sentence for a failed start. `err` is whatever `requestSession` (or the setup after it) threw. */
export function startErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : typeof err === 'string' ? err : '';
  if (name === 'NotSupportedError')
    return 'The AR view did not start. Usually one of three things: the camera permission was refused (allow the camera for this site in Chrome\'s site settings), "Google Play Services for AR" is missing or out of date and its installation was declined (install or update it from the Play Store), or this device cannot do AR.';
  if (name === 'SecurityError') return /user activation|gesture/i.test(text) ? 'The AR view must be opened by pressing the button. Press it again.' : 'This page is not allowed to use AR here (blocked by the browser or by the site embedding it).';
  if (name === 'InvalidStateError') return 'An AR view is already open, or the page is not in front. Close the other one and press the button again.';
  if (name === 'NotAllowedError') return 'AR was not allowed. Allow the camera for this site in the browser\'s site settings and press the button again.';
  return `The AR view did not start: ${text || 'unknown reason'}`;
}

/**
 * Why the 3D Scan panel cannot start a scan, or null when it can: the same wording as World AR (the scan view is the same AR
 * session). `ok` says nothing about the camera picture: whether the phone hands it over is only known once the session is open, and
 * `noCameraPictureMessage` is then what the view says.
 */
export function scanBlockedReason(s: WorldArSupport): string | null {
  return s.state === 'ok' ? null : s.message;
}

export const noCameraPictureMessage = 'This phone does not hand the camera picture to the page in AR, so a scan cannot take photos here. A scan needs the AR camera picture (the "camera-access" feature of Chrome on Android).';

/** What the scan view's readout says about depth sensing, so the owner can report it. */
export const depthReadout = (granted: boolean): string => (granted ? 'depth: yes' : 'depth: no');

/** What the AR view says about light estimation: "yes" once the phone has given an estimate, "no" when it was refused or has none. */
export const lightReadout = (have: boolean): string => (have ? 'light: yes' : 'light: no');
