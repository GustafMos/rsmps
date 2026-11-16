import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SelectField } from '../components/fields';
import { memoryBreakdown, memoryTooltip, mb } from '../lib/memoryRows';
import { useApp } from '../store/context';
import { useOverlay } from '../lib/overlay';

const MB = 1048576;

/** Thin GPU-memory meter for the transport. Updated imperatively from the player subscription (no React renders per frame). */
export function MemoryMeter() {
  const { io } = useApp();
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
      // `allocatedBytes` is everything the app holds on the GPU (textures of every kind and buffers): the same number as the tooltip total.
      if (!btn.current.dataset.tip) btn.current.title = `GPU memory: ${mb(m.allocatedBytes)} of ${mb(m.budgetBytes)} (${m.pressure}). Click for details and settings.`;
    };
    draw();
    return io.player.subscribe(draw);
  }, [io]);

  // The full breakdown is only built when the pointer is on the button: io.memory() walks the GPU ledgers.
  const detailedTip = () => {
    const m = io.player.getState().memory;
    if (!m || !btn.current) return;
    btn.current.dataset.tip = '1';
    btn.current.title = `${memoryTooltip(io.memory(), m.budgetBytes, m.pressure)}\nClick for details and settings.`;
  };

  if (!io.player.getState().memory) return null;
  return (
    <>
      <button
        ref={btn}
        className="rs-mem"
        aria-label="GPU memory"
        onMouseEnter={detailedTip}
        onFocus={detailedTip}
        onMouseLeave={() => btn.current && delete btn.current.dataset.tip}
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
  const [ram, setRam] = useState(io.memoryBudget.ramBudget.get());
  const [quality, setQuality] = useState(io.memoryBudget.cacheQuality.get());
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useOverlay(onClose);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    const off = io.player.subscribe(() => tick((n) => n + 1));
    return () => {
      window.removeEventListener('pointerdown', down, true);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cur = io.player.getState().memory ?? m;
  const info = io.memory();
  const b = memoryBreakdown(info);
  const ramUsed = b.ram.reduce((n, r) => n + r.bytes, 0);
  return createPortal(
    <div ref={ref} className="rs-mem__pop" style={{ right: window.innerWidth - x, bottom: window.innerHeight - y + 6, width: 300 }} role="dialog" aria-label="Memory">
      <div className="rs-caps">GPU memory</div>
      <div className="rs-num">{mb(cur.allocatedBytes)} of {mb(cur.budgetBytes)} · {cur.pressure}</div>
      <div className="rs-mem__rows rs-num">
        {b.gpu.map((r) => (
          <span key={r.label} style={{ display: 'contents' }} title={r.hint}>
            <span>{r.label}</span>
            <span>{mb(r.bytes)}</span>
          </span>
        ))}
      </div>
      <label className="rs-mem__budget" title="How much graphics memory the app may use before it starts giving caches back. Higher keeps more results ready; too high can make the GPU run out of memory.">
        <span>GPU budget {mb(budget)}</span>
        <input type="range" min={256} max={4096} step={64} value={Math.round(budget / MB)} onChange={(e) => { const v = Number(e.target.value) * MB; setBudget(v); io.memoryBudget.set(v); }} aria-label="GPU memory budget" />
      </label>
      <div className="rs-caps">System RAM for caches</div>
      <div className="rs-num">{mb(ramUsed)} of {mb(ram)}</div>
      <div className="rs-mem__rows rs-num">
        {b.ram.map((r) => (
          <span key={r.label} style={{ display: 'contents' }} title={r.hint}>
            <span>{r.label}</span>
            <span>{mb(r.bytes)}</span>
          </span>
        ))}
      </div>
      <label className="rs-mem__budget" title="Finished frames are kept here so playing a loop a second time costs nothing. More RAM = more of the timeline stays ready. It does not use the GPU.">
        <span>RAM budget {mb(ram)}</span>
        <input type="range" min={256} max={16384} step={256} value={Math.min(16384, Math.max(256, Math.round(ram / MB)))} onChange={(e) => { const v = Number(e.target.value) * MB; setRam(v); io.memoryBudget.ramBudget.set(v); }} aria-label="RAM budget for caches" />
      </label>
      <p className="rs-insp__hint">More RAM keeps more frames ready for instant replay. Leave room for your other programs.</p>
      <div className="rs-mem__budget">
        <span>Cache quality</span>
        <SelectField
          value={quality}
          options={[
            { value: 'compressed', label: 'Compressed (less RAM, near exact)' },
            { value: 'lossless', label: 'Lossless (exact, more RAM)' },
          ]}
          onChange={(v) => { const q = v === 'lossless' ? 'lossless' : 'compressed'; setQuality(q); io.memoryBudget.cacheQuality.set(q); }}
          label="Cache quality"
        />
      </div>
      <p className="rs-insp__hint">Changing the quality empties the frame cache; frames are cached again as you play.</p>
      <div className="rs-insp__actions">
        <button className="rs-btn" onClick={() => { io.memoryBudget.auto(); io.memoryBudget.ramBudget.auto(); setBudget(io.memoryBudget.get()); setRam(io.memoryBudget.ramBudget.get()); }} title="Use the detected defaults for both budgets">Auto</button>
        <button
          className="rs-btn rs-btn--primary"
          disabled={busy}
          title="Give back every cache that can be rebuilt: the picture on screen stays"
          onClick={() => {
            setBusy(true);
            io.freeMemory().then(() => ed.toast('Memory freed', 'ok')).catch(() => ed.toast('Could not free memory', 'error')).finally(() => setBusy(false));
          }}
        >
          Free memory now
        </button>
      </div>
    </div>,
    document.body,
  );
}
