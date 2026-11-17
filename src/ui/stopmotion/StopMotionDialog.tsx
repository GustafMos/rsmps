import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_FRAMES, addFrame, deleteFrame, duplicateFrame, emptyStrip, frameAtTime, frameName, moveFrame, nextTakeName, normalizePlan, onionFrames, onionWeights, runtime, setHold, setShootOn, timelapseDue, timelineIds, type SmStrip } from '../../io/stopmotion';
import { Dialog } from '../dialogs/Dialog';
import { useApp } from '../store/context';
import { openFeature } from '../store/features';
import './stopmotion.css';

interface Shot {
  blob: Blob;
  url: string;
}

/** Camera support facts for the "lock exposure and focus" report. */
function lockReport(track: MediaStreamTrack | null): string {
  if (!track) return '';
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const has = (k: string, v: string) => Array.isArray(caps[k]) && (caps[k] as string[]).includes(v);
  const parts = [`exposure lock: ${has('exposureMode', 'manual') ? 'available' : 'not offered by this camera'}`, `focus lock: ${has('focusMode', 'manual') ? 'available' : 'not offered by this camera'}`];
  return parts.join(', ');
}

/** Stop-motion capture from a webcam (or any camera the browser offers): onion skin, filmstrip, holds, timelapse, preview. Nothing leaves the machine. */
export function StopMotionDialog() {
  const { io, ed } = useApp();
  const close = () => openFeature(null);
  const video = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shots = useRef(new Map<string, Shot>());
  const counter = useRef(0);
  const fps = ed.state.graph.project.fps || 12;

  const [strip, setStrip] = useState<SmStrip>(() => emptyStrip(2));
  const [cam, setCam] = useState<{ state: 'off' | 'starting' | 'on' | 'error'; message?: string }>({ state: 'off' });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [onion, setOnion] = useState({ count: 2, opacity: 0.5, diff: false });
  const [grid, setGrid] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [timelapse, setTimelapse] = useState({ on: false, interval: 5, max: 0 });
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [lock, setLock] = useState('');
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const stripRef = useRef(strip);
  stripRef.current = strip;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (video.current) video.current.srcObject = null;
    setCam({ state: 'off' });
  }, []);
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      for (const s of shots.current.values()) URL.revokeObjectURL(s.url);
      shots.current.clear();
    },
    [],
  );

  const startCamera = async (id = deviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) return setCam({ state: 'error', message: 'This browser has no camera access.' });
    stopCamera();
    setCam({ state: 'starting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
      }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
      setLock(lockReport(stream.getVideoTracks()[0] ?? null));
      setCam({ state: 'on' });
    } catch (err) {
      setCam({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const capture = useCallback(async () => {
    const v = video.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!v || !track || stripRef.current.frames.length >= MAX_FRAMES) return;
    let blob: Blob | null = null;
    // Full-resolution still where the browser offers it (ImageCapture), else the current video frame
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (IC) {
      try {
        blob = await new IC(track).takePhoto();
      } catch {
        blob = null;
      }
    }
    if (!blob) {
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 1280;
      c.height = v.videoHeight || 720;
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.92));
    }
    if (!blob) return;
    const id = `sm${++counter.current}`;
    shots.current.set(id, { blob, url: URL.createObjectURL(blob) });
    setStrip((s) => addFrame(s, id));
    setNow(stripRef.current.frames.length + 1);
  }, []);

  // keyboard shutter: Space or Enter while the dialog is focused (volume keys are not exposed to web pages)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON') return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void capture();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [capture]);

  // timelapse: shots on a fixed grid
  useEffect(() => {
    if (!timelapse.on || cam.state !== 'on') return;
    const plan = normalizePlan({ interval: timelapse.interval, maxShots: timelapse.max });
    const t0 = Date.now();
    let taken = 0;
    const id = setInterval(() => {
      const d = timelapseDue(plan, t0, taken, Date.now());
      if (d.done) {
        setTimelapse((t) => ({ ...t, on: false }));
        return;
      }
      if (d.due) {
        taken++;
        void capture();
      }
    }, 200);
    return () => clearInterval(id);
  }, [timelapse.on, timelapse.interval, timelapse.max, cam.state, capture]);

  // preview at the project fps
  const [t0] = useState(() => ({ at: 0 }));
  useEffect(() => {
    if (!playing) return;
    t0.at = performance.now();
    const id = setInterval(() => bump((n) => n + 1), 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [playing, fps, t0]);

  const frames = strip.frames;
  const playIndex = playing ? frameAtTime(strip, fps, (performance.now() - t0.at) / 1000) : -1;
  const ghosts = onionFrames(frames.length, Math.min(now, frames.length), onion.count);
  const weights = onionWeights(onion.count, onion.opacity);
  const rt = runtime(strip, fps);

  const applyLock = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual', focusMode: 'manual' } as unknown as MediaTrackConstraintSet] });
      ed.toast('Exposure and focus locked (as far as the camera allows).', 'ok');
    } catch {
      ed.toast('This camera does not allow locking exposure or focus from the browser.', 'info');
    }
  };

  const finish = async (openAfter: boolean) => {
    if (!frames.length) return;
    setBusy(true);
    try {
      const blobs = timelineIds(strip).map((id) => shots.current.get(id)!.blob);
      const name = nextTakeName(io.library.list().map((a) => a.name));
      const info = await io.library.addSequence(name, blobs, fps);
      ed.toast(`Saved "${name}" to the media library (${blobs.length} frames at ${fps} fps).`, 'ok');
      stopCamera();
      close();
      if (openAfter) await ed.openAssetInNewProject(info.id, name);
    } catch (err) {
      ed.toast(`Could not save the sequence: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Stop-motion capture"
      onClose={() => { stopCamera(); close(); }}
      width={760}
      footer={
        <>
          <span className="rs-sm__note" style={{ flex: 1 }}>{frames.length} drawings, {rt.frames} frames, {rt.seconds.toFixed(1)} s at {fps} fps</span>
          <button className="rs-btn" disabled={!frames.length || busy} onClick={() => void finish(false)}>Save to library</button>
          <button className="rs-btn rs-btn--primary" disabled={!frames.length || busy} onClick={() => void finish(true)}>Save and open</button>
        </>
      }
    >
      <div className="rs-sm">
        <div className="rs-sm__stage">
          <video ref={video} className={mirror ? 'is-mirror' : ''} muted playsInline />
          {cam.state === 'on' && ghosts.map((fi, k) => (
            <img key={frames[fi].id} className={`rs-sm__ghost${onion.diff ? ' is-diff' : ''}`} src={shots.current.get(frames[fi].id)?.url} alt="" style={{ opacity: weights[k] }} />
          ))}
          {playing && playIndex >= 0 && <img className="rs-sm__play" src={shots.current.get(frames[playIndex].id)?.url} alt="Preview" style={{ background: '#000' }} />}
          {grid && <><div className="rs-sm__grid" /><div className="rs-sm__level" /></>}
          {cam.state !== 'on' && !playing && (
            <div className="rs-sm__empty">
              {cam.state === 'error' ? <div role="alert">{cam.message}</div> : cam.state === 'starting' ? 'Starting the camera…' : (
                <div>
                  <p>Put the camera on a tripod, start it, and press Space to take a picture.<br />Everything stays on this computer.</p>
                  <button className="rs-btn rs-btn--primary" onClick={() => void startCamera()}>Start camera</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rs-sm__row">
          <button className="rs-btn rs-btn--primary rs-sm__shutter" disabled={cam.state !== 'on'} onClick={() => void capture()} title="Space or Enter">Capture</button>
          <button className="rs-btn" disabled={!frames.length} onClick={() => setPlaying((p) => !p)}>{playing ? 'Stop preview' : 'Preview'}</button>
          <label>Shoot on
            <select value={strip.shootOn} onChange={(e) => setStrip((s) => setShootOn(s, Number(e.target.value)))}>
              <option value={1}>ones</option><option value={2}>twos</option><option value={3}>threes</option>
            </select>
          </label>
          {devices.length > 1 && (
            <label>Camera
              <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); void startCamera(e.target.value); }}>
                {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
              </select>
            </label>
          )}
          {cam.state === 'on' && <button className="rs-btn rs-btn--ghost" onClick={stopCamera}>Stop camera</button>}
        </div>

        <div className="rs-sm__row">
          <label>Onion skin
            <select value={onion.count} onChange={(e) => setOnion((o) => ({ ...o, count: Number(e.target.value) }))}>
              <option value={0}>off</option><option value={1}>1 frame</option><option value={2}>2 frames</option><option value={3}>3 frames</option>
            </select>
          </label>
          <label>Opacity <input type="range" min={0.1} max={1} step={0.05} value={onion.opacity} onChange={(e) => setOnion((o) => ({ ...o, opacity: Number(e.target.value) }))} /></label>
          <label><input type="checkbox" checked={onion.diff} onChange={(e) => setOnion((o) => ({ ...o, diff: e.target.checked }))} /> Ghost difference</label>
          <label><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> Grid and level</label>
          <label><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror</label>
        </div>

        <div className="rs-sm__row">
          <label><input type="checkbox" checked={timelapse.on} disabled={cam.state !== 'on'} onChange={(e) => setTimelapse((t) => ({ ...t, on: e.target.checked }))} /> Capture every</label>
          <input className="rs-input rs-sm__hold rs-sm__wide" type="number" min={0.5} step={0.5} value={timelapse.interval} onChange={(e) => setTimelapse((t) => ({ ...t, interval: Number(e.target.value) }))} aria-label="Seconds between pictures" /> s
          <label>stop after <input className="rs-input rs-sm__hold rs-sm__wide" type="number" min={0} value={timelapse.max} onChange={(e) => setTimelapse((t) => ({ ...t, max: Number(e.target.value) }))} aria-label="Number of pictures (0 = until stopped)" /> (0 = no limit)</label>
          <button className="rs-btn" disabled={cam.state !== 'on'} onClick={() => void applyLock()} title={lock}>Lock exposure and focus</button>
        </div>
        {lock && <p className="rs-sm__note">Camera: {lock}</p>}

        <div className="rs-sm__film" role="list" aria-label="Drawings">
          {frames.length === 0 && <span className="rs-sm__note" style={{ padding: 'var(--s-3)' }}>No pictures yet. {frameName('take', 1)} will be the first.</span>}
          {frames.map((f, i) => (
            <div key={f.id} role="listitem" className={`rs-sm__frame${i === now - 1 ? ' is-now' : ''}`}>
              <img src={shots.current.get(f.id)?.url} alt={frameName('take', i + 1)} onClick={() => setNow(i + 1)} />
              <span className="rs-num">{i + 1}</span>
              <div className="rs-sm__tools">
                <button className="rs-btn" title="Move left" disabled={i === 0} onClick={() => setStrip((s) => moveFrame(s, i, i - 1))}>‹</button>
                <button className="rs-btn" title="Move right" disabled={i === frames.length - 1} onClick={() => setStrip((s) => moveFrame(s, i, i + 1))}>›</button>
                <button className="rs-btn" title="Duplicate" onClick={() => { const id = `sm${++counter.current}`; const src = shots.current.get(f.id)!; shots.current.set(id, { blob: src.blob, url: URL.createObjectURL(src.blob) }); setStrip((s) => duplicateFrame(s, f.id, id)); }}>+</button>
                <button className="rs-btn rs-btn--danger" title="Delete" onClick={() => { setStrip((s) => deleteFrame(s, f.id)); setNow((n) => Math.max(0, Math.min(n, frames.length - 1))); }}>×</button>
              </div>
              <input className="rs-input rs-sm__hold" type="number" min={1} max={24} placeholder={String(strip.shootOn)} value={f.hold ?? ''} title="Frames this drawing is shown for (empty = shoot on)" aria-label={`Hold of drawing ${i + 1}`} onChange={(e) => setStrip((s) => setHold(s, f.id, e.target.value === '' ? null : Number(e.target.value)))} />
            </div>
          ))}
        </div>
        <p className="rs-sm__note">Saves a picture sequence to the media library at the project frame rate. Phone as a tripod camera is not part of this panel yet: use the Phone Camera node to see it live.</p>
      </div>
    </Dialog>
  );
}
