import { useEffect, useMemo, useRef, useState } from 'react';
import { COVERAGE_MEANING } from '../../engine/lib/scan-coverage';
import type { PhoneAddress, PhoneSessionInfo } from '../../io/api';
import { phoneSteps } from '../../io/phone';
import { thirdStepLabel } from '../../phone/link-modes';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';
import { LinkedScanRun, linkPhoneForScan3d } from '../store/scan3dLink';
import { CoverageMap } from './CoverageMap';
import { CopyCode, useCountdown, usePhoneDetail, usePhoneProgress, usePhoneState } from './PhonePanel';

const LABEL = { waiting: 'Waiting for phone', connected: 'Phone connected', disconnected: 'Phone disconnected', expired: 'Code expired' } as const;

/** The phone's per-direction states (0 not reachable, 1 missing, 2 thin, 3 covered) in the form the map component takes. */
export function mapInputs(cells: number[]): { counts: number[]; reachable: boolean[] } {
  return { counts: cells.map((c) => (c === 3 ? 2 : c === 2 ? 1 : 0)), reachable: cells.map((c) => c !== 0) };
}

/**
 * "Scan with a linked phone" on the 3D Scan node (experimental). Reuses a phone that is already linked (it is switched to 3D scan mode,
 * as the paper Scan tab does) or shows a QR code. While the phone scans it shows what the phone reports: photos received, coverage, the
 * map, the advice line and the phone's readout. The scan is written into this node when the phone finishes (one undo step).
 */
