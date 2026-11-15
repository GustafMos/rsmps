import { useEffect, useState } from 'react';
import type { AnyNodeDef, NodeInstance, ParamDef } from '../../engine/types';
import type { PhoneSessionInfo, PhoneState } from '../../io/api';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';

/** Shape-based: a hidden string param called `session` marks a node that links to a phone. */
export function hasSessionParam(def: AnyNodeDef | undefined): boolean {
  const p = def && (def.params as Record<string, ParamDef>).session;
  return !!p && p.type === 'string';
}

const LABEL: Record<PhoneState, string> = { waiting: 'Waiting for phone', connected: 'Phone connected', disconnected: 'Phone disconnected', expired: 'Code expired' };

/** Live state of a pairing token (null when there is no token). */
export function usePhoneState(token: string): PhoneState | null {
  const { io } = useApp();
  const [state, setState] = useState<PhoneState | null>(token ? io.phone.state(token) : null);
  useEffect(() => {
    setState(token ? io.phone.state(token) : null);
    if (!token) return;
    return io.phone.onState((t, s) => {
      if (t === token) setState(s);
    });
  }, [io, token]);
  return state;
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
  const tone = state === 'connected' ? ' is-ok' : state === 'waiting' ? ' is-wait' : token ? ' is-bad' : '';
  return (
    <div className={`rs-phonechip${tone}`} title="Phone link status">
      <Icon name="plug" size={11} />
      <span>{text}</span>
    </div>
  );
}

function CopyCode({ text }: { text: string }) {
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const mine = info && info.token === token ? info : null;
  const left = useCountdown(mine?.expiresAt ?? null, state === 'waiting');

  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      if (token) io.phone.close(token);
      const s = await io.phone.createSession();
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
  const status = !token ? 'Not linked' : state === 'waiting' ? `${LABEL.waiting} · code expires in ${mm}` : state ? LABEL[state] : 'Not linked';
  return (
    <div className="rs-insp__sec rs-phone">
      <div className="rs-caps">Link a phone</div>
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary" disabled={busy} onClick={create}>{token ? 'New code' : 'Link a phone'}</button>
        {token && <button className="rs-btn" onClick={disconnect}>Disconnect</button>}
      </div>
      {err && <p className="rs-insp__warn">{err}</p>}
      {token && (
        <div className={`rs-phone__status${state === 'connected' ? ' is-ok' : ''}`} role="status">{status}</div>
      )}
      {mine && state !== 'expired' && (
        <>
          <div className="rs-phone__qr" aria-label="QR code to scan with the phone" dangerouslySetInnerHTML={{ __html: mine.qrSvg }} />
          <CopyCode text={mine.url} />
          <p className="rs-insp__hint">Your phone will warn that the connection is not private. Choose Advanced → Proceed: it is your own computer.</p>
        </>
      )}
      {token && !mine && <p className="rs-insp__hint">The code is only kept while this page stays open. Use New code to show it again.</p>}
    </div>
  );
}
