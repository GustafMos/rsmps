import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ColorValue } from '../../engine/types';
import { hexOf } from '../lib/drag';
import {
  hslToRgb,
  hsvToRgb,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  rgbToOklch,
  toHex,
  type HSV,
  type RGB,
} from '../lib/colorMath';
import { pickFromViewer } from '../lib/eyedrop';
import { getRecentColors, pushRecentColor } from '../lib/recentColors';
import { useApp } from '../store/context';
import { FloatingPanel } from './FloatingPanel';
import { Icon } from './Icon';
import { NumberField } from './NumberField';
import './colorpicker.css';

const SIZE = 196;
const R_OUT = 94;
const R_IN = 76;
const HALF = Math.floor((R_IN - 5) / Math.SQRT2);

/** Palette colours of the palette param(s) on the selected node, offered as quick picks. */
function useNodePaletteColors(): RGB[] {
  const { ed, io } = useApp();
  return useMemo(() => {
    const s = ed.state;
    const node = s.selection.length === 1 ? s.graph.nodes.find((n) => n.id === s.selection[0]) : undefined;
    const def = node && io.registry.get(node.type);
    if (!node || !def) return [];
    const out: RGB[] = [];
    for (const [k, p] of Object.entries(def.params as Record<string, { type: string }>)) {
      if (p.type === 'palette' && Array.isArray(node.params[k])) out.push(...(node.params[k] as RGB[]));
    }
    return out.slice(0, 32);
  }, [ed, io]);
}

type Mode = 'HEX' | 'RGB' | 'HSV' | 'HSL';

