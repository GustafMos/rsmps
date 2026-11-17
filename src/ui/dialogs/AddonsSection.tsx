import { useCallback, useEffect, useState } from 'react';
import type { AddonInfo, Io } from '../../io/api';
import { useApp } from '../store/context';
import './addons.css';

/** The add-ons list, kept current (polled by the IO layer while something installs). `null` until the first answer. */
export function useAddons(io: Io): AddonInfo[] | null {
  const [list, setList] = useState<AddonInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    const off = io.addons.onChange((l) => live && setList(l));
    void io.addons.list().then((l) => live && setList(l));
    return () => {
      live = false;
      off();
    };
  }, [io]);
  return list;
}

/** True when the FFmpeg add-on is installed (the desktop app can then export ProRes-compatible and alpha video). */
export function ffmpegInstalled(list: AddonInfo[] | null): boolean {
  return !!list?.find((a) => a.id === 'ffmpeg' && a.state === 'installed');
}

const MB = 1024 * 1024;
const PHASE: Record<NonNullable<AddonInfo['progress']>['phase'], string> = { downloading: 'Downloading', verifying: 'Checking the checksum', extracting: 'Unpacking' };

export function progressText(p: NonNullable<AddonInfo['progress']>): string {
  if (p.phase !== 'downloading' || !p.total) return `${PHASE[p.phase]}…`;
  const pct = Math.min(100, Math.round((p.received / p.total) * 100));
  return `${PHASE[p.phase]}… ${(p.received / MB).toFixed(0)} of ${(p.total / MB).toFixed(0)} MB (${pct}%)`;
}

const SOURCE: Record<'download' | 'custom' | 'system', string> = { download: 'downloaded by RSMPS', custom: 'the one you chose', system: 'found on this computer' };

function Card({ a, io }: { a: AddonInfo; io: Io }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => ReturnType<Io['addons']['install']>, declined: string) => {
    setBusy(true);
    setNote('');
    try {
      const r = await fn();
      if (r.error) setNote(r.error);
      else if (r.declined) setNote(declined);
    } finally {
      setBusy(false);
    }
  };
  const installing = a.state === 'installing';
  const d = a.download;
  const error = note || (a.state === 'error' ? a.error : '') || '';
  return (
    <div className={`rs-addon${error ? ' has-error' : ''}`}>
      <div className="rs-addon__head">
        <span className="rs-addon__title">{a.name}</span>
        <span className={`rs-addon__state${a.state === 'installed' ? ' is-ok' : ''}`}>
          {a.state === 'installed' ? `Installed${a.installed?.version ? ` · ${a.installed.version}` : ''}` : installing ? 'Installing' : 'Optional'}
        </span>
      </div>
      <p className="rs-addon__meta">
        {a.id === 'ffmpeg'
          ? 'FFmpeg (optional): enables ProRes-compatible export and video with transparency. FFmpeg is separate software under its own license; RSMPS does not include it.'
          : a.description}
      </p>
      {a.notice && <p className="rs-addon__meta rs-addon__notice" role="note">{a.notice}</p>}
      {a.state === 'installed' && a.installed && <p className="rs-addon__meta">In use: {SOURCE[a.installed.source]}.</p>}
      {d ? (
        <>
          <p className="rs-addon__meta">
            Downloaded from {d.host} · {d.sizeLabel} · License: {d.license.name}
          </p>
          <div className="rs-addon__links">
            {a.homepage && <a href={a.homepage} target="_blank" rel="noopener noreferrer">{a.name} website</a>}
            {d.license.url && <a href={d.license.url} target="_blank" rel="noopener noreferrer">License</a>}
          </div>
          <p className="rs-addon__meta">Verified by checksum before use.</p>
        </>
      ) : (
        <>
          {a.bringYourOwn && <p className="rs-addon__meta">{a.bringYourOwn}</p>}
          {a.homepage && <div className="rs-addon__links"><a href={a.homepage} target="_blank" rel="noopener noreferrer">{a.name} website</a></div>}
        </>
      )}
      {installing && a.progress && (
        <div className="rs-dlg__progress" role="status">
          <div className="rs-dlg__bar"><div style={{ width: `${a.progress.total ? Math.min(100, (a.progress.received / a.progress.total) * 100) : 4}%` }} /></div>
          <span className="rs-addon__meta">{progressText(a.progress)}</span>
        </div>
      )}
      {error && <p className="rs-addon__err" role="alert">{error}</p>}
      <div className="rs-addon__btns">
        {installing ? (
          <button className="rs-btn" onClick={() => void io.addons.cancel(a.id)}>Cancel</button>
        ) : (
          <>
            {d && a.state !== 'installed' && <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void run(() => io.addons.install(a.id), 'Nothing was downloaded.')}>Install</button>}
            {a.canLocate && <button className="rs-btn" disabled={busy} onClick={() => void run(() => io.addons.locate(a.id), '')}>{a.id === 'ffmpeg' ? 'Use an FFmpeg already on this computer…' : `Locate ${a.name}…`}</button>}
            {a.state === 'installed' && <button className="rs-btn rs-btn--danger" disabled={busy} onClick={() => void run(() => io.addons.remove(a.id), '')}>Remove</button>}
          </>
        )}
      </div>
    </div>
  );
}

/** "Official add-ons" section of the Plugins dialog. Greyed with one sentence in the web version. */
export function AddonsSection() {
  const { io } = useApp();
  const list = useAddons(io);
  const supported = io.addons.supported;
  const retry = useCallback(() => void io.addons.list(), [io]);
  return (
    <div className={`rs-dlg__sec rs-addons${supported ? '' : ' is-off'}`} aria-disabled={!supported}>
      <span className="rs-caps">Official add-ons</span>
      {!supported ? (
        <p className="rs-dlg__note">Add-ons are available in the desktop app.</p>
      ) : list === null ? (
        <p className="rs-dlg__note">Loading…</p>
      ) : list.length === 0 ? (
        <p className="rs-dlg__note">
          No add-ons could be listed. <button className="rs-btn rs-btn--ghost" onClick={retry}>Try again</button>
        </p>
      ) : (
        list.map((a, i) => (
          <div key={a.id}>
            {a.group === 'splat-train' && list[i - 1]?.group !== 'splat-train' && (
              <p className="rs-dlg__note">
                <strong>For Splat from Video</strong>: COLMAP and Brush are separate, large programs that run on your computer. The node needs both (COLMAP or COLMAP (NVIDIA), plus Brush). Nothing is downloaded until you press Install.
              </p>
            )}
            <Card a={a} io={io} />
          </div>
        ))
      )}
    </div>
  );
}
