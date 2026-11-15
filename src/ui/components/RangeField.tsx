import { useEffect, useRef } from 'react';
import { useApp, useEd } from '../store/context';
import { NumberField } from './NumberField';
import './range.css';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function timecode(seconds: number, fps: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const f = Math.round((rest - Math.floor(rest)) * fps);
  return `${m}:${String(Math.floor(rest)).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/**
 * One bar with two handles for a vec2 param flagged `range` (an in/out pair in 0..1). Drag either end or the middle
 * (moves both); numeric ends; double-click resets. With a video asset on the node it also shows timecodes and
 * "Set in / Set out" at the playhead (keys I and O while the field is on screen).
 */
export function RangeField({ nodeId, keyName, value, defaultValue, compact }: { nodeId: string; keyName: string; value: [number, number]; defaultValue: [number, number]; compact?: boolean }) {
  const { ed, io } = useApp();
  const bar = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const v: [number, number] = [clamp01(Number(value?.[0] ?? 0)), clamp01(Number(value?.[1] ?? 1))];
  const vRef = useRef(v);
  vRef.current = v;
  const asset = useEd((s) => {
    const n = s.graph.nodes.find((x) => x.id === nodeId);
    const def = n && io.registry.get(n.type);
    const key = def && Object.entries(def.params as Record<string, { type: string }>).find(([, p]) => p.type === 'assets')?.[0];
    const ids = key && n ? (n.params[key] as string[] | undefined) : undefined;
    const info = ids?.length ? io.library.list({ includeHidden: true }).find((a) => a.id === ids[Math.min(s.item, ids.length - 1)]) : undefined;
    return info && info.kind === 'video' ? info : undefined;
  });
  const duration = asset?.duration ?? 0;
  const fps = asset?.fps || 24;
  const write = (next: [number, number]) => ed.setParam(nodeId, keyName, [clamp01(next[0]), clamp01(next[1])]);

  const drag = (e: React.PointerEvent, part: 'a' | 'b' | 'mid') => {
    e.preventDefault();
    e.stopPropagation();
    const el = bar.current!;
    const r = el.getBoundingClientRect();
    const start = [...vRef.current] as [number, number];
    const x0 = e.clientX;
    el.setPointerCapture(e.pointerId);
    ed.beginHold();
    const mv = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / r.width;
      if (part === 'a') write([Math.min(start[0] + d, start[1]), start[1]]);
      else if (part === 'b') write([start[0], Math.max(start[1] + d, start[0])]);
      else {
        const span = start[1] - start[0];
        const a = Math.min(1 - span, Math.max(0, start[0] + d));
        write([a, a + span]);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      ed.endHold();
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };

  // playhead inside the bar, imperatively
  useEffect(() => {
    if (!duration) return;
    const place = () => {
      const st = io.player.getState();
      if (head.current) head.current.style.left = `${clamp01((st.seconds % duration) / duration) * 100}%`;
    };
    place();
    return io.player.subscribe(place);
  }, [io, duration]);

  const playheadFrac = () => clamp01((io.player.getState().seconds % (duration || 1)) / (duration || 1));
  const setIn = () => write([Math.min(playheadFrac(), vRef.current[1]), vRef.current[1]]);
  const setOut = () => write([vRef.current[0], Math.max(playheadFrac(), vRef.current[0])]);
  useEffect(() => {
    if (!duration) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.rs-ce, .rs-dlg')) return;
      if (ed.state.selection.length !== 1 || ed.state.selection[0] !== nodeId) return;
      if (e.key === 'i' || e.key === 'I') { e.preventDefault(); e.stopImmediatePropagation(); setIn(); }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); e.stopImmediatePropagation(); setOut(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, nodeId]);

  return (
    <div className={`rs-range${compact ? ' rs-range--compact' : ''}`} data-nodrag onDoubleClick={() => write(defaultValue)} title="Drag the ends or the middle. Double-click resets.">
      <div ref={bar} className="rs-range__bar">
        <div className="rs-range__span" style={{ left: `${v[0] * 100}%`, width: `${(v[1] - v[0]) * 100}%` }} onPointerDown={(e) => drag(e, 'mid')} />
        <div className="rs-range__handle" style={{ left: `${v[0] * 100}%` }} onPointerDown={(e) => drag(e, 'a')} />
        <div className="rs-range__handle" style={{ left: `${v[1] * 100}%` }} onPointerDown={(e) => drag(e, 'b')} />
        {duration > 0 && <div ref={head} className="rs-range__head" />}
      </div>
      {!compact && (
        <div className="rs-range__fields">
          <NumberField label="In" min={0} max={1} step={0.001} value={Number(v[0].toFixed(4))} defaultValue={defaultValue[0]} onChange={(x) => write([Math.min(x, v[1]), v[1]])} />
          <NumberField label="Out" min={0} max={1} step={0.001} value={Number(v[1].toFixed(4))} defaultValue={defaultValue[1]} onChange={(x) => write([v[0], Math.max(x, v[0])])} />
        </div>
      )}
      {duration > 0 && !compact && (
        <>
          <div className="rs-range__tc rs-num">
            {timecode(v[0] * duration, fps)} → {timecode(v[1] * duration, fps)} · {((v[1] - v[0]) * duration).toFixed(2)} s · frames {Math.round(v[0] * duration * fps)}–{Math.round(v[1] * duration * fps)}
          </div>
          <div className="rs-range__btns">
            <button className="rs-btn" onClick={setIn} title="Put the in point at the playhead (I)">Set in</button>
            <button className="rs-btn" onClick={setOut} title="Put the out point at the playhead (O)">Set out</button>
            <button className="rs-btn" onClick={() => write(defaultValue)}>Reset</button>
            <button className="rs-btn" onClick={() => ed.setProject({ duration: Math.max(0.1, Math.round((v[1] - v[0]) * duration * 100) / 100) })} title="Make the project exactly as long as the trimmed clip">Set project length to this clip</button>
          </div>
        </>
      )}
    </div>
  );
}
