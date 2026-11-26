/**
 * "Scan with a linked phone" on the 3D Scan node: find or make a phone link in scan3d mode, and put what the phone sends into the project.
 *
 * What goes where, and why it is done this way:
 *  - While the phone walks, photos only collect in memory (phone-scan3d.ts). Nothing touches the project yet, so there is nothing to undo
 *    and nothing half-written if the link drops.
 *  - When the scan is complete (the phone pressed Done and every photo is here), or the person chooses to keep what arrived, or a dropped link
 *    stays down for `graceMs`, the photos are added to Media in one go and the node's `scan` param is set inside one undo hold. So the
 *    finished scan is ONE undo step, and a dropped link still leaves a usable scan with the number of photos that arrived.
 *  - The scan written is exactly what a local scan gives: the phone's own header (target, grid, number left out for blur) and its shots,
 *    with the Media ids of the photos. "Save scan for a computer" and Splat from Video work on it unchanged.
 */
import { qualitySummary } from '../../engine/lib/scan-coverage';
import type { ScanData } from '../../engine/lib/scan-data';
import type { Io, PhoneSessionInfo } from '../../io/api';
import type { Scan3dInfo } from '../../io/phone-scan3d';
import type { AppCtx } from './context';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

export const LINK_GRACE_MS = 30_000;

/** Why the phone link cannot be used here, in plain words (null = it can). */
export function phoneLinkBlockedReason(io: Pick<Io, 'phone'>): string | null {
  return io.phone.available && io.phone.scan3d ? null : 'The phone link needs the desktop app, or the web version started with npm run dev:lan. On the phone itself, Start scan works without any link.';
}

export interface LinkedPhone {
  token: string;
  /** An already linked phone was switched to 3D scan mode (so there is no QR code to show). */
  reused: boolean;
  /** The new link (QR code, address) when one was made. */
  session?: PhoneSessionInfo;
}

/**
 * Use a phone that is already linked (the paper Scan tab does the same: it is switched to the new mode and no second QR code is needed),
 * otherwise make a link whose address opens the phone page in 3D scan mode.
 */
export async function linkPhoneForScan3d(io: Pick<Io, 'phone'>, address?: string): Promise<LinkedPhone> {
  const linked = io.phone.linked?.() ?? null;
  if (linked && io.phone.setMode) {
    io.phone.scan3d?.session(linked).reset(); // a fresh scan: nothing of an earlier one is shown
    io.phone.setMode(linked, 'scan3d');
    return { token: linked, reused: true };
  }
  const started = await io.phone.startServer?.();
  if (started && !started.ok) throw new Error(started.declined ? 'Phone connections were not allowed, so a phone cannot link. Allow them to continue.' : started.error || 'The phone link could not start.');
  const s = await io.phone.createSession({ ...(address ? { address } : {}), mode: 'scan3d' });
  return { token: s.token, reused: false, session: s };
}

export type LinkedScanEnd = 'done' | 'kept' | 'lost';

export interface LinkedScanOutcome {
  how: LinkedScanEnd;
  scan: ScanData | null;
  /** Photos written to Media and the node, and photos the phone had taken (when it said). */
  photos: number;
  phoneKept: number;
  /** Photos the phone announced that never arrived. */
  missing: number;
  /** Coverage 0..1 worked out here from the received shots (the phone's own number is shown live). */
  coverage: number | null;
  message: string;
  kind: 'ok' | 'info' | 'error';
}

/** The sentence for the toast after a linked scan was written. Pure. */
export function linkedScanMessage(o: Pick<LinkedScanOutcome, 'how' | 'photos' | 'phoneKept' | 'missing'>, coverage: number | null, verdict: string): string {
  const n = o.photos;
  const photos = `${n} photo${n === 1 ? '' : 's'}`;
  const cov = coverage === null ? '' : `, coverage ${Math.round(coverage * 100)}%`;
  if (o.how === 'done' && !o.missing) return `Scan saved from the phone: ${photos}${cov}. ${verdict}. Undo takes it out of the node again.`;
  const of = o.phoneKept > n ? ` of the ${o.phoneKept} the phone took` : '';
  const why = o.how === 'lost' ? 'The link to the phone was lost' : o.how === 'kept' ? 'Stopped before the phone finished' : 'Not every photo arrived';
  return `${why}. Kept the ${photos} that arrived${of}${cov}. ${verdict}. Undo takes it out of the node again.`;
}

export interface RunOptions {
  graceMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
}

