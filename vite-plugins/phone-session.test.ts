import { describe, expect, it } from 'vitest';
import { CLOSE_CODES, PhoneSessions, SESSION_TTL_MS, TOKEN_RE, type Peer } from './phone-session';

const T = 'a'.repeat(32);
function peer() {
  const sent: (string | Uint8Array)[] = [];
  const closed: number[] = [];
  const p: Peer = { send: (d) => void sent.push(d), close: (c) => void closed.push(c) };
  return { p, sent, closed };
}

describe('PhoneSessions', () => {
  it('accepts only 128-bit hex tokens', () => {
    expect(TOKEN_RE.test(T)).toBe(true);
    expect(TOKEN_RE.test('abc')).toBe(false);
    const s = new PhoneSessions();
    expect(s.registerDesktop('nothex'.padEnd(32, 'z'), peer().p, 0)).toEqual({ ok: false, reason: 'bad-token' });
    expect(s.joinPhone('short', peer().p, 0)).toEqual({ ok: false, reason: 'bad-token' });
  });

  it('pairs one phone with a registered desktop and rejects unknown tokens', () => {
    const s = new PhoneSessions();
    const d = peer();
    expect(s.joinPhone(T, peer().p, 0)).toEqual({ ok: false, reason: 'unknown-token' });
    expect(s.registerDesktop(T, d.p, 0).ok).toBe(true);
    expect(s.registerDesktop(T, peer().p, 1)).toEqual({ ok: false, reason: 'token-exists' });
    const ph = peer();
    expect(s.joinPhone(T, ph.p, 10).ok).toBe(true);
    expect(JSON.parse(d.sent[0] as string)).toEqual({ type: 'phone-joined' });
    expect(s.joinPhone(T, peer().p, 11)).toEqual({ ok: false, reason: 'phone-busy' }); // single phone per token
    expect(s.joinPhone('b'.repeat(32), peer().p, 11)).toEqual({ ok: false, reason: 'unknown-token' });
  });

  it('relays in both directions and nowhere else', () => {
    const s = new PhoneSessions();
    const d = peer();
    const ph = peer();
    s.registerDesktop(T, d.p, 0);
    expect(s.relay(T, 'desktop', 'offer', false)).toBe(false); // nobody on the other side yet
    s.joinPhone(T, ph.p, 1);
    expect(s.relay(T, 'desktop', 'offer', false)).toBe(true);
    expect(ph.sent).toEqual(['offer']);
    const frame = new Uint8Array([1, 2, 3]);
    expect(s.relay(T, 'phone', frame, true)).toBe(true);
    expect(d.sent.at(-1)).toBe(frame);
    expect(s.relay('c'.repeat(32), 'phone', 'x', false)).toBe(false);
  });

  it('expires an unused token after 5 minutes and tells the desktop', () => {
    const s = new PhoneSessions();
    const d = peer();
    s.registerDesktop(T, d.p, 0);
    s.sweep(SESSION_TTL_MS - 1);
    expect(d.closed).toEqual([]);
    expect(s.joinPhone(T, peer().p, SESSION_TTL_MS)).toEqual({ ok: false, reason: 'unknown-token' }); // already swept by the join itself
    expect(JSON.parse(d.sent.at(-1) as string)).toEqual({ type: 'expired' });
    expect(d.closed).toEqual([CLOSE_CODES.unused]);
    expect(s.size).toBe(0);
  });

  it('a used session does not expire; the phone may rejoin after a network hiccup', () => {
    const s = new PhoneSessions();
    const d = peer();
    const ph = peer();
    s.registerDesktop(T, d.p, 0);
    s.joinPhone(T, ph.p, 1000);
    s.sweep(SESSION_TTL_MS * 10);
    expect(s.size).toBe(1);
    s.closed(T, 'phone', ph.p);
    expect(JSON.parse(d.sent.at(-1) as string)).toEqual({ type: 'phone-left' });
    expect(s.joinPhone(T, peer().p, SESSION_TTL_MS * 11).ok).toBe(true);
  });

  it('the desktop leaving ends the session and disconnects the phone; stale sockets are ignored', () => {
    const s = new PhoneSessions();
    const d = peer();
    const ph = peer();
    s.registerDesktop(T, d.p, 0);
    s.joinPhone(T, ph.p, 1);
    s.closed(T, 'desktop', peer().p); // someone else's socket: ignored
    expect(s.size).toBe(1);
    s.closed(T, 'desktop', d.p);
    expect(s.size).toBe(0);
    expect(ph.closed).toEqual([CLOSE_CODES.ended]);
    expect(s.joinPhone(T, peer().p, 5).ok).toBe(false); // the token cannot be reused
  });
});
