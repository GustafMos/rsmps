import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive } from '../store/live';
import { formatRemaining, recordLabel, recorderSettings } from '../store/recorder';

/** Inspector section of the Recorder node: Record what flows through it into a clip in Media. `fullId` is the node's path id. */
export function RecorderPanel({ fullId, params }: { fullId: string; params: Readonly<Record<string, unknown>> }) {
  const app = useApp();
  const recorder = getLive(app).recorder;
  const ui = useSelector(recorder.store, (s) => s);
  const mine = ui.nodeId === fullId;
  const recording = mine && ui.phase === 'recording';
  const rendering = mine && ui.phase === 'rendering';
  const settings = recorderSettings(params);
  const smooth = ui.phase === 'idle' ? settings.quality === 'smooth' : ui.smooth;
  const left = formatRemaining(ui.remaining);
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Record</div>
      <div className="rs-insp__actions">
        <button
          className={`rs-btn${recording ? ' is-on' : ''}`}
          disabled={ui.phase === 'saving' || ui.phase === 'rendering'}
          title={recording ? (smooth ? 'Stop: the clip is then rendered and saved to Media' : 'Stop and save the clip to Media') : 'Shows this node in the viewer, starts playback and records it with the sound into a clip in Media'}
          onClick={() => recorder.toggle(fullId, settings)}
        >
          {recordLabel(ui, mine)}
        </button>
        {rendering && (
          <button className="rs-btn rs-btn--danger" title="Stop rendering. The raw camera clip stays in Media and can be rendered again" onClick={() => recorder.cancelRender()}>
            Cancel
          </button>
        )}
        {ui.retry && ui.phase === 'idle' && (
          <button className="rs-btn" title="Make the clip from the raw camera clip of the last take, with the effects as they are now" onClick={() => recorder.renderAgain()}>
            Render again
          </button>
        )}
        {ui.lastName && ui.phase === 'idle' && (
          <button className="rs-btn" title={`Save ${ui.lastName} as a video file on this device`} onClick={() => recorder.saveLast()}>
            Save last clip as file
          </button>
        )}
      </div>
      {rendering && (
        <div className="rs-dlg__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ui.progress * 100)}>
          <div style={{ width: `${Math.round(ui.progress * 100)}%` }} />
        </div>
      )}
      <p className="rs-insp__hint">
        {rendering
          ? `Rendering the effects onto the recording, every frame${left ? `, ${left}` : ''}. This can take longer than the recording itself. Keep this page open and on screen.`
          : recording && smooth
            ? `Recording the camera itself${settings.time === 'run' ? '; time runs on until you stop' : '; the project loops'}. The preview may stutter. The clip is rendered smoothly when you stop, with the settings as they are then.`
            : recording
              ? settings.time === 'run'
                ? 'Recording. Time runs on until you stop; Stop saves the clip.'
                : 'Recording. The project loops; Stop saves the clip.'
              : smooth
                ? 'Records the camera at its full frame rate with the sound that is playing, and renders the effects onto it when you stop: smooth even when the preview stutters. Up to 30 minutes. The clip goes to Media (use it with Media In)' + (settings.download ? ' and is saved as a video file on this device.' : '.')
                : 'Records what the viewer shows while this node is viewed, with the sound that is playing. Up to 30 minutes. The clip goes to Media (use it with Media In)' + (settings.download ? ' and is saved as a video file on this device.' : '.')}
      </p>
      {mine && ui.notes.map((n) => (
        <p key={n} className="rs-insp__hint">{n}</p>
      ))}
    </div>
  );
}
