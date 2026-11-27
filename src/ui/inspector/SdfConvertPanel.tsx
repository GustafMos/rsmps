import { useApp } from '../store/context';

/** SDF 3D: split the node into an SDF Scene whose shapes can be moved one by one (lib/sdf-convert.ts). */
export function SdfConvertPanel({ id }: { id: string }) {
  const { ed } = useApp();
  return (
    <div className="rs-insp__sec" data-sdf-convert>
      <div className="rs-caps">SDF Scene</div>
      <div className="rs-insp__actions">
        <button className="rs-btn" title="Turns this node into an SDF Scene with the same picture, where every shape is its own node you can move separately. One undo step takes it back." onClick={() => ed.convertToSdfScene(id)}>
          Convert to SDF Scene
        </button>
        <button className="rs-btn" title="Same, but keeps this node and adds the scene next to it." onClick={() => ed.convertToSdfScene(id, true)}>
          Convert a copy
        </button>
      </div>
      <p className="rs-insp__hint">To move the shapes separately, use an SDF Scene. Double-click the scene afterwards to open it.</p>
    </div>
  );
}
