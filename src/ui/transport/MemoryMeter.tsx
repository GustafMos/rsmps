import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store/context';

const MB = 1048576;
const mb = (b: number) => (b >= 1024 * MB ? `${(b / (1024 * MB)).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

/** Thin GPU-memory meter for the transport. Updated imperatively from the player subscription (no React renders per frame). */
export function MemoryMeter() {
  const { io, ed } = useApp();
  const fill = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const draw = () => {
      const m = io.player.getState().memory;
      if (!m || !fill.current || !btn.current) return;
      const frac = m.budgetBytes > 0 ? Math.min(1, m.allocatedBytes / m.budgetBytes) : 0;
      fill.current.style.width = `${Math.round(frac * 100)}%`;
      btn.current.dataset.pressure = m.pressure;
      btn.current.title = `GPU memory: ${mb(m.allocatedBytes)} of ${mb(m.budgetBytes)} (${m.pressure}). Click for details.`;
    };
    draw();
    return io.player.subscribe(draw);
  }, [io]);

  if (!io.player.getState().memory) return null;
  return (
    <>
      <button
        ref={btn}
        className="rs-mem"
        aria-label="GPU memory"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.right, y: r.top });
        }}
      >
        <span className="rs-mem__lbl">Mem</span>
        <span className="rs-mem__bar"><span ref={fill} /></span>
      </button>
      {open && <MemoryPopover x={open.x} y={open.y} anchor={btn} onClose={() => setOpen(null)} />}
    </>
  );
}

function MemoryPopover({ x, y, onClose, anchor }: { x: number; y: number; onClose: () => void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const { io, ed } = useApp();
  const m = io.player.getState().memory!;
  const [budget, setBudget] = useState(m.budgetBytes);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    const off = io.player.subscribe(() => tick((n) => n + 1));
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
  const cur = io.player.getState().memory ?? m;
  const info = io.memory();
  return createPortal(
    <div ref={ref} className="rs-mem__pop" style={{ right: window.innerWidth - x, bottom: window.innerHeight - y + 6 }} role="dialog" aria-label="GPU memory">
      <div className="rs-caps">GPU memory</div>
      <div className="rs-num">{mb(cur.allocatedBytes)} of {mb(cur.budgetBytes)} · {cur.pressure}</div>
      <div className="rs-mem__rows rs-num">
        <span>Engine cache</span><span>{mb(info.engineCacheBytes)}</span>
        <span>Texture pool</span><span>{mb(info.gpuPoolBytes)}</span>
        <span>Frame cache</span><span>{mb(info.frameCacheBytes)}</span>
        <span>Decoded media</span><span>{mb(info.decodedMediaBytes)}</span>
      </div>
      <label className="rs-mem__budget">
        <span>Budget {mb(budget)}</span>
        <input type="range" min={256} max={4096} step={64} value={Math.round(budget / MB)} onChange={(e) => { const b = Number(e.target.value) * MB; setBudget(b); io.memoryBudget.set(b); }} aria-label="Memory budget" />
      </label>
      <div className="rs-insp__actions">
        <button className="rs-btn" onClick={() => { io.memoryBudget.auto(); setBudget(io.memoryBudget.get()); }} title="Use the detected default">Auto</button>
        <button
          className="rs-btn rs-btn--primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            io.freeMemory().then(() => ed.toast('Memory freed', 'ok')).catch(() => ed.toast('Could not free memory', 'error')).finally(() => setBusy(false));
          }}
        >
          Free memory
        </button>
      </div>
    </div>,
    document.body,
  );
}
