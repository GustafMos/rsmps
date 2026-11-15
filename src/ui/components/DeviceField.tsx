import { useEffect, useState } from 'react';
import type { AudioDevice } from '../../engine/audio/api';
import { useIo } from '../store/context';

const EMPTY_LABEL = { 'audio-input': 'System default', 'midi-input': 'All devices' } as const;
const GENERIC = /^(microphone|audio input|midi input|input|default)?\s*\d*$/i;

/** Live device list; refreshes when devices are plugged in or out. */
export function useDevices(kind: 'audio-input' | 'midi-input'): { devices: AudioDevice[]; generic: boolean } {
  const io = useIo();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => {
      io.audio
        .listDevices(kind)
        .then((d) => live && setDevices(d))
        .catch(() => live && setDevices([]));
    };
    load();
    const off = io.audio.onDevicesChanged(load);
    return () => {
      live = false;
      off();
    };
  }, [io, kind]);
  const generic = kind === 'audio-input' && devices.length > 0 && devices.every((d) => GENERIC.test(d.label.trim()));
  return { devices, generic };
}

/** Dropdown for a `device` param. A stored id that is no longer present stays selectable as "Unavailable device". */
export function DeviceField({ value, kind, onChange, large, hint = true }: { value: string; kind: 'audio-input' | 'midi-input'; onChange: (v: string) => void; large?: boolean; hint?: boolean }) {
  const { devices, generic } = useDevices(kind);
  const known = value === '' || devices.some((d) => d.id === value);
  return (
    <div className="rs-dev" data-nodrag>
      <select className={`rs-select${large ? ' rs-select--lg' : ''}`} value={value} aria-label={kind === 'audio-input' ? 'Microphone' : 'MIDI device'} onChange={(e) => onChange(e.target.value)}>
        <option value="">{EMPTY_LABEL[kind]}</option>
        {devices.filter((d) => d.id !== '').map((d) => (
          <option key={d.id} value={d.id}>
            {d.label || 'Unnamed device'}
          </option>
        ))}
        {!known && <option value={value}>Unavailable device</option>}
      </select>
      {hint && generic && <div className="rs-dev__hint">Names appear after you allow microphone access.</div>}
      {hint && kind === 'midi-input' && devices.length === 0 && <div className="rs-dev__hint">No MIDI devices found.</div>}
    </div>
  );
}
