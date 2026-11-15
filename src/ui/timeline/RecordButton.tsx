import { useEffect, useRef, useState } from 'react';
import type { RecordingState } from '../../engine/audio/api';
import { Icon } from '../components/Icon';
import { useApp, useEd } from '../store/context';

/** Record / stop with clear states: armed, count-in (big numbers), recording (elapsed time) and a level meter. */
export function RecordButton({ nodeId, compact }: { nodeId?: string; compact?: boolean }) {
  const { io, ed } = useApp();
  const armed = useEd((s) => s.armed);
  const [st, setSt] = useState<RecordingState>(() => io.audio.recordingState());
  const lastErr = useRef<string | null>(null);
  useEffect(() => io.audio.onRecordingState((s) => {
    setSt(s);
    if (s.error && s.error !== lastErr.current) ed.toast(s.error, 'error');
    lastErr.current = s.error;
  }), [io, ed]);
  if (nodeId && armed && armed.nodeId !== nodeId && st.phase === 'idle') return null;
  const target = armed && (!nodeId || armed.nodeId === nodeId);
  const phase = st.phase;
  return (
    <span className={`rs-rec${compact ? ' rs-rec--compact' : ''}`}>
      {phase === 'idle' || phase === 'armed' ? (
        <button
          className={`rs-btn rs-rec__btn${target ? ' is-armed' : ''}`}
          disabled={!target}
          onClick={() => void ed.startRecording()}
          title={target ? 'Record on the armed track (starts audio if needed)' : 'Arm a track first (the ● button on a track)'}
        >
          <span className="rs-rec__dot" /> Record
        </button>
      ) : (
        <button className="rs-btn rs-rec__btn is-on" onClick={() => void ed.stopRecording()} title="Stop recording (Space)">
          <Icon name="pause" size={14} /> Stop
        </button>
      )}
      {phase === 'count-in' && <span className="rs-rec__count rs-num">{Math.max(1, Math.ceil(st.countIn))}</span>}
      {phase === 'recording' && <span className="rs-rec__time rs-num">REC {st.seconds.toFixed(1)}s</span>}
      {phase === 'armed' && <span className="rs-rec__state">armed</span>}
      {(phase === 'armed' || phase === 'recording') && (
        <span className="rs-rec__meter" aria-hidden="true">
          <span style={{ width: `${Math.min(1, st.level[0]) * 100}%` }} />
          <span style={{ width: `${Math.min(1, st.level[1]) * 100}%` }} />
        </span>
      )}
    </span>
  );
}
