import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ColorValue } from '../../engine/types';
import { hexOf, rgbOf } from '../lib/drag';
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
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);
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
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  large?: boolean;
  title?: string;
  label?: string;
}) {
  return (
    <select className={`rs-select${large ? ' rs-select--lg' : ''}`} value={value} data-nodrag title={title ?? label} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
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
  const css = `rgba(${Math.round(value[0] * 255)},${Math.round(value[1] * 255)},${Math.round(value[2] * 255)},${value[3]})`;
  return (
    <>
      <button ref={btn} type="button" className={`rs-color${large ? ' rs-color--lg' : ''}`} data-nodrag onClick={() => setOpen((o) => !o)} title="Edit colour">
        <span className="rs-swatch" style={{ ['--c' as string]: css }} />
        {label && <span className="rs-color__label">{label}</span>}
        <span className="rs-color__hex rs-mono">{hexOf(value).toUpperCase()}</span>
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)}>
          <ColorEditor value={value} onChange={onChange} />
        </Popover>
      )}
    </>
  );
}

function ColorEditor({ value, onChange }: { value: ColorValue; onChange: (v: ColorValue) => void }) {
  const [hex, setHex] = useState(hexOf(value));
  useEffect(() => setHex(hexOf(value)), [value]);
  const ch = (i: number, v: number) => {
    const next = [...value] as ColorValue;
    next[i] = i === 3 ? v : v / 255;
    onChange(next);
  };
  const pick = async () => {
    if (!window.EyeDropper) return;
    try {
      const r = await new window.EyeDropper().open();
      const rgb = rgbOf(r.sRGBHex);
      if (rgb) onChange([rgb[0], rgb[1], rgb[2], value[3]]);
    } catch {
      /* cancelled */
    }
  };
  return (
    <>
      <div className="rs-pop__row">
        <input
          type="color"
          value={hexOf(value)}
          style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--line-strong)', background: 'none' }}
          onChange={(e) => {
            const rgb = rgbOf(e.target.value);
            if (rgb) onChange([rgb[0], rgb[1], rgb[2], value[3]]);
          }}
        />
        <input
          className="rs-input rs-mono"
          style={{ flex: 1 }}
          value={hex}
          spellCheck={false}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            setHex(e.target.value);
            const rgb = rgbOf(e.target.value);
            if (rgb) onChange([rgb[0], rgb[1], rgb[2], value[3]]);
          }}
        />
        {window.EyeDropper && (
          <button className="rs-btn rs-btn--icon" type="button" onClick={pick} title="Pick a colour from the screen (eyedropper)">
            <Icon name="eyedrop" />
          </button>
        )}
      </div>
      <NumberField label="Red" value={Math.round(value[0] * 255)} min={0} max={255} integer onChange={(v) => ch(0, v)} />
      <NumberField label="Green" value={Math.round(value[1] * 255)} min={0} max={255} integer onChange={(v) => ch(1, v)} />
      <NumberField label="Blue" value={Math.round(value[2] * 255)} min={0} max={255} integer onChange={(v) => ch(2, v)} />
      <NumberField label="Alpha" value={value[3]} min={0} max={1} step={0.01} onChange={(v) => ch(3, v)} />
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
