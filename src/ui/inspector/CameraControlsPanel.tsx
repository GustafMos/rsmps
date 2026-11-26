import { useEffect, useState } from 'react';
import { useDevices } from '../components/DeviceField';
import { useApp } from '../store/context';
import type { NodeInstance } from '../../engine/types';
import { cameraSource, parseCameraExtra } from '../../engine/lib/live-source';
import { fromUnit, hasTorch, modesOf, rangeOf, toUnit, type Range } from '../../io/camera-controls';
import type { CameraInfo } from '../../io/live';

const EMPTY: CameraInfo = { open: false, capabilities: {}, settings: {}, digitalZoom: 1, error: '', reducedTo: null, note: '', deviceId: '' };

const fmt = (v: number): string => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rs-insp__row">
      <label className="rs-insp__label">{label}</label>
      <div className="rs-insp__ctl">{children}</div>
    </div>
  );
}

function Slider({ label, value, min, max, step, text, disabled, onChange }: { label: string; value: number; min: number; max: number; step: number; text: string; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <div className="rs-camrange">
        <input type="range" aria-label={label} min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="rs-camrange__val">{text}</span>
      </div>
    </Row>
  );
}

/**
 * Inspector section of Webcam: the camera's own controls (zoom, torch, focus, exposure, white balance, ...), shown only for what the
 * open camera reports it can do. Everything is written to the node's params, so it is saved with the project; Zoom, Exposure comp.,
 * Focus distance and Colour temperature are also wireable params of the node (a slider whose value is wired is greyed out).
 */
