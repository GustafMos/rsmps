import { type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { toggleMediaPanel, useMedia } from '../store/media';
import { useApp, useEd } from '../store/context';
import { dispatchShell, useShell } from './shellStore';
import type { Side } from './shellState';
import { useViewportClass } from './viewport';

/**
 * Tablet: the media panel and the inspector are drawers that slide over the work area (a scrim closes them) and can be pinned, which
 * docks them beside it like on a desktop. Other sizes: the children are rendered as they are.
 */
export function TabletDrawer({ side, title, children }: { side: Side; title: string; children: ReactNode }) {
  const cls = useViewportClass();
  const pinned = useShell((s) => s.pinned[side]);
  const open = useShell((s) => s.open[side]);
  if (cls !== 'tablet') return <>{children}</>;
  const shown = pinned || open;
  if (!shown) return null;
  return (
    <>
      {open && !pinned && <div className="rs-tscrim" onPointerDown={() => dispatchShell({ type: 'closeOverlays' })} aria-hidden="true" />}
      <div className={`rs-drawer rs-drawer--${side}${pinned ? ' is-pinned' : ''}`} role={pinned ? 'complementary' : 'dialog'} aria-label={title}>
        <div className="rs-drawer__head">
          <span className="rs-caps">{title}</span>
          <span className="rs-pshell__spacer" />
          <button className={`rs-btn rs-btn--icon rs-btn--ghost${pinned ? ' is-on' : ''}`} onClick={() => dispatchShell({ type: 'panel', side, op: 'pin' })} aria-pressed={pinned} aria-label={pinned ? `Unpin the ${title} drawer` : `Pin the ${title} drawer beside the work area`} title={pinned ? 'Unpin: it slides over the work area again' : 'Pin: dock it beside the work area'}>
            <Icon name="pin" size={16} />
          </button>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => dispatchShell({ type: 'panel', side, op: 'close' })} aria-label={`Close the ${title} drawer`}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="rs-drawer__body">{children}</div>
      </div>
    </>
  );
}

/**
 * What the two panel buttons in the top bar do and show. Desktop: exactly what they always did (fold the media panel to its rail,
 * hide the inspector). Tablet: open / close the drawers.
 */
export function usePanelToggles() {
  const { ed } = useApp();
  const cls = useViewportClass();
  const mediaCollapsed = useMedia((s) => s.collapsed);
  const rightOpen = useEd((s) => s.prefs.rightOpen);
  const left = useShell((s) => s.pinned.left || s.open.left);
  const right = useShell((s) => s.pinned.right || s.open.right);
  if (cls === 'tablet') {
    return {
      mediaOpen: left,
      inspectorOpen: right,
      toggleMedia: () => dispatchShell({ type: 'panel', side: 'left', op: 'toggle' }),
      toggleInspector: () => dispatchShell({ type: 'panel', side: 'right', op: 'toggle' }),
      openInspector: () => dispatchShell({ type: 'panel', side: 'right', op: 'open' }),
    };
  }
  return {
    mediaOpen: !mediaCollapsed,
    inspectorOpen: rightOpen,
    toggleMedia: toggleMediaPanel,
    toggleInspector: () => ed.setPrefs({ rightOpen: !rightOpen }),
    openInspector: () => ed.setPrefs({ rightOpen: true }),
  };
}
