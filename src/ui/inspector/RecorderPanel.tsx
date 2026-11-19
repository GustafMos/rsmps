import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive } from '../store/live';
import { recordLabel, recorderSettings } from '../store/recorder';

/** Inspector section of the Recorder node: Record what flows through it into a clip in Media. `fullId` is the node's path id. */
export function RecorderPanel({ fullId, params }: { fullId: string; params: Readonly<Record<string, unknown>> }) {
  const app = useApp();
  const recorder = getLive(app).recorder;
  const ui = useSelector(recorder.store, (s) => s);
  const mine = ui.nodeId === fullId;
  const recording = mine && ui.phase === 'recording';
  const settings = recorderSettings(params);
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Record</div>
      <div className="rs-insp__actions">
        <button
          className={`rs-btn${recording ? ' is-on' : ''}`}
          disabled={ui.phase === 'saving'}
          title={recording ? 'Stop and save the clip to Media' : 'Shows this node in the viewer, starts playback and records it with the sound into a clip in Media'}
          onClick={() => recorder.toggle(fullId, settings)}
        >
          {recordLabel(ui, mine)}
        </button>
        {ui.lastName && ui.phase === 'idle' && (
          <button className="rs-btn" title={`Save ${ui.lastName} as a video file on this device`} onClick={() => recorder.saveLast()}>
            Save last clip as file
          </button>
        )}
      </div>
      <p className="rs-insp__hint">
        {recording
          ? settings.time === 'run'
            ? 'Recording. Time runs on until you stop; Stop saves the clip.'
            : 'Recording. The project loops; Stop saves the clip.'
          : 'Records what the viewer shows while this node is viewed, with the sound that is playing. Up to 30 minutes. The clip goes to Media (use it with Media In)' + (settings.download ? ' and is saved as a video file on this device.' : '.')}
      </p>
    </div>
  );
}
