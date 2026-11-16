import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './fonts.css';

/** Fonts that ship with the app (public/fonts, registered with @font-face in tokens.css). */
const BUNDLED = ['Pixeloid'];
const GENERIC = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
/** Probe list for browsers without the Local Font Access API. */
const COMMON = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Book Antiqua', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode',
  'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Helvetica', 'Helvetica Neue', 'Futura', 'Gill Sans', 'Optima', 'Palatino', 'Didot', 'Baskerville', 'Hoefler Text', 'American Typewriter', 'Avenir', 'Avenir Next',
  'Menlo', 'Monaco', 'Courier', 'Geneva', 'Lucida Grande', 'Marker Felt', 'Chalkboard', 'Papyrus', 'Copperplate', 'Rockwell', 'SF Pro Text', 'San Francisco',
  'Ubuntu', 'Cantarell', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'Noto Serif',
  'Noto Sans Mono', 'Droid Sans', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans Pro', 'Fira Sans', 'Fira Code', 'Inconsolata', 'Oswald', 'Poppins',
  'Playfair Display', 'Merriweather', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Courier Prime', 'Bookman Old Style', 'Garamond', 'Tw Cen MT', 'Rockwell Condensed',
];
const RECENT_KEY = 'rsmps.ui.fonts.recent';

let localCache: string[] | null = null;
let probeCache: string[] | null = null;

const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const remember = (name: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, 6)));
  } catch {
    /* storage unavailable */
  }
};

function installed(name: string): boolean {
  // document.fonts.check() is also true for unknown families in some browsers, so measure against three fallbacks instead
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return false;
  const text = 'mmmmmmmmmmlliWWW@@ 0123';
  return ['monospace', 'serif', 'sans-serif'].some((base) => {
    c.font = `72px ${base}`;
    const w0 = c.measureText(text).width;
    c.font = `72px "${name}", ${base}`;
    return c.measureText(text).width !== w0;
  });
}

function probeFonts(): string[] {
  return (probeCache ??= COMMON.filter(installed));
}

type LocalFontsWindow = Window & { queryLocalFonts?: () => Promise<{ family: string }[]> };

/** Searchable font dropdown for string params with `kind: 'font'`. Each row is drawn in its own font; any family name can be typed. */
export function FontField({ value, onChange, large }: { value: string; onChange: (v: string) => void; large?: boolean }) {
  const [open, setOpen] = useState<{ x: number; y: number; w: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        className={`rs-fontbtn rs-select${large ? ' rs-select--lg' : ''}`}
        data-nodrag
        aria-haspopup="listbox"
        aria-label="Font"
        title="Choose a font"
        style={{ fontFamily: value ? `${value}, sans-serif` : undefined }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 2, w: Math.max(240, r.width) });
        }}
      >
        <span className="rs-fontbtn__name">{value || 'sans-serif'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && <FontMenu x={open.x} y={open.y} w={open.w} value={value} anchor={btn} onPick={onChange} onClose={() => setOpen(null)} />}
    </>
  );
}

function FontMenu({ x, y, w, value, anchor, onPick, onClose }: { x: number; y: number; w: number; value: string; anchor: React.RefObject<HTMLButtonElement | null>; onPick: (v: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [local, setLocal] = useState<string[] | null>(localCache);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ x, y });
  const ref = useRef<HTMLDivElement>(null);
  const canLocal = typeof (window as LocalFontsWindow).queryLocalFonts === 'function';

  const groups = useMemo(() => {
    const seen = new Set<string>();
    const take = (list: string[]) => list.filter((n) => !seen.has(n.toLowerCase()) && (seen.add(n.toLowerCase()), true));
    const f = (list: string[]) => list.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()));
    const out: { title: string; items: string[] }[] = [];
    const rec = f(take(recent()));
    if (rec.length) out.push({ title: 'Recent', items: rec });
    out.push({ title: 'Bundled', items: f(take(BUNDLED)) });
    out.push({ title: 'Generic', items: f(take(GENERIC)) });
    if (canLocal) {
      if (local) out.push({ title: 'On this computer', items: f(take(local)) });
    } else out.push({ title: 'On this computer', items: f(take(probeFonts())) });
    return out.filter((g) => g.items.length);
  }, [q, local, canLocal]);
  const flat = groups.flatMap((g) => g.items);
  const typed = q.trim() && !flat.some((n) => n.toLowerCase() === q.trim().toLowerCase()) ? q.trim() : null;
  const all = typed ? [...flat, typed] : flat;

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, local]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onClose, anchor]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (name: string) => {
    remember(name);
    onPick(name);
    onClose();
    // the canvas that draws the text can only use a font that is loaded: load it, then touch the param again to re-render
    void document.fonts.load(`16px "${name}"`).then(() => onPick(name)).catch(() => undefined);
  };
  const askLocal = async () => {
    try {
      const fonts = await (window as LocalFontsWindow).queryLocalFonts!();
      localCache = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      setLocal(localCache);
    } catch {
      /* permission denied: the list stays as it is */
    }
  };

  return createPortal(
    <div ref={ref} className="rs-fontmenu" style={{ left: pos.x, top: pos.y, width: w }} role="listbox" aria-label="Fonts">
      <input
        className="rs-fontmenu__q"
        autoFocus
        value={q}
        placeholder="Search, or type any font name"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(all.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && all[active]) pick(all[active]);
          else if (e.key === 'Escape') onClose();
        }}
      />
      <div className="rs-fontmenu__list">
        {(() => {
          let i = -1;
          return groups.map((g) => (
            <div key={g.title}>
              <div className="rs-caps rs-fontmenu__head">{g.title}</div>
              {g.items.map((n) => {
                i++;
                const idx = i;
                return (
                  <button key={n} role="option" aria-selected={n === value} data-active={idx === active ? 1 : 0} className={`rs-fontmenu__row${idx === active ? ' is-active' : ''}${n === value ? ' is-cur' : ''}`} onPointerEnter={() => setActive(idx)} onClick={() => pick(n)}>
                    <span className="rs-fontmenu__name">{n}</span>
                    <span className="rs-fontmenu__sample" style={{ fontFamily: `"${n}", ${GENERIC.includes(n) ? n : 'sans-serif'}` }}>Aa Bb 123</span>
                  </button>
                );
              })}
            </div>
          ));
        })()}
        {typed && (
          <button role="option" data-active={active === flat.length ? 1 : 0} className={`rs-fontmenu__row${active === flat.length ? ' is-active' : ''}`} onClick={() => pick(typed)}>
            <span className="rs-fontmenu__name">Use “{typed}”</span>
            <span className="rs-fontmenu__sample" style={{ fontFamily: `"${typed}", sans-serif` }}>Aa Bb 123</span>
          </button>
        )}
      </div>
      {canLocal && !local && (
        <button className="rs-btn rs-fontmenu__local" onClick={() => void askLocal()}>Show fonts on this computer</button>
      )}
    </div>,
    document.body,
  );
}
