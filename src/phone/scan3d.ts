/**
 * The phone page's 3D SCAN MODE (experimental): the same scan as the 3D Scan node's "Start scan" (tap the surface, fit the dome, Start,
 * automatic photos, coverage, map, advice, shutter, Done), but the photos, camera positions and coverage go to the computer over the phone
 * link instead of staying on the phone.
 *
 * Nothing about the scan is reimplemented here: the AR session, the loop, the painter, the scan session (rules for when a photo is taken,
 * blur check, coverage) and the overlay are the ones of the full app's scan view (src/io/world-ar/scan-rig.ts, scan-session.ts, loop.ts,
 * painter.ts, src/ui/worldAr/overlay.ts). This file adds three things: the Start button (a browser only starts AR from a press), the
 * hand-over of every kept photo to the uploader (scan3d-sender.ts) with back-pressure, and the small live status for the computer's panel.
 *
 * The phone never renders the node graph, so none of the engine is loaded (that is why the scan view comes from scan-rig.ts and not
 * from the World AR controller).
 */
import type { WorldArSupport } from '../io/world-ar/support';
import { ScanRig, browserScanRigEnv, type ScanRigHandle, type ScanRigResult } from '../io/world-ar/scan-rig';
import { makeBrowserXrPainter } from '../io/world-ar/painter';
import type { WorldArViewState } from '../io/world-ar/controller';
import type { ScanShot } from '../engine/lib/scan-data';
import { createArOverlay, type ArOverlay } from '../ui/worldAr/overlay';
import { SCAN3D_LIMITS, SCAN3D_MAX_HELD, newSid, type Scan3dStatusMsg } from './scan3d-protocol';
import { Scan3dUploader } from './scan3d-sender';

/** What the page shows around the AR view (a Start button and a few plain lines). A fake in tests. */
export interface Scan3dUi {
  show(on: boolean): void;
  /** Lines of plain text under the title. */
  lines(lines: string[]): void;
  /** The Start button: its label, whether it can be pressed, and what happens when it is. */
  start(label: string, enabled: boolean, onPress: (() => void) | null): void;
  /** A problem, in words (shown apart from the lines), or ''. */
  problem(text: string): void;
}

export interface Scan3dModeEnv {
  send(msg: Record<string, unknown>): void;
  sendBinary(d: Uint8Array): void;
  buffered(): number;
  isOpen(): boolean;
  /** The AR scan view. Default: the browser's. */
  rig?: ScanRig;
  /** The overlay shown over the camera picture. Default: the app's scan overlay (a DOM element). Null = none (tests). */
  overlay?: () => ArOverlay | null;
  ui?: Scan3dUi;
  now?: () => number;
  /** Repeating timer for the uploader and the status. Default: setInterval. Returns a stop function. */
  every?: (fn: () => void, ms: number) => () => void;
}

export interface Scan3dMode {
  /** The page switched to this mode: check what the phone can do and show the Start button. */
  enter(): Promise<void>;
  /** The page left this mode (another mode was chosen): close everything. */
  leave(): void;
  /** The WebSocket opened (again): send what the computer needs and continue sending photos. */
  onOpen(): void;
  onClose(): void;
  /** A message from the computer. True = it was one of ours. */
  onMessage(msg: { type?: string }): boolean;
  /** Run one step of the timers by hand (tests). */
  tick(): void;
  /** For tests and the page's status line. */
  readonly uploader: Scan3dUploader | null;
}

const STATUS_MS = 250;

/** The words for each reason AR cannot start, plus what to do about the https certificate (the phone page is https). */
export function supportLines(s: WorldArSupport): string[] {
  if (s.state === 'ok') return ['This phone can do an AR scan. Press the button, then follow the advice on the screen.'];
  const out = [s.message];
  if (s.state === 'insecure') out.push('AR only runs on a secure page. Open the link from the QR code (it starts with https) and accept the certificate warning once: Advanced, then Proceed.');
  if (s.state === 'no-webxr') out.push('The page was reached over https, but this browser has no WebXR (navigator.xr is missing). Use Chrome on an Android phone.');
  return out;
}

