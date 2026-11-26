import { useEffect, useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import { isWorldTake, worldTakeDuration } from '../../engine/lib/world-take';
import { fedByWorldAr } from '../../io/world-ar/engine-source';
import type { WorldArSupport } from '../../io/world-ar/support';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive } from '../store/live';
import { formatRemaining } from '../store/recorder';
import { openWorldAr } from '../store/worldAr';

/** The notice shown wherever World AR appears: it shipped without an AR phone to test on. */
export const WORLD_AR_BETA = 'Experimental: this was built without an AR phone to test it on. It may not work on yours yet. Please report what you see.';

/** Inspector section of World AR Camera: can this device do it, the button that opens the AR view, and the recorded take. */
export function WorldArPanel({ node, fullId }: { node: NodeInstance; fullId: string }) {
  const app = useApp();
  const { io, ed } = app;
  const [support, setSupport] = useState<WorldArSupport>({ state: 'checking', message: 'Checking whether this device can do AR.' });
  const viewed = useEd((s) => s.viewedNodeId);
  const graph = useEd((s) => s.graph);
  useEffect(() => {
    let live = true;
    // asks the browser whether AR exists at all: no permission question, nothing shown
    void io.worldAr?.support().then((s) => live && setSupport(s));
    if (!io.worldAr) setSupport({ state: 'unsupported', message: 'The AR view is not available in this version of the app.' });
    return () => {
      live = false;
    };
  }, [io]);
  const take = isWorldTake(node.params.take) ? node.params.take : null;
  const target = viewed && viewed !== fullId ? viewed : null;
  const through = target ? fedByWorldAr(graph, target) : false;
  const ok = support.state === 'ok';
  const active = io.worldAr?.active ?? null;
  const video = getLive(app).worldArVideo;
  const vui = useSelector(video.store, (s) => s);
  const rendering = vui.nodeId === fullId && vui.phase !== 'idle';
  const otherBusy = vui.phase !== 'idle' && !rendering;
  const left = formatRemaining(vui.remaining);
  const plan = take ? video.plan(fullId) : null;
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">AR view</div>
      <p className="rs-insp__hint" role="note">{WORLD_AR_BETA}</p>
      <p className="rs-insp__hint" role="status">{support.message}</p>
      <div className="rs-insp__actions">
        <button
          className="rs-btn"
          disabled={!ok}
          title={ok ? 'Opens the camera full-screen. The browser asks for the camera first. Nothing leaves this device.' : support.message}
          onClick={() => openWorldAr(app, node.id, fullId)}
        >
          Start AR
        </button>
      </div>
      <p className="rs-insp__hint">
        {!target
          ? 'View the node you want in the room first: the eye on your 3D Object (wire this camera into its Camera input), or on any picture.'
          : through
            ? 'The viewed node looks through this camera: it will stand in the room as a 3D object, with every effect after it.'
            : 'The viewed node does not look through this camera: it will stand in the room as a flat picture (see Flat pictures below).'}
      </p>
      <p className="rs-insp__hint">In the AR view: move the phone slowly until a ring appears on the floor or a table, tap to place, drag to move, two fingers to turn and resize. Record saves the movement here as a take, with the camera picture as a clip where the browser hands it over.</p>
      <p className="rs-insp__hint">
        The Picture output is what the camera sees right now. Wire it into a Material's colour map, or into any effect, to use the room as a texture. In the AR view it is the AR camera picture; outside it, the back camera of this device. It only costs work while it is wired.
      </p>
      {active && !active.state().features.cameraAccess && <p className="rs-insp__hint" role="status">This phone does not hand over the camera picture in AR, so the Picture output is transparent while the AR view is open.</p>}
      {take && (
        <>
          <div className="rs-caps">Recorded take</div>
          <p className="rs-insp__hint">
            {worldTakeDuration(take).toFixed(1)} s at {take.fps} frames per second. {take.clip ? 'It matches the camera clip recorded with it frame for frame: keep that Media In clip starting at the same time.' : 'Movement only (no camera clip was recorded with it).'} It plays in the normal viewer and in exports.
          </p>
          <div className="rs-insp__actions">
            <button
              className="rs-btn"
              disabled={vui.phase !== 'idle' || !!active}
              title={plan?.clipAsset ? 'Makes a video file: the camera picture with the object over it, as it looked in the AR view. It is added to Media and downloaded.' : 'There is no camera picture with this take, so the object is rendered alone over black.'}
              onClick={() => void video.start(fullId, { alone: !plan?.clipAsset })}
            >
              {plan?.clipAsset ? 'Save as video' : 'Save object alone as video'}
            </button>
            {rendering && (
              <button className="rs-btn rs-btn--danger" title="Stop making the video. The recording and its camera clip stay as they are" onClick={() => video.cancel()}>
                Cancel
              </button>
            )}
            {vui.lastName && vui.phase === 'idle' && (
              <button className="rs-btn" title={`Save ${vui.lastName} as a video file on this device`} onClick={() => video.saveLast()}>
                Save last video as file
              </button>
            )}
            <button className="rs-btn" disabled={rendering} onClick={() => ed.setParam(node.id, 'take', null)} title="Removes the recorded movement from this node (the camera clip stays in Media)">Remove take</button>
          </div>
          {rendering && (
            <div className="rs-dlg__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(vui.progress * 100)}>
              <div style={{ width: `${Math.round(vui.progress * 100)}%` }} />
            </div>
          )}
          <p className="rs-insp__hint" role="status">
            {rendering
              ? `Making the video, frame by frame${left ? `, ${left}` : ''}. This can take longer than the recording. Keep this page open and on screen.`
              : otherBusy
                ? 'Another video is being made.'
                : plan?.clipAsset
                  ? 'Save as video puts the viewed node over the recorded camera picture and makes a video file. The recording and the camera clip stay as they are, so you can make it again with other effects. The setting "Save video" does this by itself when you close the AR view.'
                  : plan?.clipMissing
                    ? 'The camera clip of this take is no longer in Media. You can still save the object alone over black.'
                    : 'This take has only the movement (the phone did not hand over the camera picture). You can save the object alone over black.'}
          </p>
        </>
      )}
    </div>
  );
}
