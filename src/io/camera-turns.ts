/**
 * Cameras that cannot run together. Some phone browsers open only ONE device camera at a time, whatever the picture size.
 * The page then takes turns: one camera (the main one) stays open, and every other camera gets a short visit now and then:
 * the main camera is closed, the visited one is opened just long enough to give one picture, closed, and the main one comes back.
 * Every Webcam node keeps showing the last picture its camera gave. This file holds the pure parts: settings, who is main, wording.
 */

export type ClashMode = 'turns' | 'always' | 'stop';
export type TurnRole = 'auto' | 'main' | 'visited';

/** What a Webcam node says about taking turns (its settings; the schedule is shared by all Webcam nodes that clash). */
export interface TurnSettings {
  clash: ClashMode;
  role: TurnRole;
  /** Seconds between two visits to this camera (0 = only when asked with Refresh now). */
  every: number;
  /** Pictures to let go by after the camera opens, so the exposure has settled and the picture is not black. */
  settle: number;
}

export const DEFAULT_TURNS: TurnSettings = { clash: 'turns', role: 'auto', every: 5, settle: 3 };
export const EVERY_MAX = 120;
export const SETTLE_MAX = 30;

const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Read the settings from a node's params (old projects have none: the defaults apply). */
export function turnSettingsOf(p: Readonly<Record<string, unknown>>): TurnSettings {
  const clash: ClashMode = p.clash === 'stop' ? 'stop' : p.clash === 'always' ? 'always' : 'turns';
  const role: TurnRole = p.role === 'main' ? 'main' : p.role === 'visited' ? 'visited' : 'auto';
  return { clash, role, every: num(p.every, DEFAULT_TURNS.every, 0, EVERY_MAX), settle: Math.round(num(p.settle, DEFAULT_TURNS.settle, 0, SETTLE_MAX)) };
}

/* ------------------------------------------- timing ------------------------------------------- */

/** The main camera stays open at least this long after it came back, so a camera that is visited often cannot starve it. */
export const MAIN_DWELL_MS = 1500;
/** Pause between closing one camera and opening the next (Android needs a moment to free the camera). */
export const RELEASE_GAP_MS = 60;
/** A visit waits at most this long for the first picture. */
export const FIRST_FRAME_MS = 3000;
/** The main camera is asked for again this many times (with these waits) before the page gives up on it. */
export const RETURN_RETRY_MS = [150, 400, 1000];
/** A camera that cannot be visited is left alone for this long, doubling each time up to the largest. */
export const VISIT_BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
/** The scheduler looks at the situation this often. */
export const TURN_TICK_MS = 250;
/** Visits stop while a recording asks the camera for pictures (it asked this recently). */
export const RECORDING_QUIET_MS = 1500;

export const visitBackoff = (fails: number): number => VISIT_BACKOFF_MS[Math.min(VISIT_BACKOFF_MS.length - 1, Math.max(0, fails - 1))];

/* -------------------------------------------- roles -------------------------------------------- */

export interface Member {
  key: string;
  role: TurnRole;
  /** Order of opening: smaller opened earlier. */
  seq: number;
  /** The inspector of this Webcam is open right now. */
  viewed: boolean;
}

export interface Roles {
  main: string;
  visited: string[];
  /** Cameras that said Main camera but lost to an earlier one that said so too. */
  lostMain: string[];
}

/**
 * Who is main. A camera set to Main camera wins (the first opened wins when several say so; the others are listed in `lostMain`).
 * With nobody set to Main, among the cameras on Automatic the one whose inspector is open wins, otherwise the one opened first.
 * A camera set to Visited camera is never main unless every camera says that (someone has to stay live: the first opened).
 */
export function resolveRoles(members: Member[]): Roles {
  const byOrder = [...members].sort((a, b) => a.seq - b.seq);
  if (!byOrder.length) return { main: '', visited: [], lostMain: [] };
  const wantsMain = byOrder.filter((m) => m.role === 'main');
  const autos = byOrder.filter((m) => m.role === 'auto');
  let main: Member;
  if (wantsMain.length) main = wantsMain[0];
  else if (autos.length) main = autos.find((m) => m.viewed) ?? autos[0];
  else main = byOrder[0];
  return {
    main: main.key,
    visited: byOrder.filter((m) => m !== main).map((m) => m.key),
    lostMain: wantsMain.filter((m) => m !== main).map((m) => m.key),
  };
}

/* -------------------------------------------- wording ------------------------------------------- */

export const ONE_AT_A_TIME_LINE = 'This browser runs one camera at a time: use Take turns (the Webcam setting When cameras clash).';

export const seconds = (ms: number): string => `${(Math.round(ms / 100) / 10).toFixed(1)} s`;

export interface TurnStatus {
  role: 'main' | 'visited';
  /** Another Webcam also said Main camera and was opened first. */
  lostMain: boolean;
  /** This camera is open right now. */
  live: boolean;
  every: number;
  /** Milliseconds since this camera's last picture (null: none yet). */
  age: number | null;
  /** How long a visit took, and how long the main camera took to come back (null: not measured yet). */
  visitMs: number | null;
  returnMs: number | null;
  /** A visit is going on right now. */
  visiting: boolean;
  /** The last visit to this camera failed and the page waits before trying again. */
  failed: boolean;
}

/** The one line the Webcam inspector shows for a camera that takes turns. */
export function turnLine(s: TurnStatus): string {
  const cost = s.visitMs !== null ? ` · a visit takes about ${seconds(s.visitMs + (s.returnMs ?? 0))} (the main camera pauses meanwhile)` : '';
  if (s.role === 'main') {
    if (s.visiting) return 'Main camera: paused for a moment while the other camera takes its turn, showing its last picture';
    return `Main camera: live${s.visitMs !== null ? ` · the other camera visits, a visit takes about ${seconds(s.visitMs + (s.returnMs ?? 0))}` : ''}`;
  }
  const how = s.every > 0 ? `Visited every ${Math.round(s.every * 10) / 10} s` : 'Visited only when asked (Refresh now)';
  const last = s.visiting ? 'taking its picture now' : s.failed ? 'could not be opened, trying again later' : s.age === null ? 'no picture yet' : `last picture ${Math.max(0, Math.round(s.age / 1000))} s ago`;
  const lost = s.lostMain ? ' · another Webcam set to Main camera came first, so this one is visited' : '';
  return `${how} · ${last}${cost}${lost}`;
}
