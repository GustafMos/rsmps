import { useEffect, useRef, type RefObject } from 'react';
import { useIo } from '../store/context';

const SIZE = 176;

/** Nearest-neighbour magnifier under the cursor: shows real output pixels (100% or 200%) without changing the zoom. */
export function Loupe({ active, scale, box, stage }: { active: boolean; scale: 1 | 2; box: RefObject<HTMLDivElement | null>; stage: RefObject<HTMLDivElement | null> }) {
  const io = useIo();
  const cv = useRef<HTMLCanvasElement>(null);
  const bmp = useRef<ImageBitmap | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grab = async () => {
      try {
        const blob = await io.player.snapshot();
        if (blob && live) {
          bmp.current?.close();
          bmp.current = await createImageBitmap(blob);
          if (last.current) draw(last.current.x, last.current.y);
        }
      } catch {
        /* nothing shown yet */
      }
    };
    const draw = (cx: number, cy: number) => {
      const c = cv.current;
      const b = bmp.current;
      const st = stage.current?.getBoundingClientRect();
      if (!c || !b || !st) return;
      const inside = cx >= st.left && cx < st.right && cy >= st.top && cy < st.bottom;
      c.style.display = inside ? 'block' : 'none';
      if (!inside) return;
      const ix = ((cx - st.left) / st.width) * b.width;
      const iy = ((cy - st.top) / st.height) * b.height;
      const n = SIZE / scale; // source pixels shown
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.drawImage(b, Math.floor(ix - n / 2), Math.floor(iy - n / 2), n, n, 0, 0, SIZE, SIZE);
      ctx.strokeStyle = '#ffffff90';
      ctx.strokeRect(SIZE / 2 - scale / 2, SIZE / 2 - scale / 2, scale, scale);
      const bx = box.current!.getBoundingClientRect();
      c.style.left = `${Math.min(bx.width - SIZE - 8, cx - bx.left + 20)}px`;
      c.style.top = `${Math.min(bx.height - SIZE - 8, cy - bx.top + 20)}px`;
    };
    void grab();
    const el = box.current!;
    const move = (e: PointerEvent) => {
      last.current = { x: e.clientX, y: e.clientY };
      draw(e.clientX, e.clientY);
    };
    el.addEventListener('pointermove', move);
    const off = io.player.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(grab, 350);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      off();
      el.removeEventListener('pointermove', move);
    };
  }, [active, scale, io, box, stage]);

  if (!active) return null;
  return <canvas ref={cv} className="rs-loupe" width={SIZE} height={SIZE} style={{ display: 'none' }} aria-label={`Magnifier ${scale * 100}%`} />;
}
