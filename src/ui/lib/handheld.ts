/** What `isHandheld` reads of the browser (so it can be tested without one). */
export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { mobile?: boolean };
  maxTouchPoints?: number;
  platform?: string;
}

/**
 * True on a phone or tablet: a device that IS the camera (front and back), as opposed to a computer with a webcam.
 * Used to pick sensible camera defaults; never to hide anything.
 */
export function isHandheld(nav: NavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : undefined): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS reports itself as a Mac, but a Mac has no touch screen
  return /Mac/i.test(nav.platform ?? '') && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Starting settings of a motion node (Phone Motion, AR Camera) added on this device: on a phone or tablet the sensors are the
 * device's own, as its camera is. On a computer the node keeps its default, a phone linked by QR code.
 */
export function motionNodeParams(type: string, handheld: boolean, params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!handheld || (type !== 'phone-motion' && type !== 'ar-camera')) return params;
  return { device: 'this', ...params };
}

/**
 * The node to add, and its starting settings, when `type` is asked for on this device.
 *  - Webcam on a phone: starts on the back camera, not mirrored (a phone's default camera is the selfie one).
 *  - Phone Camera on a phone, where the phone link is not available (the website): that node streams a SECOND phone to a
 *    computer. On the phone itself the Webcam node opens its own camera, so that is what is added.
 */
export function cameraNodeFor(type: string, handheld: boolean, phoneLinkAvailable: boolean, params?: Record<string, unknown>): { type: string; params?: Record<string, unknown>; swapped: boolean } {
  if (!handheld) return { type, params, swapped: false };
  const own = { facing: 'back', mirror: false };
  if (type === 'camera-in') return { type, params: { ...own, ...params }, swapped: false };
  if (type === 'phone-camera' && !phoneLinkAvailable) return { type: 'camera-in', params: own, swapped: true };
  return { type, params, swapped: false };
}
