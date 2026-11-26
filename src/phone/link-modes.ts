/**
 * What the phone page is doing for the computer, and how both sides agree on it.
 *
 *  - The pairing link may carry `&mode=scan|camera|controller` (the token and everything else about the link is unchanged). No parameter
 *    means `camera`, exactly as before.
 *  - Once the WebSocket is open the phone says `hello {mode, media}`: its mode and whether a camera picture is going to flow
 *    (`video`), the user chose not to send one (`none`) or the camera was refused (`refused`). The computer shows the phone as linked from
 *    that typed message, so a phone without a camera picture (controller only, scan mode, camera refused) still completes the link.
 *  - The computer can change the mode of a phone that is already linked with `mode {mode}` (the phone answers with a new hello).
 */

export type PhoneMode = 'camera' | 'scan' | 'controller' | 'scan3d';
export const PHONE_MODES: readonly PhoneMode[] = ['camera', 'scan', 'controller', 'scan3d'];
export type PhoneMedia = 'video' | 'none' | 'refused';

export const LINK_TYPES = new Set(['hello', 'mode']);

export function parseMode(value: unknown): PhoneMode {
  return typeof value === 'string' && (PHONE_MODES as readonly string[]).includes(value) ? (value as PhoneMode) : 'camera';
}

/** The mode asked for by the page's query string (`?token=…&mode=scan`). */
export function modeFromSearch(search: string): PhoneMode {
  try {
    return parseMode(new URLSearchParams(search).get('mode'));
  } catch {
    return 'camera';
  }
}

export interface HelloMsg {
  type: 'hello';
  v: number;
  mode: PhoneMode;
  media: PhoneMedia;
}
export interface ModeMsg {
  type: 'mode';
  mode: PhoneMode;
}

export function parseHello(raw: unknown): HelloMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'hello') return null;
  if (typeof m.mode !== 'string' || !(PHONE_MODES as readonly string[]).includes(m.mode)) return null;
  const media: PhoneMedia = m.media === 'video' || m.media === 'refused' ? m.media : 'none';
  return { type: 'hello', v: typeof m.v === 'number' ? m.v : 1, mode: m.mode as PhoneMode, media };
}

export function parseModeMsg(raw: unknown): ModeMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  return m.type === 'mode' && typeof m.mode === 'string' && (PHONE_MODES as readonly string[]).includes(m.mode) ? { type: 'mode', mode: m.mode as PhoneMode } : null;
}

/** Does this phone send a camera picture? Only camera mode with a working camera does; everything else is "linked" by the handshake alone. */
export function sendsVideo(h: Pick<HelloMsg, 'mode' | 'media'>): boolean {
  return h.mode === 'camera' && h.media === 'video';
}

/** What the third pairing step is called for this link. */
export function thirdStepLabel(mode: PhoneMode, media: PhoneMedia | null): string {
  if (media === 'video' || (media === null && mode === 'camera')) return 'Video connected';
  if (mode === 'scan') return 'Scan mode ready';
  if (mode === 'controller') return 'Controller linked';
  if (mode === 'scan3d') return '3D scan ready';
  return 'Phone linked (no picture)';
}
