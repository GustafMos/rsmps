import { cameraRows } from '../../engine/lib/ar-setup';
import { defOf } from '../../engine/group';
import type { NodeInstance } from '../../engine/types';
import { nodeDisplayName } from '../lib/nodeTitle';
import { useApp, useEd } from '../store/context';
import './physics.css';

/**
 * "Objects of this camera": every node at this level that has a Camera input, with a tick that makes (or removes) the REAL Camera wire
 * from this camera to it. Used by the World AR Camera and the 3D Camera: a camera only affects the nodes wired to it, and any number
 * of cameras can each have their own objects. One undo step per tick.
 */
export function CameraObjects({ node, title, empty }: { node: NodeInstance; title: string; empty: string }) {
  const { ed } = useApp();
  const level = useEd((s) => s.level);
  const nameOf = (n: NodeInstance) => nodeDisplayName(n, defOf(ed.registry, n));
  const rows = cameraRows(level, ed.registry, node.id, nameOf);
  const mine = rows.filter((r) => r.state === 'yes').length;
  const free = rows.filter((r) => r.state === 'no').length;
  return (
    <div className="rs-insp__sec rs-objar" data-camera-objects>
      <div className="rs-caps">{title}</div>
      {rows.length ? (
        <>
          <div className="rs-insp__actions">
            <button className="rs-btn" data-cam-all disabled={!free} title="Wire this camera to every object that has no camera wired yet." onClick={() => ed.setCameraAll(node.id, true)}>
              All
            </button>
            <button className="rs-btn" data-cam-none disabled={!mine} title="Remove this camera's wires. The objects go back to their built-in camera." onClick={() => ed.setCameraAll(node.id, false)}>
              None
            </button>
          </div>
          <ul className="rs-objar__list" aria-label={title}>
            <li className="rs-objar__head" aria-hidden="true"><span>Object</span><span>Uses this camera</span><span>Light</span></li>
            {rows.map((r) => {
              const n = level.nodes.find((x) => x.id === r.id)!;
              const on = r.state === 'yes' || r.state === 'physics';
              return (
                <li key={r.id} className="rs-objar__item" data-camera-row={r.id} data-state={r.state}>
                  <button className="rs-objar__name" onClick={() => ed.select([r.id])} title="Select this object">{nameOf(n)}</button>
                  <input type="checkbox" role="switch" aria-label={`${nameOf(n)} uses this camera`} data-cam-tick={r.id} checked={on} disabled={r.state === 'physics'} onChange={(e) => ed.setCameraOf([r.id], e.target.checked ? node.id : null)} />
                  {r.lightOn === null ? (
                    <span className="rs-objar__na" title="This object has no light setting">-</span>
                  ) : (
                    <input type="checkbox" role="switch" aria-label={`${nameOf(n)} lit by this camera`} data-cam-light={r.id} checked={on && r.lightOn} disabled={!on} onChange={(e) => ed.setParam(r.id, 'lightFromCamera', e.target.checked)} />
                  )}
                  {r.state === 'physics' && <span className="rs-objar__note">through Physics</span>}
                  {r.state === 'other' && (
                    <button className="rs-objar__note rs-objar__switch" data-cam-switch={r.id} onClick={() => ed.setCameraOf([r.id], node.id)} title="Wire this object to this camera instead">
                      {r.other ? `now uses ${r.other}: tap to switch` : 'uses another camera: tap to switch'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="rs-insp__hint">{empty}</p>
      )}
    </div>
  );
}
