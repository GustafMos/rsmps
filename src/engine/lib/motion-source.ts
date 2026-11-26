/**
 * Where a motion node gets its channels from (pure, shared by Phone Motion and AR Camera): the live sensors of a linked phone or of the
 * device the app runs on, through the signal bridge, or a recorded take. Both nodes carry the same hidden params, so one inspector
 * panel and one recording path serve both.
 */
import type { Host } from '../types';
import { isTake, neutralFrame, sampleTake, takeDense, type MotionTake } from './motion-take';

/**
 * The session name of the device the app itself runs on (signal id `phone.this-device`). Pairing tokens of linked phones are random
 * letters and digits without a dash, so the two can never collide.
 */
export const THIS_DEVICE = 'this-device';

export interface MotionSourceParams {
  session: string;
  device: 'linked' | 'this';
  take: unknown;
  source: 'live' | 'recorded';
  smoothing: number;
  takeSmoothing: number;
  keepFast: number;
  loopTake: boolean;
}

/** The session a node reads live: this device, or the linked phone's pairing token ('' = not linked yet). */
export const motionSession = (p: { session?: unknown; device?: unknown }): string => (p.device === 'this' ? THIS_DEVICE : String(p.session ?? ''));

const NEUTRAL = neutralFrame();

/**
 * A function that answers a channel by name (see `MotionFrame`) at `seconds`. Throws a sentence for the user when there is nothing to
 * read: an export or a headless run without a take, or a phone that was never linked. `noSmooth` = channels that must stay raw.
 */
export function motionReader(p: MotionSourceParams, host: Host, seconds: number, title: string, noSmooth: ReadonlySet<string>): (name: string) => number {
  const take: MotionTake | null = isTake(p.take) ? p.take : null;
  const fromTake = (): ((name: string) => number) => {
    const d = takeDense(take!, { amount: p.takeSmoothing, keepFast: p.keepFast });
    const fr = sampleTake(d, seconds, p.loopTake || take!.loop);
    return (n) => fr[n] ?? 0;
  };
  if (take && p.source === 'recorded') return fromTake();

  const id = `phone.${motionSession(p)}`;
  const exporting = !!host.signal && host.signal(id, 'export', seconds) === 1;
  if (exporting || !host.signal) {
    if (take) return fromTake(); // a take exists: use it where live input cannot exist
    throw new Error(`${title} is live only. Exports and headless runs have no phone: record a take (Record in the inspector) and set Source to Recorded.`);
  }
  if (p.device !== 'this' && !p.session) {
    if (take) return fromTake();
    throw new Error('Not linked to a phone yet. Use "Link a phone" in the inspector, scan the QR code and press Start motion on the phone. On a phone or tablet, set "Sensors from" to This device instead.');
  }
  // nothing arriving (the phone has not pressed Start motion, its page is hidden, or this device has no sensors): neutral values, not an error
  if (host.signal(id, 'live', seconds) !== 1) return (n) => NEUTRAL[n] ?? 0;
  const sig = host.signal;
  return (n) => sig.call(host, id, p.smoothing > 0 && !noSmooth.has(n) ? `${n}@${p.smoothing}` : n, seconds);
}

/** The two places live motion can come from (the options of every motion node's "Sensors from"). */
export const SENSORS_FROM_OPTIONS = [
  { value: 'linked', label: 'Linked phone' },
  { value: 'this', label: 'This device' },
] as const;
