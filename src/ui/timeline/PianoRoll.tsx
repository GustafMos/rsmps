import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { gridSeconds, quantizeClip, snapTime, transposeClip, updateClip, type Grid, type TimelineData, type TimelineNote } from '../../engine/audio/timeline';
import { NumberField } from '../components/NumberField';
import { Icon } from '../components/Icon';
import { useApp } from '../store/context';

const ROW_H = 12;
const LO = 21;
const HI = 108;
const VEL_H = 56;
const KEYS_W = 40;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (n: number) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/**
 * Basic piano roll for one MIDI clip. X is clip time (note.t - clip.offset), Y is pitch. Click empty space to add a note, drag to move,
 * drag the right end to resize, Delete removes, the lane below sets velocity. Every gesture is one undo step; edits go through
 * the timeline helpers (`updateClip`, `quantizeClip`, `transposeClip`).
 */
export function PianoRoll({ clipId, tl, bpm, grid, write, onClose }: { clipId: string; tl: TimelineData; bpm: number; grid: Grid; write: (t: TimelineData) => void; onClose: () => void }) {
  const { ed } = useApp();
  const clip = tl.clips.find((c) => c.id === clipId);
  const [pps, setPps] = useState(120);
  const [sel, setSel] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const notes = clip?.notes ?? [];
  const off = clip?.offset ?? 0;
  const spanLen = clip ? Math.max(0.5, clip.loop ? (clip.srcLength ?? clip.length) : clip.length) : 1;
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.t - off + n.d), 0);
  const width = Math.max(spanLen, lastEnd, 1) * pps + 40;

  useEffect(() => {
    root.current?.focus();
    const sc = scroller.current;
    if (!sc) return;
    const ns = clip?.notes ?? [];
    const mid = ns.length ? ns.reduce((a, n) => a + n.note, 0) / ns.length : 60;
    sc.scrollTop = Math.max(0, (HI - mid) * ROW_H - sc.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  if (!clip || !clip.notes) return null;
  const sorted = (list: TimelineNote[]) => [...list].sort((a, b) => a.t - b.t || a.note - b.note);
  const setNotes = (next: TimelineNote[]) => write(updateClip(tlRef.current, clipId, { notes: sorted(next) }));
  const gs = gridSeconds(bpm, grid) || 0.125;
  const snapT = (t: number, free: boolean) => Math.max(0, free ? t : snapTime(t, bpm, grid));
  const yToNote = (y: number) => Math.max(0, Math.min(127, HI - Math.floor(y / ROW_H)));

  const gesture = (e: React.PointerEvent, idx: number, part: 'move' | 'size') => {
    e.preventDefault();
    e.stopPropagation();
    setSel(idx);
    root.current?.focus();
    const base = notes.map((n) => ({ ...n }));
    const orig = base[idx];
    const x0 = e.clientX;
    const y0 = e.clientY;
    const baseTl = tlRef.current;
    ed.beginHold();
    const mv = (ev: PointerEvent) => {
      const next = base.map((n) => ({ ...n }));
      const n = next[idx];
      if (part === 'move') {
        n.t = snapT(orig.t + (ev.clientX - x0) / pps, ev.altKey);
        n.note = Math.max(0, Math.min(127, orig.note - Math.round((ev.clientY - y0) / ROW_H)));
      } else {
        const end = snapT(orig.t + orig.d + (ev.clientX - x0) / pps, ev.altKey);
        n.d = Math.max(gs * 0.25, end - orig.t);
      }
      // keep the array order (and so the selection) stable while dragging; it is sorted on release
      write(updateClip(baseTl, clipId, { notes: next }));
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      const cur = tlRef.current.clips.find((c) => c.id === clipId)?.notes ?? [];
      const moved = cur[idx];
      const order = sorted(cur);
      if (moved) setSel(order.indexOf(moved));
      write(updateClip(tlRef.current, clipId, { notes: order }));
      ed.endHold();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const addAt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = snapT((e.clientX - r.left) / pps, e.altKey) + off;
    const n: TimelineNote = { t, d: gs, note: yToNote(e.clientY - r.top), vel: 0.8 };
    const next = sorted([...notes, n]);
    write(updateClip(tlRef.current, clipId, { notes: next }));
    setSel(next.indexOf(n));
    root.current?.focus();
  };

  const velDrag = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(idx);
    const el = e.currentTarget.parentElement!;
    const base = notes.map((n) => ({ ...n }));
    const baseTl = tlRef.current;
    ed.beginHold();
    const set = (cy: number) => {
      const r = el.getBoundingClientRect();
      const v = Math.max(0.01, Math.min(1, 1 - (cy - r.top) / r.height));
      write(updateClip(baseTl, clipId, { notes: base.map((n, i) => (i === idx ? { ...n, vel: Math.round(v * 100) / 100 } : n)) }));
    };
    set(e.clientY);
    const mv = (ev: PointerEvent) => set(ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      ed.endHold();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const removeSel = () => {
    if (sel === null || !notes[sel]) return;
    setNotes(notes.filter((_, i) => i !== sel));
    setSel(null);
  };
  const key = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      removeSel();
    }
  };

  const rows: number[] = [];
  for (let n = HI; n >= LO; n--) rows.push(n);
  const beat = 60 / bpm;
  const vstep = gs >= beat ? beat : gs * (pps * gs < 8 ? 4 : 1);
  const vlines: number[] = [];
  for (let t = 0; t <= width / pps; t += vstep) vlines.push(t);
  const label = clip.name ?? 'MIDI clip';

  return createPortal(
    <div className="rs-pr" ref={root} tabIndex={-1} role="dialog" aria-label={`Piano roll: ${label}`} onKeyDown={key}>
      <div className="rs-pr__bar">
        <span className="rs-caps">Piano roll · {label}</span>
        <button className="rs-btn" onClick={() => write(quantizeClip(tlRef.current, clipId, bpm, grid))} disabled={grid === 'off'} title={grid === 'off' ? 'Choose a grid on the Timeline node first' : `Move notes to the ${grid} grid`}>Quantise</button>
        <button className="rs-btn" onClick={() => write(transposeClip(tlRef.current, clipId, -12))} title="Down an octave">−12</button>
        <button className="rs-btn" onClick={() => write(transposeClip(tlRef.current, clipId, -1))} title="Down a semitone">−1</button>
        <button className="rs-btn" onClick={() => write(transposeClip(tlRef.current, clipId, 1))} title="Up a semitone">+1</button>
        <button className="rs-btn" onClick={() => write(transposeClip(tlRef.current, clipId, 12))} title="Up an octave">+12</button>
        <button className="rs-btn rs-btn--danger" disabled={sel === null} onClick={removeSel}>Delete note</button>
        <span className="rs-tl__sp" />
        <div style={{ width: 120 }}><NumberField label="Zoom" min={20} max={600} integer value={pps} defaultValue={120} onChange={setPps} /></div>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onClose} aria-label="Close piano roll"><Icon name="close" /></button>
      </div>
      <div className="rs-pr__scroll" ref={scroller}>
        <div className="rs-pr__inner" style={{ width: width + KEYS_W, height: rows.length * ROW_H }}>
          <div className="rs-pr__keys" style={{ width: KEYS_W }}>
            {rows.map((n) => (
              <div key={n} className={`rs-pr__key${BLACK.has(n % 12) ? ' is-black' : ''}`} style={{ height: ROW_H }}>{n % 12 === 0 ? noteName(n) : ''}</div>
            ))}
          </div>
          <div className="rs-pr__grid" style={{ left: KEYS_W, width, height: rows.length * ROW_H }} onPointerDown={addAt}>
            {rows.map((n) => (
              <div key={n} className={`rs-pr__row${BLACK.has(n % 12) ? ' is-black' : ''}`} style={{ top: (HI - n) * ROW_H, height: ROW_H }} />
            ))}
            {vlines.map((t) => <i key={t} className="rs-pr__vl" style={{ left: t * pps }} />)}
            <i className="rs-pr__end" style={{ left: spanLen * pps }} title="End of the clip" />
            {notes.map((n, i) => (
              <div
                key={i}
                className={`rs-pr__note${i === sel ? ' is-sel' : ''}`}
                style={{ left: (n.t - off) * pps, width: Math.max(4, n.d * pps), top: (HI - n.note) * ROW_H, height: ROW_H - 1, opacity: 0.45 + n.vel * 0.55 }}
                title={`${noteName(n.note)} · velocity ${Math.round(n.vel * 127)}`}
                onPointerDown={(e) => gesture(e, i, 'move')}
              >
                <span className="rs-pr__grip" onPointerDown={(e) => gesture(e, i, 'size')} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="rs-pr__vel" style={{ height: VEL_H, marginLeft: KEYS_W }}>
        <div className="rs-pr__velin" style={{ width }}>
          {notes.map((n, i) => (
            <div key={i} className={`rs-pr__velbar${i === sel ? ' is-sel' : ''}`} style={{ left: (n.t - off) * pps, height: `${n.vel * 100}%` }} title={`Velocity ${Math.round(n.vel * 127)}: drag up or down`} onPointerDown={(e) => velDrag(e, i)} />
          ))}
        </div>
      </div>
      <div className="rs-tl__foot rs-insp__hint">Click to add a note · drag to move · drag the right end to resize · Delete removes · Alt: no snap · velocity lane below · {notes.length} notes</div>
    </div>,
    document.body,
  );
}
