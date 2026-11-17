import { useCallback, useRef, useState } from 'react';
import { trackPointer } from '../lib/drag';
import { moveToBin } from '../lib/mediaOrg';
import { useApp } from '../store/context';
import { MAX_WIDTH, MIN_WIDTH, RAIL_WIDTH, clampWidth, editOrg, setMedia, useMedia } from '../store/media';
import { MediaPanel } from './MediaPanel';
import { MediaRail } from './MediaRail';
import { OutputsSection } from './OutputsSection';
import './sidebar.css';

const ACCEPT = 'image/*,video/*,audio/*,.mid,.midi,.glb,.gltf,.obj,.cube,.ply,.splat,.srt,.vtt';

/**
 * The left column: the media panel (or, collapsed, a slim rail) above the outputs list. It is the `<aside>` itself, so its width
 * (remembered per user) and the drag handle on its right edge live here. Files dropped anywhere on it are imported.
 */
export function Sidebar({ fill = false }: { fill?: boolean } = {}) {
  const app = useApp();
  const { io, ed } = app;
  const collapsed = useMedia((s) => s.collapsed) && !fill; // fill: a drawer or tab that gives the panel the whole width, never the rail
  const width = useMedia((s) => s.width);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const aside = useRef<HTMLElement>(null);

  const importFiles = useCallback(
    async (files: File[], bin: string | null = null) => {
      if (!files.length) return;
      setBusy(true);
      try {
        const infos = await io.library.add(files);
        if (bin) editOrg(app, (o) => moveToBin(o, infos.map((i) => i.id), bin));
        ed.toast(`Imported ${infos.length} file${infos.length === 1 ? '' : 's'}`, 'ok');
      } catch (err) {
        ed.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [app, io, ed],
  );
  const pick = useCallback(() => fileIn.current?.click(), []);

  const grip = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let w = start;
    document.body.style.cursor = 'col-resize';
    trackPointer(
      e,
      (ev) => {
        w = clampWidth(start + ev.clientX - startX);
        if (aside.current) aside.current.style.width = `${w}px`; // live, without re-rendering the panel on every pixel
      },
      () => {
        document.body.style.cursor = '';
        setMedia({ width: w });
      },
    );
  };

  return (
    <aside
      ref={aside}
      className={`rs-left${collapsed ? ' is-rail' : ''}${over ? ' is-drop' : ''}`}
      style={fill ? { width: '100%' } : { width: collapsed ? RAIL_WIDTH : width }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          void importFiles(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div className="rs-side">
        {collapsed ? (
          <MediaRail busy={busy} onImport={pick} />
        ) : (
          <>
            <section className="rs-side__sec rs-side__media">
              <MediaPanel busy={busy} pick={pick} importFiles={(f, b) => void importFiles(f, b)} />
            </section>
            <OutputsSection />
          </>
        )}
      </div>
      {!collapsed && !fill && (
        <div
          className="rs-left__grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the media panel"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={grip}
          onDoubleClick={() => setMedia({ width: 264 })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              e.stopPropagation();
              setMedia({ width: width + (e.key === 'ArrowRight' ? 16 : -16) });
            }
          }}
        />
      )}
      <input ref={fileIn} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { if (e.target.files) void importFiles(Array.from(e.target.files)); e.target.value = ''; }} />
    </aside>
  );
}
