import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ColorValue } from '../../engine/types';
import { hexOf } from '../lib/drag';
import { ColorPopover } from './ColorPicker';
import { useOverlay } from '../lib/overlay';
import { Icon } from './Icon';
import { NumberField } from './NumberField';
import './fields.css';

/* ------------------------------ Popover ---------------------------------- */

export function Popover({ anchor, onClose, children, width = 240 }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -999, y: -999 });
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    let x = a.left;
    let y = a.bottom + 4;
    if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, a.top - r.height - 4);
    setPos({ x: Math.max(8, x), y });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  useOverlay(onClose);
  return createPortal(
    <div ref={ref} className="rs-pop" style={{ left: pos.x, top: pos.y, width }} data-nodrag>
      {children}
    </div>,
    document.body,
  );
}

/* -------------------------------- Check ---------------------------------- */

export function CheckField({ value, onChange, label, title, disabled }: { value: boolean; onChange: (v: boolean) => void; label?: string; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`rs-check${value ? ' is-on' : ''}`}
      role="checkbox"
      aria-checked={value}
      data-nodrag
      disabled={disabled}
      title={title}
      onClick={() => onChange(!value)}
    >
      <span className="rs-check__box">
        <Icon name="check" size={12} />
      </span>
      {label && <span className="rs-check__label">{label}</span>}
    </button>
  );
}

/* ------------------------------- Select ---------------------------------- */

export function SelectField({
  value,
  options,
  onChange,
  large,
  title,
  label,
}: {
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean; group?: string }[];
  onChange: (v: string) => void;
  large?: boolean;
  title?: string;
  label?: string;
}) {
  return (
    <select className={`rs-select${large ? ' rs-select--lg' : ''}`} value={value} data-nodrag title={title ?? label} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {options.some((o) => o.group)
        ? [...new Set(options.map((o) => o.group ?? ''))].map((g) => {
            const items = options.filter((o) => (o.group ?? '') === g).map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ));
            return g ? <optgroup key={g} label={g}>{items}</optgroup> : items;
          })
        : options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
    </select>
  );
}

/* -------------------------------- Text ----------------------------------- */

export function TextField({ value, onChange, multiline, large, placeholder }: { value: string; onChange: (v: string) => void; multiline?: boolean; large?: boolean; placeholder?: string }) {
  const cls = `rs-text${large ? ' rs-text--lg' : ''}`;
  return multiline ? (
    <textarea className={cls} data-nodrag value={value} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
  ) : (
    <input className={cls} data-nodrag value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
  );
}

/* -------------------------------- Colour --------------------------------- */

declare global {
  interface Window {
    EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> };
  }
}

export function ColorField({ value, onChange, label, large }: { value: ColorValue; onChange: (v: ColorValue) => void; label?: string; large?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const css = `rgba(${Math.round(value[0] * 255)},${Math.round(value[1] * 255)},${Math.round(value[2] * 255)},${value[3]})`;
  return (
    <>
      <button ref={btn} type="button" className={`rs-color${large ? ' rs-color--lg' : ''}`} data-nodrag onClick={() => setOpen((o) => !o)} title="Edit color" aria-haspopup="dialog" aria-expanded={open}>
        <span className="rs-swatch" style={{ ['--c' as string]: css }} />
        {label && <span className="rs-color__label">{label}</span>}
        <span className="rs-color__hex rs-mono">{hexOf(value).toUpperCase()}</span>
      </button>
      {open && <ColorPopover anchor={btn.current} value={value} onChange={onChange} onClose={close} />}
    </>
  );
}

/* --------------------------------- Vec2 ---------------------------------- */

export function Vec2Field({
  value,
  onChange,
  min,
  max,
  step,
  unit,
  defaultValue,
  large,
}: {
  value: [number, number];
  onChange: (v: [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue?: [number, number];
  large?: boolean;
}) {
  const v = Array.isArray(value) ? value : [0, 0];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, width: '100%' }}>
      <NumberField large={large} label="X" value={v[0]} min={min} max={max} step={step} unit={unit} defaultValue={defaultValue?.[0]} onChange={(x) => onChange([x, v[1]])} />
      <NumberField large={large} label="Y" value={v[1]} min={min} max={max} step={step} unit={unit} defaultValue={defaultValue?.[1]} onChange={(y) => onChange([v[0], y])} />
    </div>
  );
}
