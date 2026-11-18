import { useEffect, useState } from 'react';
import { useApp } from '../store/context';

const KEY = 'rsmps.ui.audioOutput';
const read = (): string => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** What to show for a stored device that is not in the list right now (unplugged, or names not readable yet). */
export function outputOptions(devices: readonly { id: string; label: string }[], chosen: string): { id: string; label: string }[] {
  const list = [{ id: '', label: 'System default' }, ...devices];
  return chosen && !devices.some((d) => d.id === chosen) ? [...list, { id: chosen, label: 'Chosen device (not connected)' }] : list;
}

/**
 * Where the app's sound plays. Pointing it at a virtual audio cable (VB-Cable, BlackHole, a PipeWire / PulseAudio null sink)
 * makes the processed sound a microphone for other programs: a call, a stream, a recorder. Shown only where the browser can
 * choose an output device (desktop Chrome and Edge, the desktop app); the choice is remembered.
 */
export function AudioOutputSelect() {
  const { io, ed } = useApp();
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [chosen, setChosen] = useState(read);
  const can = io.devices.canChooseAudioOutput();

  useEffect(() => {
    if (!can) return;
    let alive = true;
    const refresh = () => void io.devices.list('audio-output').then((d) => alive && setDevices(d));
    refresh();
    const off = io.devices.onChanged(refresh);
    if (read()) void io.devices.setAudioOutput(read()); // the remembered device, from the first sound on
    return () => {
      alive = false;
      off();
    };
  }, [io, can]);

  if (!can) return null;
  const pick = async (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private window: the choice lasts until reload */
    }
    const ok = await io.devices.setAudioOutput(id);
    if (!ok) ed.toast('Could not play to that device. The sound stays on the system default.', 'error');
  };
  return (
    <select
      className="rs-select rs-tp__out"
      value={chosen}
      aria-label="Play sound to"
      title="Where the sound plays. Choose a virtual audio cable (VB-Cable, BlackHole) to use the processed sound as the microphone of another program, such as a call or a stream."
      onChange={(e) => void pick(e.target.value)}
    >
      {outputOptions(devices, chosen).map((d) => (
        <option key={d.id} value={d.id}>
          {d.id ? d.label : 'Play to: system default'}
        </option>
      ))}
    </select>
  );
}
