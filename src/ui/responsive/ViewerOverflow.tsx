import { useState } from 'react';
import { Icon } from '../components/Icon';
import { MenuPopup } from '../components/Menu';
import { useSelector } from '../store/createStore';
import { viewerMore } from '../viewer/viewerMore';

/**
 * The viewer toolbar is too wide for a phone, so the viewer keeps only its name and preview scale in the bar and publishes every other
 * control as menu rows (viewerMore). This "…" in the viewer header opens them.
 */
export function ViewerOverflow() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const items = useSelector(viewerMore, (s) => s.items);
  return (
    <>
      <button
        className="rs-btn rs-btn--icon rs-btn--ghost"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.right - 8, y: r.bottom + 2 }); }}
        aria-label="More viewer tools"
        aria-haspopup="menu"
      >
        <Icon name="more" size={18} />
      </button>
      {at && <MenuPopup x={Math.max(8, at.x - 260)} y={at.y} items={items.length ? items : [{ label: 'Nothing more here', disabled: true }]} onClose={() => setAt(null)} />}
    </>
  );
}
