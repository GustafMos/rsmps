/** Plain-words messages for the phone link (shared by the phone page and the desktop). */

/** WebSocket close codes the dev server uses (see vite-plugins/phone-session.ts). */
export const CLOSE = { badToken: 4400, unknown: 4404, expired: 4408, busy: 4409, exists: 4410, ended: 4000 } as const;

export function closeMessage(code: number): { text: string; final: boolean } | null {
  switch (code) {
    case CLOSE.unknown:
      return { text: 'This code is not known to the computer. Scan the QR code currently shown in the app again.', final: true };
    case CLOSE.badToken:
      return { text: 'This link is not a valid code. Scan the QR code shown in the app.', final: true };
    case CLOSE.expired:
      return { text: 'This code expired. Make a new QR code in the app and scan it.', final: true };
    case CLOSE.busy:
      return { text: 'Another phone is already connected with this code. Disconnect it in the app or make a new QR code.', final: true };
    case CLOSE.exists:
      return { text: 'This code is already in use on the computer. Make a new QR code.', final: true };
    case CLOSE.ended:
      return { text: 'The computer closed this session (the app tab was closed or Disconnect was pressed). Make a new QR code.', final: true };
    default:
      return null;
  }
}

/** Shown on the computer when no phone has reached it after a while. */
export const UNREACHED_HINT =
  'No phone has reached this computer yet. Check: (1) Windows Security > Firewall & network protection > Allow an app through firewall > Node.js JavaScript Runtime > Private ticked. (2) The Wi-Fi network profile is "Private". (3) Guest Wi-Fi and "AP isolation" block phone-to-computer traffic: use the normal network or the Tailscale address. (4) Pick another address in the list: the first one may be a virtual adapter.';

export function countdown(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return '';
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