export function CameraControlsPanel({ node, wired }: { node: NodeInstance; wired: ReadonlySet<string> }) {
  const { io, ed } = useApp();
  const [info, setInfo] = useState<CameraInfo>(EMPTY);
  const sourceText = JSON.stringify(cameraSource(node.params));
  useEffect(() => {
    const read = () => setInfo(io.devices.cameraInfo(JSON.parse(sourceText)));
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [io, sourceText]);

  const { devices } = useDevices('video-input');
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const camId = String(node.params.device || info.deviceId || '');
  const camName = devices.find((d) => d.id === camId)?.label ?? '';
  const zoomNow = typeof node.params.zoom === 'number' ? node.params.zoom : 1;
  const sideWord = node.params.device ? '' : node.params.facing === 'back' ? 'back' : node.params.facing === 'front' ? 'front' : '';
  const restart = async () => {
    setBusy('restart');
    const r = await io.devices.askCamera();
    setBusy('');
    setReport([r.ok ? 'The camera was restarted.' : (r.message ?? 'The camera could not be restarted.')]);
  };
  const measure = async () => {
    if (info.open && !window.confirm('Measuring opens each camera for a moment, so the picture stops briefly. Go on?')) return;
    setBusy('measure');
    const r = await io.devices.measureCameras();
    setBusy('');
    setReport([r.ok ? `Measured ${r.measured} camera${r.measured === 1 ? '' : 's'}. The names in the Camera list now say more.` : (r.message ?? 'The cameras could not be measured.')]);
  };
  const together = async () => {
    if (info.open && !window.confirm('The test opens the cameras two at a time, so the picture stops for a while. Go on?')) return;
    setBusy('test');
    setReport(['Testing the cameras two at a time, this takes a little while…']);
    const r = await io.devices.testCamerasTogether();
    setBusy('');
    setReport(r.ok ? r.lines : [r.message ?? 'The test could not run.']);
  };
  const rename = () => {
    io.devices.renameCamera(camId, draft);
    setDraft('');
  };

  const caps = info.capabilities;
  const extra = parseCameraExtra(node.params.cameraExtra) as Record<string, unknown>;
  const setExtra = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...extra, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    ed.setParam(node.id, 'cameraExtra', Object.keys(next).length ? JSON.stringify(next) : '');
  };
  const num = (key: string, d: number) => (typeof node.params[key] === 'number' ? (node.params[key] as number) : d);
  const setNum = (key: string, v: number) => ed.setParam(node.id, key, v);

  const zoom = rangeOf(caps, 'zoom');
  const comp = rangeOf(caps, 'exposureCompensation');
  const focusModes = modesOf(caps, 'focusMode');
  const expModes = modesOf(caps, 'exposureMode');
  const wbModes = modesOf(caps, 'whiteBalanceMode');
  const dist = rangeOf(caps, 'focusDistance');
  const time = rangeOf(caps, 'exposureTime');
  const temp = rangeOf(caps, 'colorTemperature');
  const unitKeys = ['iso', 'brightness', 'contrast', 'saturation', 'sharpness'] as const;
  const unitSlider = (key: (typeof unitKeys)[number], label: string) => {
    const r = rangeOf(caps, key);
    if (!r) return null;
    const u = typeof extra[key] === 'number' ? (extra[key] as number) : toUnit(typeof info.settings[key] === 'number' ? (info.settings[key] as number) : r.min, r);
    return <Slider key={key} label={label} value={u} min={0} max={1} step={0.01} text={fmt(fromUnit(u, r))} onChange={(v) => setExtra({ [key]: v })} />;
  };
  const modeSelect = (label: string, key: 'focus' | 'exposure' | 'whiteBalance', modes: string[]) =>
    modes.includes('manual') ? (
      <Row label={label}>
        <select className="rs-select" aria-label={label} value={extra[key] === 'manual' ? 'manual' : 'auto'} onChange={(e) => setExtra({ [key]: e.target.value === 'manual' ? 'manual' : undefined })}>
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
      </Row>
    ) : null;
  const rangeText = (r: Range, unit: string) => `${fmt(r.min)}${unit} to ${fmt(r.max)}${unit}`;
  const rate = typeof info.settings.frameRate === 'number' ? info.settings.frameRate : 0;
  const w = typeof info.settings.width === 'number' ? info.settings.width : 0;
  const h = typeof info.settings.height === 'number' ? info.settings.height : 0;

  const reset = () => {
    if (!wired.has('zoom')) ed.setParam(node.id, 'zoom', 1);
    if (!wired.has('exposureComp')) ed.setParam(node.id, 'exposureComp', 0);
    if (!wired.has('focusDistance')) ed.setParam(node.id, 'focusDistance', 0.5);
    if (!wired.has('colorTemp')) ed.setParam(node.id, 'colorTemp', 5000);
    ed.setParam(node.id, 'frameRate', 'auto');
    ed.setParam(node.id, 'cameraExtra', '');
  };
  const nothing = info.open && !zoom && !hasTorch(caps) && !focusModes.length && !expModes.length && !wbModes.length && !comp && !unitKeys.some((k) => rangeOf(caps, k));

  return (
    <div className="rs-insp__sec" data-camera-controls>
      <div className="rs-caps">Camera</div>
      <p className="rs-insp__hint" data-camera-status role="status">
        {info.open ? `Using ${camName || (sideWord ? `the ${sideWord} camera` : 'the default camera')} · zoom ${fmt(zoomNow)}x${w && h ? ` · ${w} × ${h}` : ''}` : 'The camera is not open right now.'}
      </p>
      {info.note && <p className="rs-insp__hint" data-camera-reduced>{info.note}.</p>}
      {info.error && <p className="rs-insp__hint" role="alert">{info.error}</p>}
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={!!busy} onClick={() => void restart()}>{busy === 'restart' ? 'Restarting…' : 'Restart camera'}</button>
        <button className="rs-btn" disabled={!!busy} onClick={() => void measure()}>{busy === 'measure' ? 'Measuring…' : 'Measure cameras'}</button>
        {devices.length >= 2 && <button className="rs-btn" disabled={!!busy} onClick={() => void together()}>{busy === 'test' ? 'Testing…' : 'Test cameras together'}</button>}
      </div>
      <Row label="Name">
        <div className="rs-camrange">
          <input className="rs-input" aria-label="Camera name" placeholder={camName || 'Name this camera'} value={draft} disabled={!camId} onChange={(e) => setDraft(e.target.value)} />
          <button className="rs-btn" disabled={!camId} onClick={rename}>{draft.trim() ? 'Name this camera' : 'Clear name'}</button>
        </div>
      </Row>
      <p className="rs-insp__hint">Browsers do not say which lens a camera is (wide, main, zoom lens). Look at the picture and name the camera yourself; the name shows in the Camera list. Measure cameras fills in what each camera reports, such as its zoom range.</p>
      {report.length > 0 && (
        <div className="rs-insp__hint" data-camera-report>
          {report.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
      <div className="rs-caps">Camera controls</div>
      {!info.open ? (
        <p className="rs-insp__hint">Start the camera to see its controls. They appear here once the camera is open, for the things it can do.</p>
      ) : (
        <>
          <p className="rs-insp__hint" data-camera-delivered>
            {rate ? `The camera delivers ${fmt(rate)} frames per second` : 'The camera does not say its frame rate'}
            {w && h ? ` at ${w} × ${h}.` : '.'}
          </p>
          <p className="rs-insp__hint">{zoom ? `Zoom: the camera does it, from ${rangeText(zoom, 'x')}.` : 'Zoom: digital (this camera has no zoom of its own, so the picture is cropped and enlarged).'}</p>
          <Slider label="Zoom" value={num('zoom', 1)} min={zoom ? zoom.min : 1} max={zoom ? zoom.max : 8} step={zoom && zoom.step ? Math.min(zoom.step, 0.1) : 0.05} text={`${fmt(num('zoom', 1))}x`} disabled={wired.has('zoom')} onChange={(v) => setNum('zoom', v)} />
          {hasTorch(caps) && (
            <Row label="Torch">
              <label className="rs-insp__check">
                <input type="checkbox" checked={!!extra.torch} onChange={(e) => setExtra({ torch: e.target.checked ? true : undefined })} /> {extra.torch ? 'On' : 'Off'}
              </label>
            </Row>
          )}
          {modeSelect('Focus', 'focus', focusModes)}
          {dist && extra.focus === 'manual' && <Slider label="Focus distance" value={num('focusDistance', 0.5)} min={0} max={1} step={0.01} text={fmt(fromUnit(num('focusDistance', 0.5), dist))} disabled={wired.has('focusDistance')} onChange={(v) => setNum('focusDistance', v)} />}
          {modeSelect('Exposure', 'exposure', expModes)}
          {time && extra.exposure === 'manual' && (
            <Slider label="Exposure time" value={typeof extra.exposureTime === 'number' ? extra.exposureTime : 0.5} min={0} max={1} step={0.01} text={fmt(fromUnit(typeof extra.exposureTime === 'number' ? extra.exposureTime : 0.5, time))} onChange={(v) => setExtra({ exposureTime: v })} />
          )}
          {comp && <Slider label="Exposure comp." value={num('exposureComp', 0)} min={comp.min} max={comp.max} step={comp.step || 0.1} text={`${fmt(num('exposureComp', 0))} EV`} disabled={wired.has('exposureComp')} onChange={(v) => setNum('exposureComp', v)} />}
          {modeSelect('White balance', 'whiteBalance', wbModes)}
          {temp && extra.whiteBalance === 'manual' && <Slider label="Colour temp." value={num('colorTemp', 5000)} min={temp.min} max={temp.max} step={temp.step || 50} text={`${fmt(num('colorTemp', 5000))} K`} disabled={wired.has('colorTemp')} onChange={(v) => setNum('colorTemp', v)} />}
          {unitSlider('iso', 'ISO')}
          {unitSlider('brightness', 'Brightness')}
          {unitSlider('contrast', 'Contrast')}
          {unitSlider('saturation', 'Saturation')}
          {unitSlider('sharpness', 'Sharpness')}
          {nothing && <p className="rs-insp__hint">This camera offers no controls of its own beyond a frame rate request. Zoom is done in the picture.</p>}
        </>
      )}
      <div className="rs-insp__actions">
        <button className="rs-btn" onClick={reset}>Reset camera controls</button>
      </div>
    </div>
  );
}