function domUi(): Scan3dUi {
  let root: HTMLElement | null = null;
  let title: HTMLElement;
  let text: HTMLElement;
  let warn: HTMLElement;
  let btn: HTMLButtonElement;
  let press: (() => void) | null = null;
  const build = () => {
    if (root) return root;
    root = document.createElement('section');
    root.id = 'scan3d';
    root.style.cssText = 'margin:12px 16px;padding:12px;border:1px solid #334155;border-radius:12px;background:#0f172a;color:#e2e8f0;font:15px/1.5 system-ui,sans-serif;';
    title = document.createElement('h2');
    title.textContent = '3D scan (experimental)';
    title.style.cssText = 'margin:0 0 6px;font-size:17px;';
    text = document.createElement('div');
    warn = document.createElement('div');
    warn.style.cssText = 'color:#fca5a5;margin-top:6px;';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'margin-top:10px;width:100%;font-size:18px;padding:14px;border-radius:10px;border:0;background:#2563eb;color:#fff;';
    btn.addEventListener('click', () => press?.());
    root.append(title, text, btn, warn);
    document.body.appendChild(root);
    return root;
  };
  return {
    show(on) {
      build().hidden = !on;
    },
    lines(lines) {
      build();
      text.textContent = '';
      for (const l of lines) {
        const p = document.createElement('p');
        p.textContent = l;
        p.style.margin = '0 0 4px';
        text.appendChild(p);
      }
    },
    start(label, enabled, onPress) {
      build();
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.5';
      btn.hidden = !onPress;
      press = onPress;
    },
    problem(t) {
      build();
      warn.textContent = t;
    },
  };
}

