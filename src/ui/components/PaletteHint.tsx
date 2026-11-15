import { useApp } from '../store/context';

/** Shown on any node with an unwired palette input (found by socket type, never by node id). */
export function PaletteHint({ nodeId, compact }: { nodeId: string; compact?: boolean }) {
  const { ed, io } = useApp();
  const canCreate = !!io.registry.get('palette');
  return (
    <div className={`rs-phint${compact ? ' rs-phint--compact' : ''}`} data-nodrag role="note">
      <span className="rs-phint__text">No palette connected — using fallback</span>
      <span className="rs-phint__btns">
        <button className="rs-btn" onClick={() => ed.extractPaletteFor(nodeId)} disabled={!canCreate} title="Add a Palette node that extracts colours from this node's input image once, at the current time">
          Extract from image
        </button>
        <button className="rs-btn" onClick={() => ed.createPaletteFor(nodeId)} disabled={!canCreate} title="Add a Palette node with your own colours and open Palette Studio">
          Create palette…
        </button>
      </span>
    </div>
  );
}
