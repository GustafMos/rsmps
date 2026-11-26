/**
 * Stop motion with a linked phone, computer side. One `PhoneStopMotionStore` per PhoneLink, a session per pairing token: the receiver of the
 * phone's stills (src/phone/stopmotion-protocol.ts), the shared settings, what the phone reports (shots, auto shoot, sending progress) and
 * the commands the computer sends (remote shutter, auto shoot on / off).
 *
 * The store knows nothing about projects. The Stop Motion controller (src/ui/store/stopMotion.ts) registers a `ReceiverTarget` for the token:
 * a received picture is handed to it, becomes Media and a shot exactly like a local one, and only then is it acknowledged to the phone.
 * Without a target (no Stop Motion chosen, the panel was closed) the phone is told to wait and keeps its pictures.
 */
import {
  DEFAULT_SETTINGS,
  ShotReceiver,
  cleanPatch,
  isSmType,
  parseStatus,
  settingsMsg,
  type ReceiverTarget,
  type SmCommand,
  type SmSettings,
  type SmStatus,
} from '../phone/stopmotion-protocol';

export interface PhoneSmInfo {
  /** The phone page is in stop motion mode and linked. */
  active: boolean;
  /** Stills stored from this phone since the link was made. */
  received: number;
  /** The picture arriving now (shot number and 0..1), or null. */
  arriving: { n: number; fraction: number } | null;
  status: SmStatus | null;
  settings: SmSettings;
}

interface Sess {
  receiver: ShotReceiver;
  target: ReceiverTarget | null;
  settings: SmSettings;
  active: boolean;
  received: number;
  arriving: { n: number; fraction: number } | null;
  status: SmStatus | null;
  sid: string;
  listeners: Set<() => void>;
  patchers: Set<(patch: Partial<Omit<SmSettings, 'rev'>>) => void>;
}

export interface PhoneSmDeps {
  sendJson(token: string, msg: Record<string, unknown>): void;
}

export class PhoneStopMotionStore {
  private sessions = new Map<string, Sess>();

  constructor(private deps: PhoneSmDeps) {}

  /** Messages of this feature all start with `sm-`. */
  static handles(type: unknown): boolean {
    return isSmType(type);
  }

  has(token: string): boolean {
    return this.sessions.has(token);
  }

  private sess(token: string): Sess {
    let s = this.sessions.get(token);
    if (!s) {
      const created: Sess = {
        receiver: null as unknown as ShotReceiver,
        target: null,
        settings: { ...DEFAULT_SETTINGS },
        active: false,
        received: 0,
        arriving: null,
        status: null,
        sid: '',
        listeners: new Set(),
        patchers: new Set(),
      };
      created.receiver = new ShotReceiver(
        (m) => this.deps.sendJson(token, m),
        () => created.target,
        {
          onProgress: (_sid, n, fraction) => {
            const prev = created.arriving;
            created.arriving = { n, fraction };
            if (!prev || prev.n !== n || fraction - prev.fraction >= 0.02 || fraction >= 1) this.emit(created);
          },
          onStored: () => {
            created.received++;
            created.arriving = null;
            this.emit(created);
          },
          onRemoved: () => {
            created.arriving = null;
            this.emit(created);
          },
        },
      );
      this.sessions.set(token, (s = created));
    }
    return s;
  }

  private emit(s: Sess): void {
    for (const l of [...s.listeners]) l();
  }

  info(token: string): PhoneSmInfo | null {
    const s = this.sessions.get(token);
    return s ? { active: s.active, received: s.received, arriving: s.arriving, status: s.status, settings: s.settings } : null;
  }

  subscribe(token: string, fn: () => void): () => void {
    const s = this.sess(token);
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  }

  /** Where received pictures go (null: nowhere, the phone waits). */
  setTarget(token: string, target: ReceiverTarget | null): void {
    this.sess(token).target = target;
  }

  /** The phone changed a setting (onion, strength, interval, stop after): the controller writes it into the node. */
  onPatch(token: string, fn: (patch: Partial<Omit<SmSettings, 'rev'>>) => void): () => void {
    const s = this.sess(token);
    s.patchers.add(fn);
    return () => s.patchers.delete(fn);
  }

  /** The phone's hello says what it does now (its sm-hello follows and brings the settings). */
  phoneMode(token: string, stopmotion: boolean): void {
    const s = this.sess(token);
    if (s.active === stopmotion) return;
    s.active = stopmotion;
    this.emit(s);
  }

  phoneLeft(token: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.active = false; // pictures received so far stay; a reconnect resumes (the receiver keeps its state)
    s.arriving = null;
    this.emit(s);
  }

  drop(token: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    s.active = false;
    this.emit(s);
  }

  private sendSettings(s: Sess, token: string, reset = false): void {
    s.settings = { ...s.settings, rev: s.settings.rev + 1 };
    this.deps.sendJson(token, { ...settingsMsg(s.settings), ...(reset ? { reset: true } : {}) });
  }

  /** The computer changed a setting (the node's Shot size, interval...): bump the revision and tell the phone. */
  setSettings(token: string, patch: Partial<Omit<SmSettings, 'rev'>>): void {
    const s = this.sessions.get(token);
    if (!s) return;
    const p = cleanPatch(patch);
    const next = { ...s.settings, ...p };
    if ((Object.keys(p) as (keyof typeof p)[]).every((k) => s.settings[k] === next[k])) return; // nothing new
    s.settings = next;
    if (s.active) this.sendSettings(s, token);
    this.emit(s);
  }

  /** Shots in the node, for the phone's counter. */
  setCount(token: string, shots: number): void {
    const s = this.sessions.get(token);
    if (s?.active) this.deps.sendJson(token, { type: 'sm-count', shots });
  }

  /** Remote shutter and auto shoot. False when no phone is in stop motion mode. */
  command(token: string, cmd: SmCommand): boolean {
    const s = this.sessions.get(token);
    if (!s?.active) return false;
    this.deps.sendJson(token, { type: 'sm-cmd', cmd });
    return true;
  }

  /** A shot of this phone was removed on the computer: the phone drops it from its strip and onion skin. */
  removedOnComputer(token: string, asset: string): void {
    const s = this.sessions.get(token);
    const shot = s?.receiver.shotOfAsset(asset);
    if (s && shot) s.receiver.remove(shot.sid, shot.n, false);
  }

  ingest(token: string, msg: { type?: string; [k: string]: unknown }): void {
    const s = this.sess(token);
    switch (msg.type) {
      case 'sm-hello':
        s.active = true;
        s.sid = typeof msg.sid === 'string' ? msg.sid : s.sid;
        this.sendSettings(s, token, true);
        this.emit(s);
        break;
      case 'sm-begin':
        s.receiver.onBegin(msg);
        break;
      case 'sm-chunk':
        s.receiver.onChunk(msg);
        break;
      case 'sm-undo':
        s.receiver.onUndo(msg);
        break;
      case 'sm-set': {
        const patch = cleanPatch(msg.patch);
        if (!Object.keys(patch).length) break;
        if (s.patchers.size) for (const f of [...s.patchers]) f(patch);
        else this.setSettings(token, patch);
        break;
      }
      case 'sm-status': {
        const st = parseStatus(msg);
        if (st) {
          s.status = st;
          this.emit(s);
        }
        break;
      }
    }
  }
}
