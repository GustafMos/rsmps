/**
 * Pairing logic of the phone link (pure: no sockets, no clock of its own, so it is unit-testable).
 *
 * A session token is a 128-bit random hex string made on the desktop. The desktop registers it, then ONE phone may join
 * with it. An unused token expires 5 minutes after it was registered. The server only relays messages between the two
 * peers; it never inspects or stores them. Nothing is written to disk.
 */

export const TOKEN_RE = /^[0-9a-f]{32}$/;
export const SESSION_TTL_MS = 5 * 60 * 1000;

export interface Peer {
  send(data: string | Uint8Array, binary?: boolean): void;
  close(code: number, reason: string): void;
}

export type RejectReason = 'bad-token' | 'unknown-token' | 'expired' | 'phone-busy' | 'token-exists';

export const CLOSE_CODES: Record<RejectReason | 'ended' | 'unused', number> = {
  'bad-token': 4400,
  'unknown-token': 4404,
  expired: 4408,
  'phone-busy': 4409,
  'token-exists': 4410,
  ended: 4000,
  unused: 4408,
};

interface Session {
  token: string;
  created: number;
  desktop: Peer;
  phone: Peer | null;
  /** True once a phone has joined: the unused-expiry no longer applies. */
  used: boolean;
}

export class PhoneSessions {
  private sessions = new Map<string, Session>();

  constructor(private ttlMs = SESSION_TTL_MS) {}

  get size(): number {
    return this.sessions.size;
  }

  /** The desktop registers a token it generated. */
  registerDesktop(token: string, desktop: Peer, now: number): { ok: true } | { ok: false; reason: RejectReason } {
    if (!TOKEN_RE.test(token)) return { ok: false, reason: 'bad-token' };
    this.sweep(now);
    if (this.sessions.has(token)) return { ok: false, reason: 'token-exists' };
    this.sessions.set(token, { token, created: now, desktop, phone: null, used: false });
    return { ok: true };
  }

  /** A phone joins. Exactly one phone per token; after it leaves, a phone may rejoin (network hiccups). */
  joinPhone(token: string, phone: Peer, now: number): { ok: true } | { ok: false; reason: RejectReason } {
    if (!TOKEN_RE.test(token)) return { ok: false, reason: 'bad-token' };
    this.sweep(now);
    const s = this.sessions.get(token);
    if (!s) return { ok: false, reason: 'unknown-token' };
    if (!s.used && now - s.created >= this.ttlMs) {
      this.end(s);
      return { ok: false, reason: 'expired' };
    }
    if (s.phone) return { ok: false, reason: 'phone-busy' };
    s.phone = phone;
    s.used = true;
    s.desktop.send(JSON.stringify({ type: 'phone-joined' }));
    return { ok: true };
  }

  /** Relay a message from one side to the other. Returns false when there is nobody to receive it. */
  relay(token: string, from: 'desktop' | 'phone', data: string | Uint8Array, binary: boolean): boolean {
    const s = this.sessions.get(token);
    if (!s) return false;
    const to = from === 'desktop' ? s.phone : s.desktop;
    if (!to) return false;
    to.send(data, binary);
    return true;
  }

  /** A peer's socket closed. The desktop leaving ends the session; the phone leaving frees the slot for a reconnect. */
  closed(token: string, who: 'desktop' | 'phone', peer: Peer): void {
    const s = this.sessions.get(token);
    if (!s) return;
    if (who === 'desktop') {
      if (s.desktop !== peer) return;
      this.sessions.delete(token);
      s.phone?.close(CLOSE_CODES.ended, 'desktop left');
    } else if (s.phone === peer) {
      s.phone = null;
      s.desktop.send(JSON.stringify({ type: 'phone-left' }));
    }
  }

  /** Expire unused sessions. Call from a timer and before joins. */
  sweep(now: number): void {
    for (const s of [...this.sessions.values()]) if (!s.used && now - s.created >= this.ttlMs) this.end(s);
  }

  private end(s: Session): void {
    this.sessions.delete(s.token);
    s.desktop.send(JSON.stringify({ type: 'expired' }));
    s.desktop.close(CLOSE_CODES.unused, 'expired');
    s.phone?.close(CLOSE_CODES.unused, 'expired');
  }
}
