import { useEffect, useState } from 'react';
import { formatElapsed } from '../../io/live-record';
import { useApp } from '../store/context';
import { liveSourceOf, toggleLiveRecord } from '../store/liveRecord';

const WHAT = 'Records the incoming picture to a clip in Media. Picture only, no sound. Up to 30 minutes.';

/** Inspector section of Webcam, Phone Camera and URL / Stream: Record the incoming picture into a clip in Media. `fullId` is the node's path id. */
export function LiveRecordPanel({ fullId }: { fullId: string }) {
  const app = useApp();
  const { io } = app;
  const rec = io.liveRecorder;
  const [, redraw] = useState(0);
  useEffect(() => {
    const bump = () => redraw((n) => n + 1);
    const off = rec.subscribe(bump);
    const t = setInterval(bump, 500); // the running time, and whether a picture is arriving
    return () => {
      off();
      clearInterval(t);
    };
  }, [rec]);

  const mine = rec.nodeId === fullId;
  const recording = rec.state === 'recording' && mine;
  const saving = rec.state === 'saving' && mine;
  const other = rec.state !== 'idle' && !mine;
  const source = liveSourceOf(app, fullId);
  const ready = !!source && rec.ready(source);
  const disabled = saving || (!recording && !other && !ready); // while another node records the button stays live: pressing it says so in a toast
  const title = recording
    ? 'Stop and save the clip to Media'
    : saving
      ? 'Saving the clip to Media'
      : other
        ? 'Another node is being recorded. Stop that recording first.'
        : !ready
          ? 'No picture is arriving yet. View this node and wait for its picture, then record.'
          : WHAT;
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Record</div>
      <div className="rs-insp__actions">
        <button className={`rs-btn${recording ? ' is-on' : ''}`} disabled={disabled} title={title} onClick={() => toggleLiveRecord(app, fullId)}>
          {recording ? `Stop ${formatElapsed(rec.elapsed)}` : saving ? 'Saving' : 'Record'}
        </button>
      </div>
      <p className="rs-insp__hint">{recording ? 'Recording. Stop saves the clip to Media.' : `${WHAT} Use the clip with Media In to export it.`}</p>
    </div>
  );
}
