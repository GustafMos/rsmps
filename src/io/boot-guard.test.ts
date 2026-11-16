import { describe, expect, it } from 'vitest';
import { BootGuard, FORCE_SAFE_KEY, GUARD_KEY, decideBoot, parseMarker, urlWantsSafe, type StorageLike } from './boot-guard';

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const start = { shift: false, urlSafe: false };

describe('boot guard decision', () => {
  it('starts normally with no marker', () => {
    expect(decideBoot({ marker: null, shift: false, urlSafe: false, manual: false })).toMatchObject({ safe: false, reason: null });
  });
  it('an old marker means the last run did not finish: safe mode', () => {
    const marker = { at: 1, phase: 'render' as const, project: 'p1', session: 's' };
    expect(decideBoot({ marker, shift: false, urlSafe: false, manual: false })).toMatchObject({ safe: true, reason: 'unclean', previous: marker });
  });
  it('Shift, the address and a manual request each force safe mode; the address wins the label', () => {
    expect(decideBoot({ marker: null, shift: true, urlSafe: false, manual: false }).reason).toBe('shift');
    expect(decideBoot({ marker: null, shift: false, urlSafe: false, manual: true }).reason).toBe('manual');
    expect(decideBoot({ marker: null, shift: true, urlSafe: true, manual: true }).reason).toBe('url');
  });
  it('reads ?safe variants', () => {
    expect(urlWantsSafe('?safe')).toBe(true);
    expect(urlWantsSafe('?a=1&safe=1')).toBe(true);
    expect(urlWantsSafe('?safe=0')).toBe(false);
    expect(urlWantsSafe('?safe=false')).toBe(false);
    expect(urlWantsSafe('?unsafe=1')).toBe(false);
    expect(urlWantsSafe('')).toBe(false);
  });
  it('parseMarker tolerates junk', () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker('{nope')).toBeNull();
    expect(parseMarker('{"x":1}')).toBeNull();
    expect(parseMarker('{"at":5,"phase":"render","project":"a","session":"b"}')).toEqual({ at: 5, phase: 'render', project: 'a', session: 'b' });
  });
});

describe('BootGuard state machine', () => {
  it('boot then first frame clears the marker, so the next start is normal', () => {
    const st = mem();
    const g = new BootGuard(st, () => 100, 's1');
    expect(g.begin(start).safe).toBe(false);
    expect(g.state).toBe('booting');
    expect(st.data.has(GUARD_KEY)).toBe(true);
    g.renderDone();
    expect(g.state).toBe('idle');
    expect(st.data.has(GUARD_KEY)).toBe(false);
    expect(new BootGuard(st).begin(start).safe).toBe(false);
  });

  it('a run that dies while booting makes the next start safe, and a safe start does not re-arm the marker', () => {
    const st = mem();
    new BootGuard(st, () => 1, 'a').begin(start);
    const next = new BootGuard(st, () => 2, 'b');
    const d = next.begin(start);
    expect(d).toMatchObject({ safe: true, reason: 'unclean' });
    expect(next.state).toBe('safe');
    expect(st.data.has(GUARD_KEY)).toBe(false); // nothing renders in safe mode, so nothing can hang
    expect(new BootGuard(st).begin(start).safe).toBe(false); // and the loop is broken
  });

  it('a render that never finishes marks the run unclean; one that finishes does not', () => {
    const st = mem();
    const g = new BootGuard(st, () => 1, 'a');
    g.begin(start);
    g.renderDone();
    g.setProject('p9');
    g.renderStart();
    expect(parseMarker(st.data.get(GUARD_KEY)!)).toMatchObject({ phase: 'render', project: 'p9' });
    g.renderDone();
    expect(st.data.has(GUARD_KEY)).toBe(false);
    g.renderStart();
    expect(new BootGuard(st).begin(start).previous?.project).toBe('p9');
  });

  it('renderStart writes once, not on every edit of a drag', () => {
    const st = mem();
    let writes = 0;
    const counting: StorageLike = { getItem: st.getItem, removeItem: st.removeItem, setItem: (k, v) => { writes++; st.setItem(k, v); } };
    const g = new BootGuard(counting, () => 1, 'a');
    g.begin(start);
    g.renderStart(); // still booting: no write
    expect(writes).toBe(1);
    g.renderDone();
    g.renderStart();
    const w = writes;
    for (let i = 0; i < 20; i++) g.renderStart();
    expect(writes).toBe(w);
  });

  it('a manual safe start is consumed once; resume and enterSafe move between states', () => {
    const st = mem();
    new BootGuard(st, () => 1, 'a').requestSafeStart();
    expect(st.data.has(FORCE_SAFE_KEY)).toBe(true);
    const h = new BootGuard(st, () => 2, 'b');
    expect(h.begin(start)).toMatchObject({ safe: true, reason: 'manual' });
    expect(st.data.has(FORCE_SAFE_KEY)).toBe(false);
    h.resume();
    expect(h.state).toBe('idle');
    h.renderStart();
    expect(h.state).toBe('rendering');
    h.enterSafe();
    expect(h.state).toBe('safe');
    expect(st.data.has(GUARD_KEY)).toBe(false);
  });

  it('an orderly page exit removes the marker', () => {
    const st = mem();
    const g = new BootGuard(st, () => 1, 'a');
    g.begin(start);
    g.leave();
    expect(st.data.has(GUARD_KEY)).toBe(false);
  });

  it('blocked storage never throws', () => {
    const fail = () => {
      throw new Error('no');
    };
    const g = new BootGuard({ getItem: fail, setItem: fail, removeItem: fail });
    expect(() => {
      g.begin(start);
      g.renderStart();
      g.renderDone();
      g.leave();
    }).not.toThrow();
  });
});
