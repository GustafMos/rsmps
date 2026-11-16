import { useEffect, useState } from 'react';
import type { AnyNodeDef, NodeInstance, ParamDef } from '../../engine/types';
import type { PhoneAddress, PhoneSessionInfo, PhoneState } from '../../io/api';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';

/** Shape-based: a hidden string param called `session` marks a node that links to a phone. */
export function hasSessionParam(def: AnyNodeDef | undefined): boolean {
  const p = def && (def.params as Record<string, ParamDef>).session;
  return !!p && p.type === 'string';
}

const LABEL: Record<PhoneState, string> = { waiting: 'Waiting for phone', connected: 'Phone connected', disconnected: 'Phone disconnected', expired: 'Code expired' };

/** Tokens made during this page load: sessions live in memory, so a token saved in a project is dead after a reload. */
const madeHere = new Set<string>();

/** Live state of a pairing token (null when there is no token, or the saved token no longer has a session). */
export function usePhoneState(token: string): PhoneState | null {
  const { io } = useApp();
  const read = (): PhoneState | null => {
    if (!token) return null;
    const s = io.phone.state(token);
    return s === 'expired' && !madeHere.has(token) ? null : s;
  };
  const [state, setState] = useState<PhoneState | null>(read);
  useEffect(() => {
    setState(read());
    if (!token) return;
    return io.phone.onState((t, s) => {
      if (t === token) setState(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io, token]);
  return state;
}

/** Help line for a token (what the phone reported, or the firewall checklist after a while). */
function usePhoneDetail(token: string): string {
  const { io } = useApp();
  const [detail, setDetail] = useState(() => (token ? io.phone.detail(token) : ''));
  useEffect(() => {
    setDetail(token ? io.phone.detail(token) : '');
    if (!token) return;
    return io.phone.onState((t, _s, d) => {
      if (t === token) setDetail(d);
    });
  }, [io, token]);
  return detail;
}

function useCountdown(until: number | null, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on || until === null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [until, on]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/** Small status chip shown on the node. */
export function PhoneChip({ node }: { node: NodeInstance }) {
  const token = String(node.params.session ?? '');
  const state = usePhoneState(token);
  const text = !token ? 'Not linked' : state ? LABEL[state] : 'Not linked';
  const tone = state === 'connected' ? ' is-ok' : state === 'waiting' ? ' is-wait' : state ? ' is-bad' : '';
  return (
    <div className={`rs-phonechip${tone}`} title="Phone link status">
      <Icon name="plug" size={11} />
      <span>{text}</span>
    </div>
  );
}

export function CopyCode({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="rs-phone__code">
      <code className="rs-mono">{text}</code>
      <button
        className="rs-btn rs-btn--ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }).catch(() => undefined);
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Inspector panel: link a phone camera by QR code. */
export function PhonePanel({ node }: { node: NodeInstance }) {
  const { ed, io } = useApp();
  const token = String(node.params.session ?? '');
  const state = usePhoneState(token);
  const [info, setInfo] = useState<PhoneSessionInfo | null>(null);
  const [addrs, setAddrs] = useState<PhoneAddress[]>([]);
  const [address, setAddress] = useState('');
  const detail = usePhoneDetail(token);
  useEffect(() => {
    let live = true;
    if (io.phone.available) void io.phone.addresses().then((a) => { if (live) { setAddrs(a); setAddress((cur) => cur || a[0]?.url || ''); } }).catch(() => undefined);
    return () => { live = false; };
  }, [io]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const mine = info && info.token === token ? info : null;
  const expires = token && state === 'waiting' ? io.phone.expiresAt(token) ?? mine?.expiresAt ?? null : null;
  const left = useCountdown(expires, state === 'waiting');

  const create = async (addr: string = address) => {
    setBusy(true);
    setErr('');
    try {
      if (token) io.phone.close(token);
      // a packaged app may start its phone server on demand: call it first when it exists
      const on = io.phone as unknown as { startServer?: () => Promise<unknown> };
      if (on.startServer) await on.startServer();
      const s = await io.phone.createSession(addr ? { address: addr } : undefined);
      madeHere.add(s.token);
      setInfo(s);
      ed.setParam(node.id, 'session', s.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = () => {
    if (token) io.phone.close(token);
    setInfo(null);
    ed.setParam(node.id, 'session', '');
  };

  if (!io.phone.available) {
    return (
      <div className="rs-insp__sec rs-phone">
        <div className="rs-caps">Link a phone</div>
        <p className="rs-insp__hint">Phones only share their camera over a secure connection, and this app must be reachable from your network.</p>
        <p className="rs-insp__hint">Stop the app and start it again with:</p>
        <CopyCode text="npm run dev:lan" />
      </div>
    );
  }
  const mm = String(Math.floor(left / 60)) + ':' + String(left % 60).padStart(2, '0');
  const status = !token || !state ? 'Not linked' : state === 'waiting' ? `${LABEL.waiting} · code expires in ${mm}` : state ? LABEL[state] : 'Not linked';
  return (
    <div className="rs-insp__sec rs-phone">
      <div className="rs-caps">Link a phone</div>
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void create()}>{token && state ? 'New code' : 'Link a phone'}</button>
        {token && <button className="rs-btn" onClick={disconnect}>Disconnect</button>}
      </div>
      {addrs.length > 1 && (
        <label className="rs-phone__addr">
          <span className="rs-insp__hint">Address the phone will use</span>
          <select className="rs-select" value={address} aria-label="Address the phone will use" onChange={(e) => { setAddress(e.target.value); if (token && state) void create(e.target.value); }}>
            {addrs.map((a) => <option key={a.url} value={a.url}>{a.label}</option>)}
          </select>
        </label>
      )}
      {err && <p className="rs-insp__warn">{err}</p>}
      {token && state && (
        <div className={`rs-phone__status${state === 'connected' ? ' is-ok' : ''}`} role="status">{status}</div>
      )}
      {token && state && state !== 'expired' && (
        <ol className="rs-phone__steps" aria-label="Progress">
          {[['Reached your computer', state === 'connected' || /reached|accepted|connect/i.test(detail)], ['Code accepted', state === 'connected' || /accepted|Connecting the video/i.test(detail)], ['Video connected', state === 'connected']].map(([label, ok]) => (
            <li key={String(label)} className={ok ? 'is-done' : ''}><Icon name={ok ? 'check' : 'more'} size={16} />{String(label)}</li>
          ))}
        </ol>
      )}
      {token && state && detail && state !== 'connected' && <p className="rs-insp__hint rs-phone__detail">{detail}</p>}
      {mine && state !== 'expired' && (
        <>
          <div className="rs-phone__qr" aria-label="QR code to scan with the phone" dangerouslySetInnerHTML={{ __html: mine.qrSvg }} />
          <CopyCode text={mine.url} />
          <p className="rs-insp__hint">Your phone will warn that the connection is not private. Choose Advanced → Proceed: it is your own computer.</p>
        </>
      )}
      {token && state && !mine && <p className="rs-insp__hint">The code is only kept while this page stays open. Use New code to show it again.</p>}
    </div>
  );
}
