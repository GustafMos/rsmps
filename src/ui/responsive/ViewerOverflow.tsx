import { useState } from 'react';
import { Icon } from '../components/Icon';
import { MenuPopup, type MenuItem } from '../components/Menu';

/**
 * The viewer toolbar is too wide for a phone, so its less-used buttons are hidden there (responsive.css) and listed here instead:
 * one "…" that offers every button the bar has hidden, by its own title, and presses it. It reads the toolbar as it is, so a button
 * another feature adds to the viewer later is reachable on a phone without anyone touching this file.
 */
export function ViewerOverflow() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.right - 8, y: r.bottom + 2 });
  };
  const items = (): MenuItem[] => {
    const bar = document.querySelector('.rs-viewer__bar');
    if (!bar) return [];
    const out: MenuItem[] = [];
    for (const b of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) {
      if (getComputedStyle(b).display !== 'none') continue; // only what the phone layout hid
      const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().split(/\s*\(/)[0].replace(/\s+/g, ' ');
      if (!label) continue;
      out.push({ label: label.length > 64 ? `${label.slice(0, 61)}…` : label, disabled: b.disabled, onClick: () => b.click() });
    }
    return out;
  };
  return (
    <>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={(e) => open(e.currentTarget)} aria-label="More viewer tools" aria-haspopup="menu">
        <Icon name="more" size={18} />
      </button>
      {at && (
        <MenuPopup
          x={Math.max(8, at.x - 260)}
          y={at.y}
          items={items().length ? items() : [{ label: 'Nothing more here', disabled: true }]}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}
