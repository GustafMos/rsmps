import { useEffect, useState } from 'react';
import { CheckField } from '../components/fields';
import { Dialog } from '../dialogs/Dialog';
import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { openFeature } from '../store/features';
import { getLive } from '../store/live';
import { STREAM_QUALITIES, loadStreamSettings, qualityOf, saveStreamSettings, streamClock, type StreamService, type StreamSettings } from '../store/stream';

const SERVICES: { id: StreamService; label: string; keyHelp: string }[] = [
  { id: 'twitch', label: 'Twitch', keyHelp: 'Twitch: Creator Dashboard > Settings > Stream > Primary Stream key.' },
  { id: 'youtube', label: 'YouTube', keyHelp: 'YouTube Studio: Go live > Stream > Stream key. The broadcast starts when YouTube receives the picture.' },
  { id: 'custom', label: 'Other (RTMP)', keyHelp: 'Any service or server that takes RTMP: paste its address, and the stream key if it has a separate one.' },
];

/** Go live: where to, in what quality, and the state of a running stream. Desktop app only (the menu entry is hidden elsewhere). */
export function GoLiveDialog() {
  const app = useApp();
  const { io, ed } = app;
  const stream = getLive(app).stream;
  const ui = useSelector(stream.store, (s) => s);
  const [settings, setSettings] = useState<StreamSettings>(() => loadStreamSettings());
  const [ffmpeg, setFfmpeg] = useState<boolean | null>(null);
  const close = () => openFeature(null);
  const set = (patch: Partial<StreamSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const q = qualityOf(settings.quality);
  const svc = SERVICES.find((s) => s.id === settings.service) ?? SERVICES[0];
  const busy = ui.phase !== 'idle';

  useEffect(() => {
    let alive = true;
    void io.stream.info().then((i) => alive && setFfmpeg(i.available), () => alive && setFfmpeg(false));
    return () => {
      alive = false;
    };
  }, [io]);

  const go = async () => {
    saveStreamSettings(settings);
    await stream.start(settings);
  };
  const ready = ffmpeg === true && (settings.service === 'custom' ? settings.url.trim().length > 0 : settings.key.trim().length > 0);

  return (
    <Dialog
      title="Go live"
      onClose={close}
      width={520}
      footer={
        <>
          <button className="rs-btn" onClick={close}>{busy ? 'Hide' : 'Close'}</button>
          {busy ? (
            <button className="rs-btn rs-btn--primary" disabled={ui.phase === 'stopping'} onClick={() => void stream.stop()}>
              {ui.phase === 'stopping' ? 'Stopping…' : 'End stream'}
            </button>
          ) : (
            <button className="rs-btn rs-btn--primary" disabled={!ready} onClick={() => void go()}>Go live</button>
          )}
        </>
      }
    >
      {ffmpeg === false && (
        <div className="rs-dlg__sec" role="alert">
          <p className="rs-dlg__note">Going live uses the FFmpeg add-on, which is not installed yet.</p>
          <div className="rs-dlg__row">
            <button className="rs-btn" onClick={() => { close(); ed.openDialog('plugins'); }}>Install FFmpeg…</button>
          </div>
        </div>
      )}
      {busy ? (
        <div className="rs-dlg__sec">
          <span className="rs-caps">{ui.phase === 'starting' ? 'Connecting' : 'On air'}</span>
          <p className="rs-dlg__note">
            {SERVICES.find((s) => s.id === ui.service)?.label ?? 'Stream'} · {streamClock(ui.seconds)}
            {ui.kbps > 0 ? ` · ${(ui.kbps / 1000).toFixed(1)} Mbit/s` : ''}
            {ui.fps > 0 ? ` · ${Math.round(ui.fps)} fps` : ''}
          </p>
          {(ui.behind || (ui.speed > 0 && ui.speed < 0.9)) && (
            <p className="rs-dlg__note" role="alert">The computer or the connection is not keeping up: viewers will see stutter. End the stream and pick a smaller size or a lower bitrate.</p>
          )}
          <p className="rs-dlg__note">The stream shows what the viewer shows. Keep this window visible: a minimised window stops drawing.</p>
        </div>
      ) : (
        <>
          <div className="rs-dlg__sec">
            <span className="rs-caps">Where to</span>
            <div className="rs-dlg__seg">
              {SERVICES.map((s) => (
                <button key={s.id} className={`rs-btn${settings.service === s.id ? ' is-on' : ''}`} onClick={() => set({ service: s.id })}>{s.label}</button>
              ))}
            </div>
            {settings.service === 'custom' && (
              <input className="rs-input" type="text" spellCheck={false} placeholder="rtmp://server/app" aria-label="Stream address" value={settings.url} onChange={(e) => set({ url: e.target.value })} />
            )}
            <input className="rs-input" type="password" autoComplete="off" spellCheck={false} placeholder={settings.service === 'custom' ? 'Stream key (if separate)' : 'Stream key'} aria-label="Stream key" value={settings.key} onChange={(e) => set({ key: e.target.value })} />
            <p className="rs-dlg__note">{svc.keyHelp} The key is like a password to your channel: it goes only to FFmpeg on this computer.</p>
            <CheckField value={settings.remember} onChange={(v) => set({ remember: v })} label="Remember the key on this computer" />
          </div>
          <div className="rs-dlg__sec">
            <span className="rs-caps">Quality</span>
            <select className="rs-select" aria-label="Stream size" value={settings.quality} onChange={(e) => set({ quality: e.target.value, kbps: 0 })}>
              {STREAM_QUALITIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <label className="rs-dlg__note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Video bitrate
              <input className="rs-input" style={{ width: 90 }} type="number" min={200} max={51000} step={100} aria-label="Video bitrate in kilobits per second" value={settings.kbps || q.kbps} onChange={(e) => set({ kbps: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              kbit/s
            </label>
            <p className="rs-dlg__note">The picture is fitted into {q.width} × {q.height} with black bars where it has another shape. Sound is included when audio is on (Enable audio).</p>
          </div>
          {ui.error && <p className="rs-dlg__note" role="alert">Last stream: {ui.error}</p>}
        </>
      )}
    </Dialog>
  );
}

/** Transport: "Go live" in the desktop app, a red clock while on air. Nothing in the web version. */
export function GoLiveButton() {
  const app = useApp();
  const stream = getLive(app).stream;
  const ui = useSelector(stream.store, (s) => s);
  if (!stream.supported) return null;
  if (ui.phase === 'idle') {
    return (
      <button className="rs-btn" onClick={() => openFeature('golive')} title="Stream the output with its sound to Twitch, YouTube or any RTMP address">
        Go live
      </button>
    );
  }
  return (
    <button className="rs-btn rs-tp__live" onClick={() => openFeature('golive')} title="On air. Click for details or to end the stream.">
      <span className="rs-tp__livedot" /> LIVE {streamClock(ui.seconds)}
    </button>
  );
}