/**
 * One linked scan of one node. Watches the phone's session and writes the result into the project once, whichever way the scan ends.
 * The panel creates it, reads `info()` for what to show, and disposes it.
 */
export class LinkedScanRun {
  outcome: LinkedScanOutcome | null = null;
  private off: (() => void) | null = null;
  private timer: unknown = null;
  private writing: Promise<LinkedScanOutcome | null> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private app: Ctx,
    readonly nodeId: string,
    readonly token: string,
    private o: RunOptions = {},
  ) {}

  info(): Scan3dInfo | null {
    return this.app.io.phone.scan3d?.info(this.token) ?? null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** Start watching. */
  start(): void {
    this.off?.();
    this.off = this.app.io.phone.scan3d?.subscribe(this.token, () => this.check()) ?? null;
    this.check();
  }

  private check(): void {
    const i = this.info();
    if (i && !this.outcome) {
      if (i.phase === 'complete') void this.finalize('done');
      else if (i.linkLost && i.received > 0) this.armGrace();
      else this.disarmGrace();
    }
    this.emit();
  }

  private armGrace(): void {
    if (this.timer !== null) return;
    this.timer = (this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = null;
      const i = this.info();
      if (!this.outcome && i?.linkLost) void this.finalize('lost');
    }, this.o.graceMs ?? LINK_GRACE_MS);
  }

  private disarmGrace(): void {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** The Stop button: ask the phone to finish (it sends what is left, then the scan completes by itself). */
  stop(): void {
    this.app.io.phone.scan3d?.session(this.token).requestStop();
  }

  /** "Keep what arrived": write the photos received so far, now. */
  keepWhatArrived(): Promise<LinkedScanOutcome | null> {
    return this.finalize('kept');
  }

  /** Write the received scan into Media and the node (one undo step). Runs once; later calls return the same outcome. */
  finalize(how: LinkedScanEnd): Promise<LinkedScanOutcome | null> {
    if (this.outcome) return Promise.resolve(this.outcome);
    return (this.writing ??= this.write(how).finally(() => {
      this.writing = null;
    }));
  }

  private async write(how: LinkedScanEnd): Promise<LinkedScanOutcome | null> {
    const { io, ed } = this.app;
    const session = io.phone.scan3d?.session(this.token);
    const r = session?.result();
    const info = session?.info ?? null;
    this.disarmGrace();
    if (!session || !r) {
      const text = info && info.received > 0 ? 'Photos arrived, but not where the dome stood, so they cannot be placed. Scan again.' : 'No photos arrived from the phone, so nothing was saved.';
      ed.toast(text, 'error');
      return null;
    }
    try {
      const files = r.shots.map((s, i) => new File([s.bytes as BlobPart], `Scan photo ${String(i + 1).padStart(3, '0')}.jpg`, { type: 'image/jpeg' }));
      const assets = await io.library.add(files);
      const shots = r.shots.flatMap((s, i) => (assets[i] ? [{ ...s.shot, asset: assets[i].id }] : []));
      if (!shots.length) throw new Error('none of the photos could be added to Media');
      const scan: ScanData = { v: 1, units: 'm', target: r.header.target, grid: r.header.grid, shots, ...(r.header.rejected ? { rejected: r.header.rejected } : {}) };
      ed.beginHold(); // the scan param: one undo step for the whole scan
      ed.setParam(this.nodeId, 'scan', scan);
      ed.endHold();
      const q = qualitySummary(scan, r.header.rejected ?? 0);
      const missing = r.missing + (r.complete ? 0 : Math.max(0, (info?.kept ?? 0) - r.shots.length));
      const partial: Pick<LinkedScanOutcome, 'how' | 'photos' | 'phoneKept' | 'missing'> = { how, photos: shots.length, phoneKept: Math.max(info?.kept ?? 0, shots.length), missing: how === 'done' ? r.missing : missing };
      const coverage = session.recomputedCoverage();
      const message = linkedScanMessage(partial, coverage ?? q.coverage, q.verdict.text);
      const kind = how === 'done' && !r.missing ? (q.verdict.level === 'good' ? 'ok' : 'info') : 'info';
      session.release(); // the photos are in Media now; let the memory go
      this.outcome = { ...partial, scan, coverage, message, kind };
      ed.toast(message, kind);
      return this.outcome;
    } catch (err) {
      ed.toast(`The scan from the phone could not be saved: ${err instanceof Error ? err.message : String(err)}. The photos are still held; press Keep what arrived to try again.`, 'error');
      return null;
    } finally {
      this.emit();
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.disarmGrace();
    this.listeners.clear();
  }
}