export function Scan3dLinkPanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const app = useApp();
  const { io } = app;
  const [token, setToken] = useState('');
  const [reused, setReused] = useState(false);
  const [info, setInfo] = useState<PhoneSessionInfo | null>(null);
  const [addrs, setAddrs] = useState<PhoneAddress[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const run = useRef<LinkedScanRun | null>(null);
  const state = usePhoneState(token);
  const detail = usePhoneDetail(token);
  const progress = usePhoneProgress(token);
  const mine = info && info.token === token ? info : null;
  const left = useCountdown(token && state === 'waiting' ? io.phone.expiresAt(token) ?? mine?.expiresAt ?? null : null, state === 'waiting');

  useEffect(() => {
    let live = true;
    void io.phone.addresses().then((a) => {
      if (live) {
        setAddrs(a);
        setAddress((cur) => cur || a[0]?.url || '');
      }
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [io]);

  const connect = async (addr: string = address, closeOld = true) => {
    setBusy(true);
    setErr('');
    try {
      if (closeOld && token && !reused) io.phone.close(token);
      const l = await linkPhoneForScan3d(io, addr || undefined);
      setToken(l.token);
      setReused(l.reused);
      setInfo(l.session ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // On open: reuse a phone that is already linked, else make a code
  useEffect(() => {
    if (io.phone.available) void connect(address, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // watch this phone's scan and write the result into the node when it ends
  useEffect(() => {
    if (!token) return;
    const r = new LinkedScanRun(app, nodeId, token);
    run.current = r;
    const off = r.onChange(() => tick((n) => n + 1));
    r.start();
    return () => {
      off();
      r.dispose();
      run.current = null;
    };
  }, [app, nodeId, token]);

  useEffect(() => io.phone.scan3d?.subscribe(token, () => tick((n) => n + 1)), [io, token]);

  const scan = token ? io.phone.scan3d?.info(token) ?? null : null;
  const outcome = run.current?.outcome ?? null;
  const st = scan?.status ?? null;
  const map = useMemo(() => (st ? mapInputs(st.cells) : null), [st]);
  const link = token ? io.phone.link?.(token) ?? null : null;
  const connected = state === 'connected';
  const inScan3d = connected && link?.mode === 'scan3d';
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const finish = () => {
    // closing the panel while photos are still held writes what arrived, so nothing is lost
    if (scan && scan.received > 0 && !outcome) void run.current?.keepWhatArrived();
    if (token) {
      if (reused) io.phone.setMode?.(token, 'camera');
      else io.phone.close(token);
    }
    onClose();
  };

  return (
    <section className="rs-sc__phone" aria-label="Scan with a linked phone">
      <div className="rs-caps">Scan with a linked phone (experimental)</div>
      <div className={`rs-phone__status${connected ? ' is-ok' : ''}`} role="status">
        {!token || !state ? (busy ? 'Starting the link…' : 'Not linked') : state === 'waiting' ? `${LABEL.waiting} · code expires in ${mm}` : LABEL[state]}
      </div>
      {token && state && state !== 'expired' && (
        <ol className="rs-phone__steps" aria-label="Progress">
          {(['Reached your computer', 'Code accepted', thirdStepLabel(link?.mode ?? 'scan3d', link?.media ?? null)] as const).map((label, i) => {
            const ok = phoneSteps(progress, state)[i];
            return (
              <li key={label} className={ok ? 'is-done' : ''}>
                <Icon name={ok ? 'check' : 'more'} size={16} />
                {label}
              </li>
            );
          })}
        </ol>
      )}
      {err && <p className="rs-insp__warn" role="alert">{err}</p>}
      {token && state && detail && !connected && <p className="rs-insp__hint">{detail}</p>}
      {addrs.length > 1 && !reused && (
        <label className="rs-phone__addr">
          <span className="rs-insp__hint">Address the phone will use</span>
          <select className="rs-select" value={address} aria-label="Address the phone will use" onChange={(e) => { setAddress(e.target.value); void connect(e.target.value); }}>
            {addrs.map((a) => <option key={a.url} value={a.url}>{a.label}</option>)}
          </select>
        </label>
      )}
      {mine && state !== 'expired' && !connected && (
        <>
          <div className="rs-phone__qr" aria-label="QR code to scan with the phone" dangerouslySetInnerHTML={{ __html: mine.qrSvg }} />
          <CopyCode text={mine.url} />
          <p className="rs-insp__hint">The phone must open this link in Chrome. It will warn that the connection is not private (it is your own computer): choose Advanced, then Proceed. AR does not start until Chrome has accepted that certificate.</p>
        </>
      )}
      {connected && !inScan3d && <p className="rs-insp__hint">Switching the phone to 3D scan mode…</p>}
      {inScan3d && scan?.support && scan.support.state !== 'ok' && <p className="rs-insp__warn" role="alert">{scan.support.message}</p>}
      {inScan3d && !st && !scan?.received && (!scan?.support || scan.support.state === 'ok') && (
        <p className="rs-insp__hint">On the phone: press Start 3D scan. Aim at the surface next to the object and tap, make the dome fit the object, press Start, then walk slowly round it. Photos are taken by themselves and arrive here as they are taken.</p>
      )}
      {(st || (scan?.received ?? 0) > 0) && (
        <div role="status" aria-live="polite">
          <p className="rs-insp__hint">
            <b>{scan!.received} of {Math.max(scan!.kept, scan!.received)} photos received</b>
            {st ? ` · coverage ${Math.round(st.coverage * 100)}%` : ''}
            {st && st.rejected ? ` · ${st.rejected} left out for being blurry` : ''}
            {scan!.linkLost ? ' · link lost, waiting for the phone to come back' : ''}
          </p>
          {st && map && <CoverageMap grid={st.grid} counts={map.counts} reachable={map.reachable} />}
          {st && <p className="rs-insp__hint">{st.sending ? 'Sending photos… ' : ''}{st.guidance}</p>}
          {st && <p className="rs-insp__hint">{`Phone: ${st.depth ? 'depth: yes' : 'depth: no'}${st.depth ? ` (${st.depthShots} photos with depth)` : ''} · ${st.picture ? `photo ${st.picture.width}x${st.picture.height}` : 'no photo yet'}`}</p>}
          {st && <p className="rs-insp__hint">Across: all the way round the object. Up: from low to the top. Red: no photo from there yet. Green: covered. Grey: cannot be reached. {COVERAGE_MEANING}</p>}
        </div>
      )}
      {outcome && <p className="rs-insp__hint" role="status"><b>{outcome.message}</b></p>}
      <div className="rs-insp__actions">
        {!outcome && inScan3d && st && st.phase !== 'done' && <button className="rs-btn rs-btn--primary" onClick={() => run.current?.stop()} title="Asks the phone to finish: the photos still on their way arrive, then the scan is saved into this node">Finish scan</button>}
        {!outcome && (scan?.received ?? 0) > 0 && <button className="rs-btn" onClick={() => void run.current?.keepWhatArrived()} title="Save the photos that are here now into this node, without waiting for the phone">Keep what arrived ({scan!.received})</button>}
        {(state === 'expired' || state === 'disconnected' || (!token && !busy)) && !outcome && (scan?.received ?? 0) === 0 && <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void connect()}>New code</button>}
        <button className="rs-btn" onClick={finish}>{outcome ? 'Close' : reused ? 'Stop 3D scan mode' : 'Disconnect'}</button>
      </div>
    </section>
  );
}
