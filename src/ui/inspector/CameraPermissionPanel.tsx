import { useEffect, useState } from 'react';
import { useApp } from '../store/context';

type State = 'granted' | 'denied' | 'prompt' | 'unknown';

const STATUS: Record<State, string> = {
  granted: 'The camera is allowed for this site.',
  denied: 'The camera is blocked for this site.',
  prompt: 'The browser has not been asked yet, or you allowed it for one time only.',
  unknown: 'This browser does not say whether the camera is allowed.',
};

/** Inspector section of Webcam: shows whether the camera is allowed, and a button that makes the browser ask right now. */
export function CameraPermissionPanel() {
  const { io, ed } = useApp();
  const [state, setState] = useState<State>('unknown');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    let on = true;
    const read = () => void io.devices.cameraPermission().then((s) => on && setState(s));
    read();
    const off = io.devices.onChanged(read);
    const t = setInterval(read, 2000);
    return () => {
      on = false;
      off();
      clearInterval(t);
    };
  }, [io]);

  const ask = async () => {
    setBusy(true);
    setNote('');
    const r = await io.devices.askCamera();
    setBusy(false);
    setState(await io.devices.cameraPermission());
    if (r.ok) {
      setNote('The camera is allowed and has been restarted.');
      ed.toast('Camera allowed.', 'info');
    } else setNote(r.message ?? 'The camera could not be opened.');
  };
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Camera permission</div>
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={busy} onClick={() => void ask()}>
          {busy ? 'Waiting for your answer' : state === 'granted' ? 'Ask again / restart camera' : 'Allow camera'}
        </button>
      </div>
      <p className="rs-insp__hint">{note || STATUS[state]}</p>
    </div>
  );
}