export function ColorPicker({ value, onChange, alpha, extra, onCommit, onCancel }: {
  value: ColorValue;
  onChange: (v: ColorValue) => void;
  alpha: boolean;
  extra?: RGB[];
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { io, ed } = useApp();
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv([value[0], value[1], value[2]]));
  const [a, setA] = useState(alpha ? value[3] : 1);
  const [mode, setMode] = useState<Mode>('HEX');
  const before = useRef<ColorValue>(value);
  const last = useRef<string>('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLCanvasElement | null>(null);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const recent = useMemo(() => getRecentColors(), []);
  const nodeColors = useNodePaletteColors();

  const rgb = useMemo(() => hsvToRgb(hsv), [hsv]);

  // follow external changes (undo, another editor) without losing hue at s=0
  useEffect(() => {
    const sig = toHex(value) + value[3].toFixed(3);
    if (sig === last.current) return;
    last.current = sig;
    setHsv((cur) => {
      const n = rgbToHsv([value[0], value[1], value[2]]);
      const same = toHex(hsvToRgb(cur)) === toHex(value);
      return same ? cur : n[1] < 0.001 || n[2] < 0.001 ? [cur[0], n[1], n[2]] : n;
    });
    setA(alpha ? value[3] : 1);
  }, [value, alpha]);

  const emit = useCallback(
    (h: HSV, al: number) => {
      const c = hsvToRgb(h);
      last.current = toHex(c) + al.toFixed(3);
      setHsv(h);
      setA(al);
      onChange([c[0], c[1], c[2], alpha ? al : 1]);
    },
    [onChange, alpha],
  );

  /* ---------------------------- wheel drawing ---------------------------- */
  useEffect(() => {
    if (!ring.current) {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE * dpr;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(c.width, c.height);
      const cx = c.width / 2;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cx;
          const d = Math.hypot(dx, dy) / dpr;
          if (d < R_IN || d > R_OUT) continue;
          let h = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (h < 0) h += 360;
          const [r, g, b] = hsvToRgb([h, 1, 1]);
          const edge = Math.min(1, R_OUT - d + 0.5, d - R_IN + 0.5);
          const i = (y * c.width + x) * 4;
          img.data[i] = r * 255;
          img.data[i + 1] = g * 255;
          img.data[i + 2] = b * 255;
          img.data[i + 3] = Math.max(0, edge) * 255;
        }
      ctx.putImageData(img, 0, 0);
      ring.current = c;
    }
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(ring.current, 0, 0);
    // saturation / value square
    const side = HALF * 2 * dpr;
    const sq = ctx.createImageData(side, side);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const [r, g, b] = hsvToRgb([hsv[0], x / (side - 1), 1 - y / (side - 1)]);
        const i = (y * side + x) * 4;
        sq.data[i] = r * 255;
        sq.data[i + 1] = g * 255;
        sq.data[i + 2] = b * 255;
        sq.data[i + 3] = 255;
      }
    const c0 = (SIZE / 2 - HALF) * dpr;
    ctx.putImageData(sq, Math.round(c0), Math.round(c0));
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(Math.round(c0) - dpr, Math.round(c0) - dpr, side + 2 * dpr, side + 2 * dpr);
    // handles
    const mark = (x: number, y: number) => {
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, 6 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, 5 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    };
    const ang = (hsv[0] * Math.PI) / 180;
    const rm = (R_IN + R_OUT) / 2;
    mark(SIZE / 2 + Math.cos(ang) * rm, SIZE / 2 + Math.sin(ang) * rm);
    mark(SIZE / 2 - HALF + hsv[1] * 2 * HALF, SIZE / 2 - HALF + (1 - hsv[2]) * 2 * HALF);
  }, [hsv, dpr]);

  const wheelDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const dx0 = e.clientX - r.left - SIZE / 2;
    const dy0 = e.clientY - r.top - SIZE / 2;
    const zone = Math.hypot(dx0, dy0) > R_IN - 3 ? 'ring' : 'sq';
    ed.beginHold();
    el.dataset.zone = zone;
    const apply = (ev: { clientX: number; clientY: number }) => {
      const dx = ev.clientX - r.left - SIZE / 2;
      const dy = ev.clientY - r.top - SIZE / 2;
      if (zone === 'ring') {
        let h = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (h < 0) h += 360;
        emit([h, hsv[1], hsv[2]], a);
      } else {
        emit([hsv[0], Math.min(1, Math.max(0, (dx + HALF) / (2 * HALF))), Math.min(1, Math.max(0, 1 - (dy + HALF) / (2 * HALF)))], a);
      }
    };
    apply(e);
    const move = (ev: PointerEvent) => apply(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      ed.endHold();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /* ------------------------------ alpha slider ---------------------------- */
  const alphaDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    ed.beginHold();
    const apply = (cx: number) => emit(hsv, Math.round(Math.min(1, Math.max(0, (cx - r.left) / r.width)) * 100) / 100);
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      ed.endHold();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /* -------------------------------- fields -------------------------------- */
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const hexShown = toHex(rgb, alpha ? a : undefined);
  const setRgb = (c: RGB, al = a) => {
    const n = rgbToHsv(c);
    emit(n[1] < 0.001 || n[2] < 0.001 ? [hsv[0], n[1], n[2]] : n, al);
  };
  const rgb255 = rgb.map((v) => Math.round(v * 255));
  const hsl = rgbToHsl(rgb);
  const lch = rgbToOklch(rgb);

  const setSwatch = (c: RGB) => {
    ed.beginHold();
    setRgb(c);
    ed.endHold();
  };

  const eyedrop = async () => {
    try {
      const c = await pickFromViewer(io);
      if (c) setSwatch(c);
    } catch (err) {
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const nativeDrop = async () => {
    try {
      const r = await new window.EyeDropper!().open();
      const p = parseHex(r.sRGBHex);
      if (p) setSwatch(p.rgb);
    } catch {
      /* cancelled */
    }
  };

  const sugg = [...(extra ?? []), ...nodeColors].filter((c, i, arr) => arr.findIndex((d) => toHex(d) === toHex(c)) === i).slice(0, 24);
  const css = (c: readonly number[], al = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${al})`;

  return (
    <div className="rs-cp" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.stopPropagation(); onCommit(); }
    }}>
      <canvas ref={canvas} className="rs-cp__wheel" width={SIZE * dpr} height={SIZE * dpr} style={{ width: SIZE, height: SIZE }} onPointerDown={wheelDown} tabIndex={0} aria-label="Hue ring and saturation/value square. Arrow keys adjust saturation and value; Shift+arrows adjust hue."
        onKeyDown={(e) => {
          const st = e.ctrlKey ? 0.1 : 0.02;
          if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { emit([(hsv[0] + (e.key === 'ArrowRight' ? 3 : -3) + 360) % 360, hsv[1], hsv[2]], a); e.preventDefault(); }
          else if (e.key === 'ArrowLeft') { emit([hsv[0], Math.max(0, hsv[1] - st), hsv[2]], a); e.preventDefault(); }
          else if (e.key === 'ArrowRight') { emit([hsv[0], Math.min(1, hsv[1] + st), hsv[2]], a); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { emit([hsv[0], hsv[1], Math.min(1, hsv[2] + st)], a); e.preventDefault(); }
          else if (e.key === 'ArrowDown') { emit([hsv[0], hsv[1], Math.max(0, hsv[2] - st)], a); e.preventDefault(); }
        }} />
      {alpha && (
        <div className="rs-cp__alpha" onPointerDown={alphaDown} role="slider" aria-label="Alpha" aria-valuenow={a} tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft') emit(hsv, Math.max(0, a - 0.05)); if (e.key === 'ArrowRight') emit(hsv, Math.min(1, a + 0.05)); }}>
          <div className="rs-cp__alpha-fill" style={{ background: `linear-gradient(90deg, ${css(rgb, 0)}, ${css(rgb, 1)})` }} />
          <div className="rs-cp__alpha-knob" style={{ left: `${a * 100}%` }} />
        </div>
      )}
      <div className="rs-cp__row">
        <div className="rs-cp__ba" title="Click the left half to revert to the original color">
          <button className="rs-cp__before rs-swatch" style={{ ['--c' as string]: css(before.current, before.current[3]) }} onClick={() => { const b = before.current; ed.beginHold(); setRgb([b[0], b[1], b[2]], b[3]); ed.endHold(); }} aria-label="Original color (click to revert)" />
          <span className="rs-cp__after rs-swatch" style={{ ['--c' as string]: css(rgb, a) }} />
        </div>
        <div className="rs-cp__modes" role="tablist">
          {(['HEX', 'RGB', 'HSV', 'HSL'] as Mode[]).map((m) => (
            <button key={m} className={m === mode ? 'is-on' : ''} role="tab" aria-selected={m === mode} onClick={() => setMode(m)}>{m}</button>
          ))}
        </div>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={eyedrop} title="Pick a color from the viewer image"><Icon name="eyedrop" /></button>
        {window.EyeDropper && <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={nativeDrop} title="Pick a color from anywhere on screen"><Icon name="focus" /></button>}
      </div>

      {mode === 'HEX' && (
        <input
          className="rs-input rs-mono rs-cp__hex"
          value={hexDraft ?? hexShown}
          spellCheck={false}
          aria-label="Hex color"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setHexDraft(e.target.value);
            const p = parseHex(e.target.value);
            if (p) { ed.beginHold(); setRgb(p.rgb, p.a ?? a); ed.endHold(); }
          }}
          onBlur={() => setHexDraft(null)}
        />
      )}
      {mode === 'RGB' && (
        <div className="rs-cp__nums">
          {(['R', 'G', 'B'] as const).map((l, i) => (
            <NumberField key={l} label={l} integer min={0} max={255} value={rgb255[i]} onChange={(v) => { const c = [...rgb] as RGB; c[i] = v / 255; setRgb(c); }} />
          ))}
        </div>
      )}
      {mode === 'HSV' && (
        <div className="rs-cp__nums">
          <NumberField label="H" integer min={0} max={360} value={Math.round(hsv[0])} onChange={(v) => emit([v, hsv[1], hsv[2]], a)} />
          <NumberField label="S" integer min={0} max={100} value={Math.round(hsv[1] * 100)} onChange={(v) => emit([hsv[0], v / 100, hsv[2]], a)} />
          <NumberField label="V" integer min={0} max={100} value={Math.round(hsv[2] * 100)} onChange={(v) => emit([hsv[0], hsv[1], v / 100], a)} />
        </div>
      )}
      {mode === 'HSL' && (
        <div className="rs-cp__nums">
          <NumberField label="H" integer min={0} max={360} value={Math.round(hsv[0])} onChange={(v) => setRgb(hslToRgb([v, hsl[1], hsl[2]]), a)} />
          <NumberField label="S" integer min={0} max={100} value={Math.round(hsl[1] * 100)} onChange={(v) => setRgb(hslToRgb([hsv[0], v / 100, hsl[2]]), a)} />
          <NumberField label="L" integer min={0} max={100} value={Math.round(hsl[2] * 100)} onChange={(v) => setRgb(hslToRgb([hsv[0], hsl[1], v / 100]), a)} />
        </div>
      )}
      {alpha && mode !== 'HEX' && <NumberField label="Alpha" min={0} max={1} step={0.01} value={a} onChange={(v) => emit(hsv, v)} />}
      <div className="rs-cp__ok rs-mono" title="Perceptual lightness, chroma and hue (OKLCH)">
        OKLCH {lch[0].toFixed(2)} {lch[1].toFixed(3)} {Math.round(lch[2])}°
      </div>

      {recent.length > 0 && <Swatches title="Recent" colors={recent} onPick={setSwatch} />}
      {sugg.length > 0 && <Swatches title="From palette" colors={sugg} onPick={setSwatch} />}
    </div>
  );
}

function Swatches({ title, colors, onPick }: { title: string; colors: RGB[]; onPick: (c: RGB) => void }) {
  return (
    <div className="rs-cp__sw">
      <span className="rs-caps">{title}</span>
      <div>
        {colors.map((c, i) => (
          <button key={i} className="rs-cp__chip" style={{ background: hexOf(c) }} title={toHex(c)} onClick={() => onPick(c)} />
        ))}
      </div>
    </div>
  );
}

/**
 * The picker in a shared FloatingPanel opened beside its swatch: non-modal (the app stays live and the value updates as you
 * drag), movable by the header, remembers where you put it for the session. Enter / the close button keeps the colour,
 * Esc (while the picker has focus) puts the original back. No long-lived undo hold: the store coalesces same-param edits.
 */
export function ColorPopover({ anchor, value, onChange, onClose, alpha = true, extra }: {
  anchor: HTMLElement | null;
  value: ColorValue;
  onChange: (v: ColorValue) => void;
  onClose: () => void;
  alpha?: boolean;
  extra?: RGB[];
}) {
  const initial = useRef(value);
  const latest = useRef(value);
  const done = useRef(false);

  const wrapped = useCallback((v: ColorValue) => { latest.current = v; onChange(v); }, [onChange]);
  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    pushRecentColor([latest.current[0], latest.current[1], latest.current[2]]);
    onClose();
  }, [onClose]);
  const cancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onChange(initial.current);
    onClose();
  }, [onChange, onClose]);

  return (
    <FloatingPanel id="colour-picker" title="Color" onClose={commit} onEscape={cancel} anchor={anchor} session compact defaultSize={{ w: 240, h: 372 }} minSize={{ w: 240, h: 100 }}>
      <ColorPicker value={value} onChange={wrapped} alpha={alpha} extra={extra} onCommit={commit} onCancel={cancel} />
    </FloatingPanel>
  );
}
