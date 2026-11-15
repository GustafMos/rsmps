import type { Io } from '../../io/api';
import type { RGB } from './colorMath';

/** Sample the colour under the pointer from the viewer image, with a magnifier loupe. Resolves null on Esc. */
export async function pickFromViewer(io: Io): Promise<RGB | null> {
  const blob = await io.player.snapshot();
  const canvasEl = document.querySelector<HTMLCanvasElement>('.rs-viewer__canvas');
  if (!blob || !canvasEl) throw new Error('Nothing is shown in the viewer yet.');
  const bmp = await createImageBitmap(blob);
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const ctx = off.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);

  return new Promise<RGB | null>((resolve) => {
    const shield = document.createElement('div');
    shield.style.cssText = 'position:fixed;inset:0;z-index:2000;cursor:crosshair;touch-action:none';
    const loupe = document.createElement('canvas');
    const N = 11;
    const Z = 12;
    loupe.width = loupe.height = N * Z;
    loupe.style.cssText = `position:fixed;display:none;width:${N * Z}px;height:${N * Z}px;border:2px solid #fff;outline:1px solid #000;pointer-events:none;image-rendering:pixelated;z-index:2001;box-shadow:3px 3px 0 #0008`;
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;display:none;z-index:2001;pointer-events:none;font:600 12px ui-monospace,Consolas,monospace;padding:2px 6px;background:#000;color:#fff;border:1px solid #fff';
    const hint = document.createElement('div');
    hint.textContent = 'Click the viewer image to pick a colour. Esc cancels.';
    hint.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2001;padding:6px 12px;background:#17191d;color:#ecedf0;border:1px solid #3d424b;font:12px system-ui;pointer-events:none';
    document.body.append(shield, loupe, label, hint);
    const lctx = loupe.getContext('2d')!;
    lctx.imageSmoothingEnabled = false;

    const at = (cx: number, cy: number) => {
      const r = canvasEl.getBoundingClientRect();
      if (cx < r.left || cx >= r.right || cy < r.top || cy >= r.bottom) return null;
      return { x: Math.min(off.width - 1, Math.floor(((cx - r.left) / r.width) * off.width)), y: Math.min(off.height - 1, Math.floor(((cy - r.top) / r.height) * off.height)) };
    };
    const color = (p: { x: number; y: number }): RGB => {
      const d = ctx.getImageData(p.x, p.y, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    };
    const hex = (c: RGB) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    const done = (v: RGB | null) => {
      shield.remove();
      loupe.remove();
      label.remove();
      hint.remove();
      window.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    window.addEventListener('keydown', key, true);
    shield.addEventListener('pointermove', (e) => {
      const p = at(e.clientX, e.clientY);
      if (!p) {
        loupe.style.display = label.style.display = 'none';
        return;
      }
      lctx.clearRect(0, 0, loupe.width, loupe.height);
      lctx.drawImage(off, p.x - (N >> 1), p.y - (N >> 1), N, N, 0, 0, N * Z, N * Z);
      lctx.strokeStyle = '#fff';
      lctx.lineWidth = 2;
      lctx.strokeRect((N >> 1) * Z, (N >> 1) * Z, Z, Z);
      loupe.style.display = label.style.display = 'block';
      loupe.style.left = `${e.clientX + 18}px`;
      loupe.style.top = `${e.clientY + 18}px`;
      label.textContent = hex(color(p));
      label.style.left = `${e.clientX + 18}px`;
      label.style.top = `${e.clientY + 18 + N * Z + 8}px`;
    });
    shield.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = at(e.clientX, e.clientY);
      done(p ? color(p) : null);
    });
  });
}
