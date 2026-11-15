import { useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { SelectField } from '../components/fields';
import { Dialog } from '../dialogs/Dialog';
import { hslToRgb, oklchToRgb, rgbToHsl, rgbToOklab, rgbToOklch, toHex, parseHex, type RGB } from '../lib/colorMath';
import { useApp, useEd } from '../store/context';
import { exportPalette } from './formats';
import { fixedCount, fromColors, regenerate, RULES, ruleOf, swatchFromRgb, swatchRgb, triadStart, type RuleId, type StudioState } from './model';
import { StudioTabs } from './StudioTabs';
import { Wheel } from './Wheel';
import './studio.css';

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mod = (n: number, m: number) => ((n % m) + m) % m;

interface PaletteTarget {
  nodeId: string;
  key: string;
  label: string;
}

export function PaletteStudio() {
  const { ed, io } = useApp();
  const live = useRef(ed.studioTarget);
  const selection = useEd((s) => s.selection);

  /** Palette params on the selected node (for "send to node" in the standalone tool). */
  const targets: PaletteTarget[] = useMemo(() => {
    const node = selection.length === 1 ? ed.state.graph.nodes.find((n) => n.id === selection[0]) : undefined;
    const def = node && io.registry.get(node.type);
    if (!node || !def) return [];
    return Object.entries(def.params as Record<string, { type: string; label?: string }>)
      .filter(([, p]) => p.type === 'palette')
      .map(([key, p]) => ({ nodeId: node.id, key, label: `${node.label || def.title} · ${p.label ?? key}` }));
  }, [ed, io, selection]);

  const initial = useMemo<StudioState>(() => {
    const t = live.current ?? (targets[0] ? { nodeId: targets[0].nodeId, key: targets[0].key } : null);
    const node = t && ed.state.graph.nodes.find((n) => n.id === t.nodeId);
    const colors = node?.params[t!.key];
    if (live.current && Array.isArray(colors) && colors.length) return fromColors(colors as RGB[]);
    return triadStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [st, setSt] = useState<StudioState>(initial);
  const [sel, setSel] = useState(0);
  const [sendTo, setSendTo] = useState(0);
  const [slMode, setSlMode] = useState<'hsl' | 'oklch'>('hsl');
  const dragFrom = useRef<number | null>(null);

  const colors = useMemo(() => st.swatches.map(swatchRgb), [st]);
  const liveTarget = live.current;
  const liveNode = liveTarget && ed.state.graph.nodes.find((n) => n.id === liveTarget.nodeId);

  const push = (next: StudioState) => {
    setSt(next);
    if (liveTarget) ed.setParam(liveTarget.nodeId, liveTarget.key, next.swatches.map(swatchRgb));
  };
  const setColors = (list: RGB[]) => {
    if (!list.length) return;
    push(fromColors(list));
    setSel(0);
  };

  const dragHandle = (i: number, h: number, s: number) => {
    const sw = st.swatches[i];
    if (!sw || sw.locked) return;
    if (st.rule === 'custom') {
      push({ ...st, swatches: st.swatches.map((x, j) => (j === i ? { ...x, h, s } : x)) });
      return;
    }
    const dh = mod(h - sw.h + 540, 360) - 180;
    const b = st.swatches[st.base];
    const swatches = st.swatches.map((x, j) => (j === st.base ? { ...x, h: mod(b.h + dh, 360), s: clamp(b.s + (s - sw.s)) } : x));
    push(regenerate({ ...st, swatches }));
  };

  const setRule = (id: RuleId) => {
    const n = fixedCount(id) ?? st.swatches.length;
    push(id === 'custom' ? { ...st, rule: id } : regenerate({ ...st, rule: id }, n));
    if (id !== 'custom') setSel(Math.min(sel, n - 1));
  };
  const setCount = (n: number) => {
    if (st.rule !== 'custom') return push(regenerate(st, n));
    const sw = [...st.swatches];
    while (sw.length < n) sw.push({ ...sw[sw.length - 1], h: mod(sw[sw.length - 1].h + 25, 360) });
    push({ ...st, swatches: sw.slice(0, n) });
  };

  const cur = st.swatches[Math.min(sel, st.swatches.length - 1)];
  const idx = Math.min(sel, st.swatches.length - 1);
  const curRgb = swatchRgb(cur);
  const editRgb = (c: RGB) => {
    const swatches = st.swatches.map((x, j) => (j === idx ? swatchFromRgb(c, x) : x));
    push(idx === st.base ? regenerate({ ...st, swatches }) : { ...st, rule: 'custom', swatches });
  };
  const hsl = rgbToHsl(curRgb);
  const lch = rgbToOklch(curRgb);

  const move = (from: number, to: number) => {
    if (from === to) return;
    const sw = [...st.swatches];
    const [x] = sw.splice(from, 1);
    sw.splice(to, 0, x);
    let base = st.base;
    if (base === from) base = to;
    else if (from < base && to >= base) base--;
    else if (from > base && to <= base) base++;
    push({ ...st, base, swatches: sw });
    setSel(to);
  };

  const sort = (by: 'hue' | 'light') => {
    const key = (s: (typeof st.swatches)[number]) => (by === 'hue' ? s.h + (s.s < 0.08 ? -1000 : 0) : rgbToOklab(swatchRgb(s))[0]);
    const sw = [...st.swatches].sort((a, b) => key(a) - key(b));
    push({ ...st, rule: 'custom', base: 0, swatches: sw });
  };

  const textOn = (c: RGB) => (rgbToOklab(c)[0] > 0.62 ? '#000' : '#fff');

  const sendNow = async (t: PaletteTarget) => {
    ed.setParam(t.nodeId, t.key, colors);
    ed.toast(`Sent ${colors.length} colours to ${t.label}`, 'ok');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportPalette(colors, 'hex-list'));
      ed.toast('Palette copied to the clipboard', 'ok');
    } catch {
      ed.toast('Clipboard is not available here. Use Import / Export to copy the text.', 'error');
    }
  };

  const fixed = fixedCount(st.rule);

  return (
    <Dialog
      title="Palette Studio"
      width={1080}
      onClose={() => ed.openDialog(null)}
      footer={
        <>
          <span className="rs-ps__live">
            {liveTarget && liveNode ? (
              <>
                <span className="rs-ps__dot" /> Live: editing {liveNode.label || io.registry.get(liveNode.type)?.title} · {liveTarget.key}
              </>
            ) : targets.length ? (
              <>
                {targets.length > 1 && <SelectField value={String(sendTo)} options={targets.map((t, i) => ({ value: String(i), label: t.label }))} onChange={(v) => setSendTo(+v)} />}
                <button className="rs-btn rs-btn--primary" onClick={() => sendNow(targets[Math.min(sendTo, targets.length - 1)])}>
                  Send to {targets[Math.min(sendTo, targets.length - 1)].label}
                </button>
              </>
            ) : (
              <span className="rs-ps__hint">Select a node with a palette to send this palette to it.</span>
            )}
          </span>
          <button className="rs-btn" onClick={copy}><Icon name="save" /> Copy hex list</button>
          <button className="rs-btn" onClick={() => ed.openDialog(null)}>Done</button>
        </>
      }
    >
      <div className="rs-ps">
        <div className="rs-ps__left">
          <Wheel swatches={st.swatches} base={st.base} sel={idx} onSelect={setSel} onDrag={dragHandle} />
          <div className="rs-ps__rules" role="radiogroup" aria-label="Harmony rule">
            {RULES.map((r) => (
              <button key={r.id} className={`rs-ps__rule${st.rule === r.id ? ' is-on' : ''}`} role="radio" aria-checked={st.rule === r.id} title={r.help} onClick={() => setRule(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <p className="rs-ps__help">{ruleOf(st.rule).help}{st.rule !== 'custom' && ' Drag any handle: the rest follow.'}</p>
          <NumberField large label="Swatches" integer min={2} max={st.rule === 'custom' ? 64 : 16} value={st.swatches.length} defaultValue={fixed ?? 5} onChange={setCount} />
        </div>

        <div className="rs-ps__right">
          <div className="rs-ps__strip">
            {st.swatches.map((s, i) => {
              const c = swatchRgb(s);
              return (
                <div
                  key={i}
                  className={`rs-ps__tile${i === idx ? ' is-sel' : ''}`}
                  style={{ background: toHex(c), color: textOn(c) }}
                  draggable
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; }}
                  onClick={() => setSel(i)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Swatch ${i + 1} ${toHex(c)}`}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSel(i); }}
                >
                  <span className="rs-ps__tilehex rs-mono">{toHex(c).slice(1)}</span>
                  <span className="rs-ps__tilebtns">
                    <button title={s.locked ? 'Unlock' : 'Lock this swatch (rules will not change it)'} onClick={(e) => { e.stopPropagation(); push({ ...st, swatches: st.swatches.map((x, j) => (j === i ? { ...x, locked: !x.locked } : x)) }); }} style={{ color: 'inherit', opacity: s.locked ? 1 : 0.5 }}>
                      {s.locked ? 'L' : 'l'}
                    </button>
                    <button title={i === st.base ? 'Base swatch' : 'Make this the base swatch'} onClick={(e) => { e.stopPropagation(); push({ ...st, base: i }); }} style={{ color: 'inherit', opacity: i === st.base ? 1 : 0.5 }}>
                      {i === st.base ? '★' : '☆'}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="rs-ps__edit">
            <div className="rs-ps__edithead">
              <span className="rs-caps">Swatch {idx + 1}</span>
              <input
                className="rs-input rs-mono"
                key={toHex(curRgb) + idx}
                defaultValue={toHex(curRgb)}
                spellCheck={false}
                aria-label="Hex"
                style={{ width: 96 }}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => { const p = parseHex(e.target.value); if (p) editRgb(p.rgb); }}
              />
              <span className="rs-ps__spacer" />
              <div className="rs-ps__seg">
                <button className={slMode === 'hsl' ? 'is-on' : ''} onClick={() => setSlMode('hsl')}>HSL</button>
                <button className={slMode === 'oklch' ? 'is-on' : ''} onClick={() => setSlMode('oklch')}>OKLCH</button>
              </div>
            </div>
            {slMode === 'hsl' ? (
              <div className="rs-ps__sliders">
                <NumberField large label="Hue" integer min={0} max={360} unit="deg" value={Math.round(cur.h)} onChange={(v) => editRgb(hslToRgb([v, hsl[1], hsl[2]]))} />
                <NumberField large label="Saturation" integer min={0} max={100} unit="%" value={Math.round(hsl[1] * 100)} onChange={(v) => editRgb(hslToRgb([cur.h, v / 100, hsl[2]]))} />
                <NumberField large label="Lightness" integer min={0} max={100} unit="%" value={Math.round(hsl[2] * 100)} onChange={(v) => editRgb(hslToRgb([cur.h, hsl[1], v / 100]))} />
              </div>
            ) : (
              <div className="rs-ps__sliders">
                <NumberField large label="Lightness" min={0} max={1} step={0.005} value={Number(lch[0].toFixed(3))} onChange={(v) => editRgb(oklchToRgb(v, lch[1], lch[2]))} />
                <NumberField large label="Chroma" min={0} max={0.4} step={0.002} value={Number(lch[1].toFixed(3))} onChange={(v) => editRgb(oklchToRgb(lch[0], v, lch[2]))} />
                <NumberField large label="Hue" integer min={0} max={360} unit="deg" value={Math.round(lch[2])} onChange={(v) => editRgb(oklchToRgb(lch[0], lch[1], v))} />
              </div>
            )}
            <div className="rs-ps__actions">
              <button className="rs-btn" onClick={() => sort('hue')}>Sort by hue</button>
              <button className="rs-btn" onClick={() => sort('light')}>Sort by lightness</button>
              <button className="rs-btn" onClick={() => push({ ...st, rule: 'custom', swatches: [...st.swatches].reverse(), base: st.swatches.length - 1 - st.base })}>Reverse</button>
              <button className="rs-btn rs-btn--danger" disabled={st.swatches.length <= 2} onClick={() => { push({ ...st, base: Math.min(st.base, st.swatches.length - 2), swatches: st.swatches.filter((_, j) => j !== idx) }); setSel(Math.max(0, idx - 1)); }}>Remove</button>
            </div>
          </div>

          <StudioTabs colors={colors} selected={idx} onColors={setColors} />
        </div>
      </div>
    </Dialog>
  );
}
