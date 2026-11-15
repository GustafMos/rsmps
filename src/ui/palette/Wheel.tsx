import { useEffect, useRef } from 'react';
import { hsvToRgb, toHex } from '../lib/colorMath';
import { useApp } from '../store/context';
import { swatchRgb, type Swatch } from './model';

const SIZE = 340;
const R = 160;
const C = SIZE / 2;

/** Hue/saturation disc with one draggable handle per swatch, joined to the centre by spokes. */
export function Wheel({ swatches, base, sel, onSelect, onDrag }: {
  swatches: Swatch[];
  base: number;
  sel: number;
  onSelect: (i: number) => void;
  onDrag: (i: number, h: number, s: number) => void;
}) {
  const { ed } = useApp();
  const canvas = useRef<HTMLCanvasElement>(null);
  const disc = useRef<{ v: number; c: HTMLCanvasElement } | null>(null);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const dispV = Math.round(Math.max(0.35, swatches[base]?.v ?? 1) * 20) / 20;

  useEffect(() => {
    if (!disc.current || disc.current.v !== dispV) {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE * dpr;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const dx = (x + 0.5) / dpr - C;
          const dy = (y + 0.5) / dpr - C;
          const d = Math.hypot(dx, dy);
          if (d > R) continue;
          let h = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (h < 0) h += 360;
          const [r, g, b] = hsvToRgb([h, d / R, dispV]);
          const i = (y * c.width + x) * 4;
          img.data[i] = r * 255;
          img.data[i + 1] = g * 255;
          img.data[i + 2] = b * 255;
          img.data[i + 3] = Math.min(1, R - d + 0.5) * 255;
        }
      ctx.putImageData(img, 0, 0);
      disc.current = { v: dispV, c };
    }
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(disc.current.c, 0, 0, SIZE, SIZE);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(C, C, R + 0.5, 0, Math.PI * 2);
    ctx.stroke();
    const pos = swatches.map((s) => {
      const a = (s.h * Math.PI) / 180;
      return { x: C + Math.cos(a) * s.s * R, y: C + Math.sin(a) * s.s * R };
    });
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000b0';
    pos.forEach((p) => {
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffffd0';
    pos.forEach((p) => {
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    pos.forEach((p, i) => {
      const r = i === base ? 12 : 9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = toHex(swatchRgb(swatches[i]));
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.lineWidth = i === sel ? 2.5 : 1.5;
      ctx.strokeStyle = i === sel ? '#ffd24a' : '#fff';
      ctx.stroke();
      if (swatches[i].locked) {
        ctx.fillStyle = '#000';
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
    });
  }, [swatches, base, sel, dispV, dpr]);

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    const p = at(e);
    let best = -1;
    let bd = 16;
    swatches.forEach((s, i) => {
      const a = (s.h * Math.PI) / 180;
      const d = Math.hypot(C + Math.cos(a) * s.s * R - p.x, C + Math.sin(a) * s.s * R - p.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best < 0) best = base;
    el.setPointerCapture(e.pointerId);
    onSelect(best);
    ed.beginHold();
    const apply = (ev: { clientX: number; clientY: number }) => {
      const q = at(ev);
      const dx = q.x - C;
      const dy = q.y - C;
      let h = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (h < 0) h += 360;
      onDrag(best, h, Math.min(1, Math.hypot(dx, dy) / R));
    };
    if (best === base && bd >= 16) apply(e);
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

  return (
    <canvas
      ref={canvas}
      className="rs-wheel"
      width={SIZE * dpr}
      height={SIZE * dpr}
      style={{ width: SIZE, height: SIZE }}
      onPointerDown={down}
      aria-label="Colour wheel: drag a handle to change its hue and saturation"
    />
  );
}
