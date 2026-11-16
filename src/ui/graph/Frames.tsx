import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameBox } from '../../engine/types';
import { frameRects, FRAME_HEAD } from '../lib/geometry';
import { useSelector } from '../store/createStore';
import { nodeViewStore } from '../store/nodeView';
import { useApp, useDefs, useEd } from '../store/context';

export const Frames = memo(function Frames() {
  const { io } = useApp();
  const nodes = useEd((s) => s.graph.nodes);
  const frames = useEd((s) => s.graph.frames);
  useDefs();
  // node height depends on pinned / expanded params: recompute the outline when either changes, not only when nodes move
  const view = useSelector(nodeViewStore, (s) => s);
  const rects = useMemo(() => frameRects({ nodes, edges: [], frames } as never, io.registry), [nodes, frames, io, view]);
  return (
    <>
      {(frames ?? []).map((f) => {
        const r = rects.get(f.id);
        return r ? <FrameView key={f.id} frame={f} x={r.x} y={r.y} w={r.w} h={r.h} /> : null;
      })}
    </>
  );
});

const FrameView = memo(function FrameView({ frame, x, y, w, h }: { frame: FrameBox; x: number; y: number; w: number; h: number }) {
  const { ed, graphCtl } = useApp();
  const selected = useEd((s) => s.selectedFrame === frame.id);
  const [renaming, setRenaming] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const e = el.current;
    if (!e) return;
    graphCtl.frameEls.set(frame.id, e);
    return () => {
      graphCtl.frameEls.delete(frame.id);
    };
  }, [graphCtl, frame.id]);
  return (
    <div
      ref={el}
      className={`rs-frame${selected ? ' is-selected' : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h, ['--fc' as string]: frame.color }}
    >
      <div className="rs-frame__head" data-frame-head={frame.id} style={{ height: FRAME_HEAD }}>
        {renaming ? (
          <input
            className="rs-frame__rename"
            data-nodrag
            autoFocus
            defaultValue={frame.label}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => {
              setRenaming(false);
              ed.updateFrame(frame.id, { label: e.currentTarget.value.trim() || 'Frame' });
            }}
          />
        ) : (
          <span className="rs-frame__label" onDoubleClick={() => setRenaming(true)} title="Double-click to rename. Drag to move the whole group.">
            {frame.label}
          </span>
        )}
      </div>
    </div>
  );
});
