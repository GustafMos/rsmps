import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clamp } from '../lib/drag';
import { NumberConfirm, isQuiet } from './NumberConfirm';
import { scrubIntent, stepValue } from '../responsive/touchNumber';
import './fields.css';

export interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
  defaultValue?: number;
  /** Typical maximum: scrubbing stops here and typed values above it ask for confirmation. */
  softMax?: number;
  /** Identifies the field for "don't ask again" (defaults to the label). */
  askKey?: string;
  /** Name used in the confirmation text (defaults to the label). */
  name?: string;
  disabled?: boolean;
  title?: string;
  /** Larger variant for the inspector. */
  large?: boolean;
}

const UNIT_LABEL: Record<string, string> = { px: 'px', norm: '', deg: '°', '%': '%', s: 's', hz: 'Hz', db: 'dB', st: 'st', cycles: '×' };

export function formatNumber(v: number, integer?: boolean): string {
  if (!Number.isFinite(v)) return '0';
  if (integer) return String(Math.round(v));
  const a = Math.abs(v);
  const digits = a >= 1000 ? 1 : a >= 100 ? 2 : 3;
  return String(Number(v.toFixed(digits)));
}

/**
 * Blender-style number field: drag to scrub, click to type, double-click to reset.
 * The label sits inside the field; bounded fields show a fill like a slider.
 */
