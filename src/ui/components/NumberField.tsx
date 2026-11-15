import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clamp } from '../lib/drag';
import { NumberConfirm, isQuiet } from './NumberConfirm';
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
  const gesture = useRef<{ x0: number; v0: number; moved: boolean; w: number } | null>(null);

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

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (editing || p.disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { x0: e.clientX, v0: value, moved: false, w: e.currentTarget.getBoundingClientRect().width };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    if (!g.moved && Math.abs(dx) < 3) return;
    g.moved = true;
    const fine = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
    let v: number;
    const span = (p.softMax ?? max!) - min!;
    if (bounded) v = g.v0 + (dx / Math.max(80, g.w)) * span * fine;
    else v = g.v0 + (dx / 3) * step * fine;
    p.onChange(fix(v, true));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
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
      onDoubleClick={reset}
      onKeyDown={keys}
    >
      {bounded && <div className="rs-nf__fill" style={{ width: `${frac * 100}%` }} />}
      {p.label && <span className="rs-nf__label">{p.label}</span>}
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
      {editing ? (
        <input
          className="rs-nf__input rs-num"
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