export function createScan3dMode(env: Scan3dModeEnv): Scan3dMode {
  const rig = env.rig ?? new ScanRig(browserScanRigEnv(makeBrowserXrPainter));
  const ui = env.ui ?? domUi();
  const now = env.now ?? (() => performance.now());
  const every = env.every ?? ((fn, ms) => {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  });
  const makeOverlay = env.overlay ?? (() => createArOverlay(document, { scan: true }));

  let entered = false;
  let support: WorldArSupport | null = null;
  let limits = { chunkBytes: SCAN3D_LIMITS.chunkBytes, window: SCAN3D_LIMITS.window };
  let uploader: Scan3dUploader | null = null;
  let handle: ScanRigHandle | null = null;
  let overlay: ArOverlay | null = null;
  let sid = 0;
  let headerSent = false;
  let converting = 0;
  let chain: Promise<void> = Promise.resolve();
  let lastState: WorldArViewState | null = null;
  let lastStatusAt = -1e9;
  let lastStatusKey = '';
  let stopTimer: (() => void) | null = null;
  let ended: { count: number } | null = null;
  const transport = { sendJson: (m: Record<string, unknown>) => env.send(m), sendBinary: (d: Uint8Array) => env.sendBinary(d), buffered: () => env.buffered(), isOpen: () => env.isOpen() };

  const sendSupport = () => {
    if (support) env.send({ type: 'scan3d-support', state: support.state, message: support.message });
  };

  const refreshPanel = () => {
    if (!entered) return;
    const up = uploader?.state();
    if (ended && up) {
      const n = ended.count;
      const fin = up.finished;
      if (fin) {
        ui.lines([fin.ok ? `Done. ${fin.received} photo${fin.received === 1 ? ' is' : 's are'} on your computer.` : `The computer has ${fin.received} of ${n} photos. ${fin.note ?? ''}`.trim()]);
        ui.start('Scan another object', !!support && support.state === 'ok', begin);
      } else {
        ui.lines([`Sending photos to your computer: ${up.sent} of ${n}.`, env.isOpen() ? 'Keep this page open.' : 'The link to the computer is down. It will continue by itself when the link is back.']);
        ui.start('Sending…', false, null);
      }
      ui.problem(up.note ?? '');
      return;
    }
    if (!support) {
      ui.lines(['Checking whether this phone can do AR…']);
      ui.start('Start 3D scan', false, null);
      return;
    }
    ui.lines(supportLines(support));
    ui.start('Start 3D scan', support.state === 'ok', support.state === 'ok' ? begin : null);
    ui.problem('');
  };

  const status = (st: WorldArViewState, force = false, phase?: Scan3dStatusMsg['phase']) => {
    const sc = st.scan;
    if (!sc || !sid) return;
    const up = uploader?.state();
    const sending = !!up && (up.held > 0 || converting > 0) && sc.phase === 'capture';
    const key = `${sc.phase}|${sc.kept}|${up?.sent ?? 0}|${sc.rejected}|${Math.round(sc.coverage * 1000)}|${sc.guidance}|${sending}`;
    const t = now();
    if (!force && (key === lastStatusKey || t - lastStatusAt < STATUS_MS)) return;
    lastStatusKey = key;
    lastStatusAt = t;
    const msg: Scan3dStatusMsg = {
      type: 'scan3d-status',
      sid,
      phase: phase ?? sc.phase,
      kept: sc.kept,
      sent: up?.sent ?? 0,
      rejected: sc.rejected,
      coverage: sc.coverage,
      grid: sc.grid,
      cells: sc.cells,
      guidance: sc.guidance,
      depth: sc.depth,
      depthShots: sc.depthShots,
      picture: sc.picture,
      sending,
    };
    env.send(msg as unknown as Record<string, unknown>);
  };

  const sendHeader = () => {
    const h = handle?.header();
    if (!h || !sid) return;
    env.send({ type: 'scan3d-header', sid, target: h.target, grid: h.grid });
    headerSent = true;
  };

  const onState = (st: WorldArViewState) => {
    lastState = st;
    const sc = st.scan;
    // the overlay's own line gets the number of photos the computer has confirmed
    if (sc && overlay) overlay.update({ ...st, scan: { ...sc, line: `${sc.line} · ${uploader?.state().sent ?? 0} on the computer` } });
    else overlay?.update(st);
    if (sc?.phase === 'capture' && !headerSent) sendHeader();
    status(st);
  };

  const onKeep = (shot: ScanShot, blob: Blob, index: number) => {
    const { asset: _asset, ...record } = shot;
    converting++;
    chain = chain
      .then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        uploader?.enqueue(index, record, bytes, now());
      })
      .catch(() => undefined)
      .finally(() => {
        converting--;
      });
  };

  /** Back-pressure: photos being encoded, being read and waiting to be sent never exceed SCAN3D_MAX_HELD. */
  const hold = (encoding: number) => (uploader?.held() ?? 0) + converting + encoding >= SCAN3D_MAX_HELD;

  const onEnd = (r: ScanRigResult) => {
    overlay?.remove();
    overlay = null;
    handle = null;
    const header = r.scan ? { v: 1 as const, units: 'm' as const, target: r.scan.target, grid: r.scan.grid, ...(r.rejected ? { rejected: r.rejected } : {}) } : null;
    const count = r.scan?.shots.length ?? 0;
    void chain.then(() => {
      ended = { count };
      if (lastState?.scan) status(lastState, true, 'done');
      if (header && uploader) uploader.finish(header, count, r.scan!.shots.filter((s) => s.depth).length, now());
      else {
        ui.lines([r.error ?? 'No photos were taken, so nothing was sent.']);
        ui.start('Start 3D scan', !!support && support.state === 'ok', begin);
        return;
      }
      refreshPanel();
    });
    if (r.error) ui.problem(r.error);
  };

  /** Called from the button press: a browser only starts AR from a press. */
  function begin(): void {
    if (handle) return;
    uploader?.cancel();
    sid = newSid();
    uploader = new Scan3dUploader(transport, sid, refreshPanel);
    uploader.setLimits(limits.chunkBytes, limits.window);
    headerSent = false;
    ended = null;
    converting = 0;
    chain = Promise.resolve();
    lastStatusKey = '';
    overlay = makeOverlay();
    ui.start('Starting…', false, null);
    ui.problem('');
    void rig
      .open({ overlay: overlay?.root ?? null, onState, onKeep, keepBlobs: false, hold, onEnd })
      .then(
        (h) => {
          handle = h;
          overlay?.attach(h);
          overlay?.update(h.state());
          ui.lines(['The AR view is open. Aim at the surface next to the object and tap.']);
          void h.closed.then((end) => {
            if (end.error) ui.problem(end.error);
            refreshPanel();
          });
        },
        (err) => {
          overlay?.remove();
          overlay = null;
          uploader = null;
          ui.problem(err instanceof Error ? err.message : String(err));
          refreshPanel();
        },
      );
  }

  const tick = () => {
    uploader?.tick(now());
    if (lastState && handle) status(lastState);
  };

  return {
    get uploader() {
      return uploader;
    },
    async enter() {
      entered = true;
      ui.show(true);
      refreshPanel();
      stopTimer?.();
      stopTimer = every(tick, STATUS_MS);
      try {
        support = await rig.support();
      } catch {
        support = { state: 'unsupported', message: 'Could not find out whether this phone can do AR.' };
      }
      sendSupport();
      refreshPanel();
    },
    leave() {
      entered = false;
      stopTimer?.();
      stopTimer = null;
      void handle?.close();
      uploader?.cancel();
      uploader = null;
      overlay?.remove();
      overlay = null;
      handle = null;
      ui.show(false);
    },
    onOpen() {
      if (!entered) return;
      sendSupport();
      if (handle && sid) sendHeader();
      uploader?.onOpen(now());
      if (lastState && handle) status(lastState, true);
      refreshPanel();
    },
    onClose() {
      uploader?.onClose();
      refreshPanel();
    },
    onMessage(msg) {
      const t = msg.type ?? '';
      if (!t.startsWith('scan3d-')) return false;
      if (t === 'scan3d-ready') {
        const l = (msg as { limits?: { chunkBytes?: unknown; window?: unknown } }).limits;
        if (l && typeof l.chunkBytes === 'number' && l.chunkBytes >= 4096 && l.chunkBytes <= 1 << 20) limits.chunkBytes = l.chunkBytes;
        if (l && typeof l.window === 'number' && l.window >= 1 && l.window <= 64) limits.window = l.window;
        uploader?.setLimits(limits.chunkBytes, limits.window);
      } else if (t === 'scan3d-stop') void handle?.close(); // the person pressed Stop on the computer: same as Done here
      else uploader?.onMessage(msg as never, now());
      return true;
    },
    tick,
  };
}
