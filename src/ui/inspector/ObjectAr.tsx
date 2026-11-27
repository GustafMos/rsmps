import { cameraNodes, cameraSource, canShowInAr, roomLightFor, WORLD_AR_ID } from '../../engine/lib/ar-setup';
import { defOf } from '../../engine/group';
import type { NodeInstance } from '../../engine/types';
import { nodeDisplayName } from '../lib/nodeTitle';
import { useApp, useEd } from '../store/context';
import { openWorldAr } from '../store/worldAr';
import { useWorldArSupport } from './useWorldArSupport';
import './physics.css';

/** A labelled on / off row, big enough for a thumb. */
export function ArSwitch({ label, on, onChange, hint, disabled, id }: { label: string; on: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean; id?: string }) {
  return (
    <label className="rs-objar__row" title={hint}>
      <input type="checkbox" role="switch" data-ar-switch={id} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const BUILT_IN = '';

/**
 * "Camera" section in the inspector of every 3D object: which camera it looks through (a dropdown that makes or moves the real wire),
 * and "Show in AR", which sets a World AR Camera up for it in one tap. Nothing is wired by dragging.
 */
export function ObjectAr({ node }: { node: NodeInstance }) {
  const app = useApp();
  const { ed } = app;
  const level = useEd((s) => s.level);
  const selection = useEd((s) => s.selection);
  const fullId = useEd((s) => (s.path.length ? [...s.path, node.id].join('/') : node.id));
  const viewed = useEd((s) => s.viewedNodeId === fullId);
  const support = useWorldArSupport();
  if (!canShowInAr(node, ed.registry)) return null;
  const cams = cameraNodes(level, ed.registry);
  const nameOf = (n: NodeInstance) => nodeDisplayName(n, defOf(ed.registry, n));
  const src = cameraSource(level, ed.registry, node.id);
  const cam = src.camera;
  const isAr = cam?.type === WORLD_AR_ID;
  const wiredOther = src.kind === 'direct' && !cam; // a wire from some other node: left as it is
  const light = roomLightFor(level, ed.registry, node.id) === 'on';
  const hasShadow = 'groundShadow' in (defOf(ed.registry, node)?.params ?? {});
  const shadow = node.params.groundShadow === true;
  const arCams = cams.filter((c) => c.type === WORLD_AR_ID);
  const parts = cam
    ? [
        `Uses ${nameOf(cam)}${src.kind === 'physics' ? ' (through Physics)' : ''}`,
        light ? (isAr ? 'lit by the room' : 'lit by the camera') : '',
        isAr && hasShadow && shadow ? 'shadow on the real floor' : '',
      ].filter(Boolean)
    : [];
  const value = cam && src.kind === 'direct' ? cam.id : BUILT_IN;
  const targets = selection.includes(node.id) && selection.length > 1 ? selection : [node.id];
  return (
    <div className="rs-insp__sec rs-objphys rs-objar" data-object-ar>
      <div className="rs-caps">Camera</div>
      {wiredOther ? (
        <p className="rs-insp__hint">This object looks through a camera you wired in yourself.</p>
      ) : (
        <label className="rs-objar__pick">
          <span>Camera</span>
          <select data-camera-pick aria-label="Camera of this object" value={value} disabled={src.kind === 'physics'} onChange={(e) => ed.setCameraOf([node.id], e.target.value || null)}>
            <option value={BUILT_IN}>Built-in</option>
            {cams.map((c) => (
              <option key={c.id} value={c.id}>{nameOf(c)}</option>
            ))}
          </select>
        </label>
      )}
      <p className="rs-insp__hint" role="status" data-ar-summary>
        {src.kind === 'physics' ? `${parts.join(' · ')}. Change the camera on the Physics node.` : parts.length ? `${parts.join(' · ')}.` : 'Uses its built-in camera. A camera only affects the objects wired to it, and you can use several cameras.'}
      </p>
      {isAr && hasShadow && <ArSwitch id="shadow" label="Shadow on the floor" on={shadow} onChange={(v) => ed.setParam(node.id, 'groundShadow', v)} hint="Darkens the real floor under the object." />}
      <div className="rs-insp__actions">
        {!isAr || !viewed ? (
          <button className="rs-btn rs-btn--primary" data-show-in-ar onClick={() => ed.showInAr(targets, isAr ? cam!.id : arCams[0]?.id)} title="Wires this object to a World AR Camera (adds one if there is none), turns on its shadow and shows it in the viewer.">
            Show in AR
          </button>
        ) : (
          <button
            className="rs-btn rs-btn--primary"
            data-start-ar
            disabled={support.state !== 'ok'}
            title={support.state === 'ok' ? 'Opens the camera full-screen.' : support.message}
            onClick={() => openWorldAr(app, cam!.id, ed.fullId(cam!.id))}
          >
            Start AR
          </button>
        )}
      </div>
      {isAr && viewed && <p className="rs-insp__hint">{support.state === 'ok' ? 'Next: press Start AR, move the phone slowly until a ring shows on the floor, then tap to place this object.' : support.message}</p>}
      {!isAr && <p className="rs-insp__hint">Show in AR puts this object in your room on the real floor: it wires the object to a World AR Camera for you.</p>}
    </div>
  );
}

/** Above the Lighting settings of a 3D node the camera's light is in control of: says so, and is the switch to take the light back. */
export function RoomLightNote({ node, ar }: { node: NodeInstance; ar: boolean }) {
  const { ed } = useApp();
  return (
    <div className="rs-insp__roomlight" data-room-light-note>
      <ArSwitch id="roomlight" label={ar ? 'Lit by the room (from this camera)' : 'Lit by its camera'} on={true} onChange={(v) => ed.setParam(node.id, 'lightFromCamera', v)} hint="Switch off to use the light settings below instead." />
      <p className="rs-insp__hint">The camera's light is used while this is on, so Light azimuth, Light height and Ambient light below have no effect. Switch it off to set the light yourself.</p>
    </div>
  );
}
