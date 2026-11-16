import { useEffect, useState } from 'react';
import type { PhoneAddress, PhoneSessionInfo } from '../../io/api';
import { phoneSteps } from '../../io/phone';
import { thirdStepLabel } from '../../phone/link-modes';
import { Icon } from '../components/Icon';
import { CopyCode, useCountdown, usePhoneDetail, usePhoneProgress, usePhoneState } from '../inspector/PhonePanel';
import { useApp } from '../store/context';

const LABEL = { waiting: 'Waiting for phone', connected: 'Phone connected', disconnected: 'Phone disconnected', expired: 'Code expired' } as const;

/**
 * "Scan with phone" on the Scan tab. Reuses the phone link: if a phone is already linked (for example for a Phone Camera node) that
 * session is reused and the phone is switched to scan mode (no second QR code); otherwise a new session is made with `mode=scan` in the
 * link and the same QR code, address list and progress ticks as the phone camera panel.
 */
export function PhoneScanPanel({ token, onToken, onClose }: { token: string; onToken: (t: string) => void; onClose: () => void }) {
  const { io } = useApp();
  const state = usePhoneState(token);
  const detail = usePhoneDetail(token);
  const progress = usePhoneProgress(token);
  const [info, setInfo] = useState<PhoneSessionInfo | null>(null);
  const [addrs, setAddrs] = useState<PhoneAddress[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reused, setReused] = useState(false);
  const mine = info && info.token === token ? info : null;
  const expires = token && state === 'waiting' ? io.phone.expiresAt(token) ?? mine?.expiresAt ?? null : null;
  const left = useCountdown(expires, state === 'waiting');

  useEffect(() => {
    let live = true;
    if (io.phone.available) void io.phone.addresses().then((a) => { if (live) { setAddrs(a); setAddress((cur) => cur || a[0]?.url || ''); } }).catch(() => undefined);
    return () => { live = false; };
  }, [io]);

  const make = async (addr: string = address) => {
    setBusy(true);
    setErr('');
    try {
      if (token && !reused) io.phone.close(token);
      const started = await io.phone.startServer?.();
      if (started && !started.ok) {
        setErr(started.declined ? 'Phone connections were not allowed, so a phone cannot link. Allow them to continue.' : started.error || 'The phone link could not start.');
        return;
      }
      const s = await io.phone.createSession({ ...(addr ? { address: addr } : {}), mode: 'scan' });
      setInfo(s);
      setReused(false);
      onToken(s.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // On open: reuse a phone that is already linked, else make a code.
  useEffect(() => {
    if (token || !io.phone.available) return;
    const linked = io.phone.linked?.() ?? null;
    if (linked) {
      io.phone.setMode?.(linked, 'scan'); // the phone page switches to scan mode; no second QR code
      setReused(true);
      onToken(linked);
    } else void make();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    if (token) {
      if (reused) io.phone.setMode?.(token, 'camera');
      else io.phone.close(token);
    }
    setInfo(null);
    onToken('');
    onClose();
  };

  if (!io.phone.available) {
    return (
      <section className="rs-sc__phone">
        <div className="rs-caps">Scan with phone</div>
        <p className="rs-insp__hint">The phone link needs a secure connection that your phone can reach. The desktop app starts it for you; in the web version run <code>npm run dev:lan</code> and open the https address it prints.</p>
        <button className="rs-btn" onClick={onClose}>Close</button>
      </section>
    );
  }
  const link = token ? io.phone.link?.(token) ?? null : null;
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const connected = state === 'connected';
  return (
    <section className="rs-sc__phone" aria-label="Scan with phone">
      <div className="rs-caps">Scan with phone</div>
      {connected && link?.mode !== 'scan' && <p className="rs-insp__hint">Switching the phone to scan mode…</p>}
      <div className={`rs-phone__status${connected ? ' is-ok' : ''}`} role="status">
        {!token || !state ? 'Starting the link…' : state === 'waiting' ? `${LABEL.waiting} · code expires in ${mm}` : LABEL[state]}
      </div>
      {token && state && state !== 'expired' && (
        <ol className="rs-phone__steps" aria-label="Progress">
          {(['Reached your computer', 'Code accepted', thirdStepLabel(link?.mode ?? 'scan', link?.media ?? null)] as const).map((label, i) => {
            const ok = phoneSteps(progress, state)[i];
            return <li key={label} className={ok ? 'is-done' : ''}><Icon name={ok ? 'check' : 'more'} size={16} />{label}</li>;
          })}
        </ol>
      )}
      {err && <p className="rs-insp__warn" role="alert">{err}</p>}
      {token && state && detail && !connected && <p className="rs-insp__hint">{detail}</p>}
      {addrs.length > 1 && !reused && (
        <label className="rs-phone__addr">
          <span className="rs-insp__hint">Address the phone will use</span>
          <select className="rs-select" value={address} aria-label="Address the phone will use" onChange={(e) => { setAddress(e.target.value); if (token) void make(e.target.value); }}>
            {addrs.map((a) => <option key={a.url} value={a.url}>{a.label}</option>)}
          </select>
        </label>
      )}
      {mine && state !== 'expired' && !connected && (
        <>
          <div className="rs-phone__qr" aria-label="QR code to scan with the phone" dangerouslySetInnerHTML={{ __html: mine.qrSvg }} />
          <CopyCode text={mine.url} />
          <p className="rs-insp__hint">Your phone will warn that the connection is not private. Choose Advanced → Proceed: it is your own computer.</p>
        </>
      )}
      {connected && <p className="rs-insp__hint">On the phone: point at a printed sheet until the four corner ticks turn white, then tap the shutter. Photos go straight into this scan project and are scanned as they arrive. Press Done on the phone to see the animation there.</p>}
      <div className="rs-insp__actions">
        {(state === 'expired' || state === 'disconnected' || (!token && !busy)) && <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void make()}>New code</button>}
        <button className="rs-btn" onClick={stop}>{reused ? 'Stop scan mode' : 'Disconnect'}</button>
        <button className="rs-btn rs-btn--ghost" onClick={onClose}>Hide</button>
      </div>
    </section>
  );
}

/** "Phone connected · 3 photos received" with the on-demand preview button. */
export function PhoneScanLine({ token, hasResult, onPreview }: { token: string; hasResult: boolean; onPreview: () => void }) {
  const { io } = useApp();
  const state = usePhoneState(token);
  const [, tick] = useState(0);
  useEffect(() => io.phone.scan?.subscribe(token, () => tick((n) => n + 1)), [io, token]);
  useEffect(() => io.phone.onState((t) => { if (t === token) tick((n) => n + 1); }), [io, token]);
  const info = io.phone.scan?.info(token) ?? null;
  if (!token || !state) return null;
  const n = info?.received ?? 0;
  const text =
    state === 'connected'
      ? `Phone connected · ${n} photo${n === 1 ? '' : 's'} received${info && info.scanning ? ` · ${info.scanning} scanning` : ''}${info && info.failed ? ` · ${info.failed} need a retake` : ''}`
      : state === 'waiting'
        ? 'Waiting for the phone…'
        : LABEL[state];
  return (
    <div className={`rs-sc__phoneline${state === 'connected' ? ' is-ok' : ''}`} role="status">
      <Icon name="plug" size={12} />
      <span>{text}</span>
      {state === 'connected' && <button className="rs-btn" disabled={!hasResult} onClick={onPreview} title="Send a small looping preview of the recovered frames to the phone">Send preview to phone</button>}
    </div>
  );
}
