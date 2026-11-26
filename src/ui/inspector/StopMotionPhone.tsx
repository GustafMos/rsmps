import { useEffect, useState } from 'react';
import type { PhoneAddress, PhoneSessionInfo } from '../../io/api';
import { phoneSteps } from '../../io/phone';
import { thirdStepLabel } from '../../phone/link-modes';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive } from '../store/live';
import { CopyCode, useCountdown, usePhoneDetail, usePhoneProgress, usePhoneState } from './PhonePanel';

/**
 * "Shoot with a linked phone" in the Stop Motion panel. Reuses a phone that is already linked (the page switches to the stop motion mode,
 * no second QR code), otherwise makes a code with the same QR, address list and progress ticks as the Phone Camera. While it is linked the
 * computer's Take picture, Undo last and Start auto shoot drive the phone, and every picture lands in this node.
 */
export function StopMotionPhone({ id }: { id: string }) {
  const app = useApp();
  const { io } = app;
  const sm = getLive(app).stopMotion;
  const ui = useSelector(sm.store, (s) => s);
  const mine = ui.nodeId === id ? ui.phone : null;
  const token = mine?.token ?? '';
  const state = usePhoneState(token);
  const detail = usePhoneDetail(token);
  const progress = usePhoneProgress(token);
  const [info, setInfo] = useState<PhoneSessionInfo | null>(null);
  const [addrs, setAddrs] = useState<PhoneAddress[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reused, setReused] = useState(false);
  const expires = token && state === 'waiting' ? io.phone.expiresAt(token) ?? info?.expiresAt ?? null : null;
  const left = useCountdown(expires, state === 'waiting');
  const available = sm.phoneAvailable();

  useEffect(() => {
    let live = true;
    if (available) void io.phone.addresses().then((a) => { if (live) { setAddrs(a); setAddress((cur) => cur || a[0]?.url || ''); } }).catch(() => undefined);
    return () => { live = false; };
  }, [io, available]);

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
      const s = await io.phone.createSession({ ...(addr ? { address: addr } : {}), mode: 'stopmotion' });
      setInfo(s);
      setReused(false);
      sm.linkPhone(id, s.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    const linked = io.phone.linked?.() ?? null;
    if (linked) {
      io.phone.setMode?.(linked, 'stopmotion'); // the phone page switches to the capture screen; no second QR code
      setReused(true);
      sm.linkPhone(id, linked);
    } else void make();
  };

  const stop = () => {
    if (token) {
      if (reused) io.phone.setMode?.(token, 'camera');
      else io.phone.close(token);
    }
    sm.unlinkPhone();
    setInfo(null);
  };

  if (!available) {
    return (
      <>
        <div className="rs-caps">Shoot with a linked phone</div>
        <p className="rs-insp__hint">Using a phone as the camera needs the desktop app, or the web version started with <code>npm run dev:lan</code>. Then the phone takes the pictures and they arrive here as shots.</p>
      </>
    );
  }
  if (!mine || mine.state === 'off') {
    return (
      <>
        <div className="rs-caps">Shoot with a linked phone</div>
        <div className="rs-insp__actions">
          <button className="rs-btn" disabled={busy} onClick={start} title="The phone becomes the camera: shots taken on it land in this Stop Motion">
            Shoot with a linked phone
          </button>
        </div>
        {err && <p className="rs-insp__warn" role="alert">{err}</p>}
      </>
    );
  }
  const link = token ? io.phone.link?.(token) ?? null : null;
  const connected = mine.state === 'connected';
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const text = connected
    ? `Phone connected · ${mine.received} shot${mine.received === 1 ? '' : 's'} received${mine.arriving !== null ? ` · receiving ${Math.round(mine.arriving * 100)}%` : ''}${mine.unsent ? ` · ${mine.unsent} on the phone still to send` : ''}`
    : mine.state === 'dropped'
      ? 'Phone not connected. Open the link on it again. You can still shoot here.'
      : state === 'waiting'
        ? `Waiting for the phone · code expires in ${mm}`
        : state === 'expired'
          ? 'Code expired'
          : 'Waiting for the phone to open stop motion…';
  return (
    <>
      <div className="rs-caps">Shoot with a linked phone</div>
      <div className={`rs-phone__status${connected ? ' is-ok' : ''}`} role="status">{text}</div>
      {connected && mine.note && <p className="rs-insp__hint">{mine.note}</p>}
      {token && state && state !== 'expired' && !connected && (
        <ol className="rs-phone__steps" aria-label="Progress">
          {(['Reached your computer', 'Code accepted', thirdStepLabel(link?.mode ?? 'stopmotion', link?.media ?? null)] as const).map((label, i) => {
            const ok = phoneSteps(progress, state)[i];
            return <li key={label} className={ok ? 'is-done' : ''}><Icon name={ok ? 'check' : 'more'} size={16} />{label}</li>;
          })}
        </ol>
      )}
      {err && <p className="rs-insp__warn" role="alert">{err}</p>}
      {token && state && detail && !connected && <p className="rs-insp__hint">{detail}</p>}
      {addrs.length > 1 && !reused && !connected && (
        <label className="rs-phone__addr">
          <span className="rs-insp__hint">Address the phone will use</span>
          <select className="rs-select" value={address} aria-label="Address the phone will use" onChange={(e) => { setAddress(e.target.value); if (token) void make(e.target.value); }}>
            {addrs.map((a) => <option key={a.url} value={a.url}>{a.label}</option>)}
          </select>
        </label>
      )}
      {info && info.token === token && state === 'waiting' && (
        <>
          <div className="rs-phone__qr" aria-label="QR code to scan with the phone" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
          <CopyCode text={info.url} />
          <p className="rs-insp__hint">Your phone will warn that the connection is not private. Choose Advanced, then Proceed: it is your own computer.</p>
        </>
      )}
      {connected && (
        <p className="rs-insp__hint">
          The buttons below now work the phone: Take picture is its shutter and Start auto shoot runs on the phone. Each picture lands here as a shot, and Undo last takes it out again. The phone shows the previous shot faintly over its camera, and a tick on each shot once it is saved here. The phone and this panel share Shot size, Onion skin and the auto shoot settings.
        </p>
      )}
      <div className="rs-insp__actions">
        {(state === 'expired' || state === 'disconnected') && <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void make()}>New code</button>}
        <button className="rs-btn" onClick={stop}>{reused ? 'Stop using the phone' : 'Disconnect'}</button>
      </div>
    </>
  );
}