export function NumberField(p: NumberFieldProps) {
  const { value, min, max, integer } = p;
  const step = p.step ?? (integer ? 1 : 0.01);
  const bounded = min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && max > min;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x0: number; y0: number; lastX: number; v0: number; vf: number; moved: boolean; id: number } | null>(null);
  const [mode, setMode] = useState<'fine' | 'coarse' | null>(null);

  const fix = (v: number, scrub = false) => {
    let n = v;
    if (min !== undefined) n = Math.max(min, n);
    const top = scrub ? (p.softMax ?? max) : max;
    if (top !== undefined) n = Math.min(top, n);
    if (integer) n = Math.round(n);
    else if (step > 0) {
      const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1));
      n = Number(n.toFixed(decimals));
    }
    return n;
  };

  /**
   * Units per pixel for scrubbing, from the param's own scale (not its hard range): the whole soft range takes ~400 px, so a
   * 100 px drag moves at most a quarter of it. Short ranges (few steps) get at most 12 px per step. Without a range the rate follows
   * the value itself (0.5% per px, never below half a step).
   */
  const rate = (v: number) => {
    let top = p.softMax ?? max;
    // a very wide hard range with no soft max (blur radius 0..400, default 8): scale by the default instead, so a drag stays usable
    const dv = p.defaultValue;
    if (p.softMax === undefined && top !== undefined && dv !== undefined && dv > 0 && top > dv * 25) top = Math.max(dv * 16, (min ?? 0) + step * 400);
    if (min !== undefined && top !== undefined && Number.isFinite(min) && Number.isFinite(top) && top > min) {
      const n = (top - min) / step;
      const pxPerStep = Math.min(12, 400 / n);
      return step / pxPerStep;
    }
    return Math.max(step * 0.5, Math.abs(v) * 0.005, 0.005);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (editing || p.disabled || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-gone pointer: scrubbing still works while the pointer stays over the field */
    }
    gesture.current = { x0: e.clientX, y0: e.clientY, lastX: e.clientX, v0: value, vf: value, moved: false, id: e.pointerId };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (e.buttons === 0) {
      // the button was released somewhere we did not see (lost capture): the drag is over, never scrub on a plain hover
      gesture.current = null;
      setMode(null);
      return;
    }
    if (!g.moved) {
      // Dead zone: a click (even a slightly shaky one) never changes the value. No pointer lock: locking on a click made some
      // browsers report large bogus movement, which sent the value flying.
      if (Math.abs(e.clientX - g.x0) < 6) {
        // on touch a vertical drag is page scroll (the field has touch-action: pan-y): do not treat it as a scrub or a tap
        if (e.pointerType === 'touch' && scrubIntent(e.clientX - g.x0, e.clientY - g.y0) === 'scroll') gesture.current = null;
        return;
      }
      g.moved = true;
      g.lastX = e.clientX;
      return;
    }
    let d = e.clientX - g.lastX;
    g.lastX = e.clientX;
    if (Math.abs(d) > 60) d = 0; // outlier jump (lost capture, cursor warp): ignore it
    const mult = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
    const m = e.shiftKey ? 'fine' : e.ctrlKey || e.metaKey ? 'coarse' : null;
    setMode((cur) => (cur === m ? cur : m));
    g.vf += d * rate(g.v0) * mult; // rate from the value at the START of the drag: linear, never runaway growth // accumulates sub-pixel / sub-step movement; integers round only on output
    p.onChange(fix(g.vf, true));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setMode(null);
    if (!g) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g.moved) {
      setDraft(formatNumber(value, integer));
      setEditing(true);
    }
  };
  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(n)) return;
    const fixed = fix(n);
    const key = p.askKey ?? p.label ?? '';
    const overSoft = p.softMax !== undefined && fixed > p.softMax;
    const jump = Math.abs(value) > 0 && fixed > Math.abs(value) * 20 && fixed > Math.abs(p.defaultValue ?? 0) * 20;
    if ((overSoft || jump) && !isQuiet(key)) setConfirm(fixed);
    else p.onChange(fixed);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (e.key === 'Escape' && gesture.current) {
      // Esc reverts the drag in progress
      const g = gesture.current;
      gesture.current = null;
      setMode(null);
      if (root.current?.hasPointerCapture(g.id)) root.current.releasePointerCapture(g.id);
      if (g.moved) p.onChange(fix(g.v0));
      e.stopPropagation();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      p.onChange(fix(value - step * (e.shiftKey ? 10 : 1)));
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      p.onChange(fix(value + step * (e.shiftKey ? 10 : 1)));
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Enter') {
      setDraft(formatNumber(value, integer));
      setEditing(true);
    }
  };
  const reset = () => {
    if (p.defaultValue !== undefined && !p.disabled) {
      setEditing(false);
      p.onChange(fix(p.defaultValue));
    }
  };

  // wheel nudges by one step, but only while the field has keyboard focus (plain hover must never change a value)
  const live = useRef({ value, step, fix, onChange: p.onChange });
  live.current = { value, step, fix, onChange: p.onChange };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      const l = live.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      l.onChange(l.fix(l.value + dir * l.step * (e.shiftKey ? 0.1 : 1)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const unit = p.unit ? (UNIT_LABEL[p.unit] ?? p.unit) : '';
  const frac = bounded ? clamp((value - min!) / ((p.softMax ?? max!) - min!), 0, 1) : 0;
  const changed = p.defaultValue !== undefined && Math.abs(p.defaultValue - value) > 1e-9;

  return (
    <div
      ref={root}
      className={`rs-nf${p.large ? ' rs-nf--lg' : ''}${bounded ? ' rs-nf--bounded' : ''}${p.disabled ? ' is-disabled' : ''}${changed ? ' is-changed' : ''}`}
      data-nodrag
      tabIndex={p.disabled ? -1 : 0}
      role="spinbutton"
      aria-valuenow={value}
      aria-label={p.label}
      title={p.title ?? 'Drag to scrub · click to type · double-click to reset'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { gesture.current = null; setMode(null); }}
      onLostPointerCapture={() => { if (gesture.current?.moved) { gesture.current = null; setMode(null); } }}
      onDoubleClick={reset}
      onKeyDown={keys}
    >
      {bounded && <div className="rs-nf__fill" style={{ width: `${frac * 100}%` }} />}
      <button type="button" className="rs-nf__step rs-nf__step--dec" tabIndex={-1} disabled={p.disabled} aria-label={`Decrease ${p.label ?? 'value'}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onChange(fix(stepValue(value, -1, { step, min, max, integer })))}>−</button>
      {p.label && <span className="rs-nf__label">{p.label}</span>}
      {mode && <span className="rs-nf__mode" aria-hidden="true">{mode === 'fine' ? 'Fine ÷10' : 'Coarse ×10'}</span>}
      {confirm !== null && (
        <NumberConfirm
          anchor={root.current}
          value={confirm}
          label={p.name ?? p.label ?? 'this field'}
          softMax={p.softMax}
          askKey={p.askKey ?? p.label ?? ''}
          format={(n) => formatNumber(n, integer)}
          onUse={(v) => {
            setConfirm(null);
            p.onChange(v);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      <button type="button" className="rs-nf__step rs-nf__step--inc" tabIndex={-1} disabled={p.disabled} aria-label={`Increase ${p.label ?? 'value'}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onChange(fix(stepValue(value, 1, { step, min, max, integer })))}>+</button>
      {editing ? (
        <input
          className="rs-nf__input rs-num"
          inputMode={min !== undefined && min >= 0 ? (integer ? 'numeric' : 'decimal') : undefined} // a numeric keypad has no minus sign: fields that can go negative keep the full keyboard
          enterKeyHint="done"
          autoFocus
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="rs-nf__value rs-num">
          {formatNumber(value, integer)}
          {unit && <span className="rs-nf__unit">{unit}</span>}
        </span>
      )}
    </div>
  );
}
