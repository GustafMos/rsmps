import { useEffect, useRef, useState } from 'react';
import {
  addAudioClip,
  addMidiClip,
  addTrack,
  clipEnd,
  duplicateClip,
  gridSeconds,
  isMidiClip,
  moveClip,
  normalizeTimeline,
  removeClip,
  removeTrack,
  snapTime,
  splitClip,
  trimClipEnd,
  trimClipStart,
  updateClip,
  updateTrack,
  type Grid,
  type TimelineClip,
  type TimelineData,
} from '../../engine/audio/timeline';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { ASSET_MIME } from '../graph/gestures';
import { useApp, useEd } from '../store/context';
import { RecordButton } from './RecordButton';
import { ClipHandles, ClipWave } from './ClipParts';
import { PianoRoll } from './PianoRoll';
import './timeline.css';

const TRACK_H = 52;
const HEAD_W = 210;
const H_KEY = 'rsmps.ui.timeline.h';
const C_KEY = 'rsmps.ui.timeline.collapsed';
const readNum = (k: string, d: number) => {
  try {
    const v = Number(localStorage.getItem(k));
    return v >= 120 ? v : d;
  } catch {
    return d;
  }
};

/** Shape detection (never a node id): a json `clips` param plus recordAudio / recordMidi inputs. */
export function isTimelineDef(def: { params: object; inputs: object } | undefined): boolean {
  if (!def) return false;
  const p = def.params as Record<string, { type?: string }>;
  const i = def.inputs as Record<string, unknown>;
  return p.clips?.type === 'json' && 'recordAudio' in i && 'recordMidi' in i;
}

/** Arrangement-style editor: tracks, clips (move, trim, split, duplicate, delete), arm / mute / solo, recording. */
export function TimelineEditor({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { ed, io } = useApp();
  const node = useEd((s) => s.graph.nodes.find((n) => n.id === nodeId));
  const project = useEd((s) => s.graph.project);
  const armed = useEd((s) => s.armed);
  const [pps, setPps] = useState(60); // pixels per second
  const [h, setH] = useState(() => readNum(H_KEY, 240));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(C_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(C_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };
  /** Drag the top edge: the strip grows upward, the graph above shrinks. Height is remembered. */
  const grip = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = h;
    let cur = h0;
    const mv = (ev: PointerEvent) => {
      cur = Math.round(Math.min(window.innerHeight * 0.7, Math.max(120, h0 + (y0 - ev.clientY))));
      setH(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(H_KEY, String(cur));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  const [sel, setSel] = useState<string | null>(null);
  const [roll, setRoll] = useState<string | null>(null);
  const [pop, setPop] = useState<string | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tl = normalizeTimeline(node?.params.clips);
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const bpm = Number(node?.params.bpm ?? 120);
  const grid = (String(node?.params.quantize ?? '1/16') as Grid) || 'off';
  const total = Math.max(project.duration, ...tl.clips.map(clipEnd), 4) + 2;
  const write = (next: TimelineData) => ed.setParam(nodeId, 'clips', next);

  // playhead without React per frame
  useEffect(() => {
    const place = () => {
      if (head.current) head.current.style.transform = `translateX(${io.player.getState().seconds * pps}px)`;
    };
    place();
    return io.player.subscribe(place);
  }, [io, pps]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
      if (!sel) return;
      const clip = tlRef.current.clips.find((c) => c.id === sel);
      if (!clip) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        write(removeClip(tlRef.current, sel));
        setSel(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const r = duplicateClip(tlRef.current, sel);
        write(r.timeline);
        setSel(r.clip.id);
      } else if (e.key.toLowerCase() === 's' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        const at = io.player.getState().seconds;
        if (at > clip.start && at < clipEnd(clip)) write(splitClip(tlRef.current, sel, at).timeline);
      }
    };
    const el = scroller.current?.closest('.rs-tl');
    el?.addEventListener('keydown', key as EventListener);
    return () => el?.removeEventListener('keydown', key as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, nodeId]);

  const snap = (t: number, alt: boolean) => (alt ? t : snapTime(t, bpm, grid));

  const dragClip = (e: React.PointerEvent, clip: TimelineClip, part: 'move' | 'l' | 'r') => {
    e.preventDefault();
    e.stopPropagation();
    setSel(clip.id);
    const x0 = e.clientX;
    ed.beginHold();
    const base = tlRef.current;
    const mv = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      try {
        if (part === 'move') {
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-lane]');
          const lane = el?.dataset.lane;
          const target = lane && base.tracks.find((t) => t.id === lane && (t.kind === 'midi') === isMidiClip(clip)) ? lane : undefined;
          write(moveClip(base, clip.id, snap(clip.start + dt, ev.altKey), target));
        } else if (part === 'l') write(trimClipStart(base, clip.id, snap(clip.start + dt, ev.altKey)));
        else write(trimClipEnd(base, clip.id, snap(clipEnd(clip) + dt, ev.altKey)));
      } catch {
        /* a move to an incompatible track is ignored */
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      ed.endHold();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  /** Fade corners and the loop handle: one undo step per gesture. A click on the loop handle toggles looping. */
  const dragPart = (e: React.PointerEvent, clip: TimelineClip, part: 'fadeIn' | 'fadeOut' | 'loop') => {
    e.preventDefault();
    e.stopPropagation();
    setSel(clip.id);
    const x0 = e.clientX;
    let moved = false;
    const base = tlRef.current;
    ed.beginHold();
    const mv = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      if (part === 'fadeIn') write(updateClip(base, clip.id, { fadeIn: Math.max(0, Math.min(clip.length - clip.fadeOut, clip.fadeIn + dt)) }));
      else if (part === 'fadeOut') write(updateClip(base, clip.id, { fadeOut: Math.max(0, Math.min(clip.length - clip.fadeIn, clip.fadeOut - dt)) }));
      else write(updateClip(base, clip.id, { loop: true, srcLength: clip.srcLength ?? clip.length, length: Math.max(0.05, snap(clipEnd(clip) + dt, ev.altKey) - clip.start) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (!moved && part === 'loop') write(updateClip(base, clip.id, clip.loop ? { loop: false } : { loop: true, srcLength: clip.srcLength ?? clip.length }));
      ed.endHold();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const dropOn = (e: React.DragEvent, trackId: string) => {
    const raw = e.dataTransfer.getData(ASSET_MIME);
    if (!raw) return;
    e.preventDefault();
    const track = tl.tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'audio') return ed.toast('Drop audio on an audio track.', 'error');
    const lane = e.currentTarget.getBoundingClientRect();
    const start = snap(Math.max(0, (e.clientX - lane.left) / pps), e.altKey);
    let next = tl;
    let at = start;
    for (const id of JSON.parse(raw) as string[]) {
      const info = io.library.list().find((a) => a.id === id);
      if (!info || info.kind !== 'audio') continue;
      next = addAudioClip(next, { track: trackId, start: at, length: info.duration || 1, asset: id, name: info.name }).timeline;
      at += info.duration || 1;
    }
    write(next);
  };

  const ticks: number[] = [];
  const beat = 60 / bpm;
  const step = pps * beat < 24 ? beat * 4 : beat;
  for (let t = 0; t <= total; t += step) ticks.push(t);

  if (!node) return null;
  return (
    <div className={`rs-tl${collapsed ? ' is-collapsed' : ''}`} style={collapsed ? undefined : { height: h }} tabIndex={-1} role="region" aria-label="Timeline">
      {!collapsed && <div className="rs-tl__grip" onPointerDown={grip} role="separator" aria-orientation="horizontal" title="Drag to resize the timeline" />}
      <div className="rs-tl__head">
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Expand the timeline' : 'Collapse the timeline'}><span style={{ display: 'inline-flex', transform: collapsed ? 'rotate(180deg)' : undefined }}><Icon name="chevronDown" /></span></button>
        <span className="rs-caps">Timeline{node.label ? ` · ${node.label}` : ''}</span>
        <RecordButton nodeId={nodeId} />
        <span className="rs-tl__sp" />
        {!collapsed && <>
        <button className="rs-btn" onClick={() => write(addTrack(tl, 'audio').timeline)}><Icon name="plus" /> Audio track</button>
        <button className="rs-btn" onClick={() => write(addTrack(tl, 'midi').timeline)}><Icon name="plus" /> MIDI track</button>
        <div style={{ width: 120 }}><NumberField label="Zoom" min={10} max={400} integer value={pps} defaultValue={60} onChange={setPps} /></div>
        </>}
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      {!collapsed && <div className="rs-tl__body">
        <div className="rs-tl__heads" style={{ width: HEAD_W }}>
          <div className="rs-tl__corner" />
          {tl.tracks.map((t) => (
            <div key={t.id} className="rs-tl__thead" style={{ height: TRACK_H }}>
              <div className="rs-tl__trow">
                <Icon name={t.kind === 'midi' ? 'midi' : 'audio'} size={13} />
                <input className="rs-tl__name" value={t.name} aria-label="Track name" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => write(updateTrack(tl, t.id, { name: e.target.value }))} />
                <button className={`rs-tl__b${t.mute ? ' is-on' : ''}`} title="Mute" onClick={() => write(updateTrack(tl, t.id, { mute: !t.mute }))}>M</button>
                <button className={`rs-tl__b${t.solo ? ' is-on' : ''}`} title="Solo" onClick={() => write(updateTrack(tl, t.id, { solo: !t.solo }))}>S</button>
                <button
                  className={`rs-tl__b rs-tl__rec${armed?.track === t.id ? ' is-on' : ''}`}
                  title={armed?.track === t.id ? 'Armed for recording: click to disarm' : 'Arm this track for recording'}
                  onClick={() => ed.armTrack(nodeId, armed?.track === t.id ? null : { track: t.id, kind: t.kind })}
                >●</button>
                <button className="rs-tl__b" title="Remove track" onClick={() => { write(removeTrack(tl, t.id)); }}>×</button>
              </div>
              {t.kind === 'audio' && (
                <div className="rs-tl__trow">
                  <div style={{ flex: 1 }}><NumberField label="Gain" step={0.5} unit="db" value={t.gain} defaultValue={0} onChange={(v) => write(updateTrack(tl, t.id, { gain: v }))} /></div>
                  <div style={{ flex: 1 }}><NumberField label="Pan" min={-1} max={1} step={0.05} value={t.pan} defaultValue={0} onChange={(v) => write(updateTrack(tl, t.id, { pan: v }))} /></div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="rs-tl__scroll" ref={scroller}>
          <div className="rs-tl__canvas" style={{ width: total * pps }}>
            <div
              className="rs-tl__ruler"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const seek = (cx: number) => io.player.seek(Math.max(0, (cx - r.left) / pps));
                seek(e.clientX);
                const mv = (ev: PointerEvent) => seek(ev.clientX);
                const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
                window.addEventListener('pointermove', mv);
                window.addEventListener('pointerup', up);
              }}
            >
              <div className="rs-tl__loop" style={{ width: project.duration * pps }} title="Project loop" />
              {ticks.map((t) => (
                <span key={t} className="rs-tl__tick rs-num" style={{ left: t * pps }}>{Number(t.toFixed(2))}s</span>
              ))}
            </div>
            {tl.tracks.map((t) => (
              <div key={t.id} className="rs-tl__lane" data-lane={t.id} style={{ height: TRACK_H }} onDragOver={(e) => e.dataTransfer.types.includes(ASSET_MIME) && e.preventDefault()} onDrop={(e) => dropOn(e, t.id)} onDoubleClick={t.kind === 'midi' ? (e) => {
                if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('rs-tl__loop')) return;
                const lane = e.currentTarget.getBoundingClientRect();
                const r = addMidiClip(tl, { track: t.id, start: snap(Math.max(0, (e.clientX - lane.left) / pps), e.altKey), length: beat * 4, name: 'MIDI clip' });
                write(r.timeline);
                setSel(r.clip.id);
                setRoll(r.clip.id);
              } : undefined} title={t.kind === 'midi' ? 'Double-click an empty spot to add a MIDI clip' : undefined}>
                <div className="rs-tl__loop rs-tl__loop--lane" style={{ width: project.duration * pps }} />
                {tl.clips.filter((c) => c.track === t.id).map((c) => (
                  <div
                    key={c.id}
                    className={`rs-tl__clip${c.id === sel ? ' is-sel' : ''}${isMidiClip(c) ? ' is-midi' : ''}${c.muted ? ' is-muted' : ''}`}
                    style={{ left: c.start * pps, width: Math.max(4, c.length * pps) }}
                    onPointerDown={(e) => dragClip(e, c, 'move')}
                    onDoubleClick={() => (isMidiClip(c) ? setRoll(c.id) : setPop(c.id))}
                    title={`${c.name ?? (isMidiClip(c) ? 'MIDI clip' : 'Audio clip')} · drag to move (Alt: no snap) · edges trim · Del · Ctrl+D · S splits at the playhead · double-click: ${isMidiClip(c) ? 'piano roll' : 'gain, fades, loop'}`}
                  >
                    {!isMidiClip(c) && c.asset && <ClipWave clip={c} pps={pps} />}
                    <span className="rs-tl__edge rs-tl__edge--l" onPointerDown={(e) => dragClip(e, c, 'l')} />
                    <span className="rs-tl__cname">{c.name ?? (isMidiClip(c) ? 'MIDI' : 'Audio')}</span>
                    {isMidiClip(c) && (c.notes ?? []).slice(0, 400).map((n, i) => (
                      <i key={i} className="rs-tl__note" style={{ left: `${(n.t / Math.max(0.001, c.srcLength ?? c.length)) * 100}%`, width: `${Math.max(0.5, (n.d / Math.max(0.001, c.srcLength ?? c.length)) * 100)}%`, bottom: `${(n.note / 127) * 70 + 4}%`, opacity: 0.4 + n.vel * 0.6 }} />
                    ))}
                    <ClipHandles clip={c} pps={pps} onGrab={(ev, part) => dragPart(ev, c, part)} />
                    <span className="rs-tl__edge rs-tl__edge--r" onPointerDown={(e) => dragClip(e, c, 'r')} />
                  </div>
                ))}
              </div>
            ))}
            {tl.tracks.length === 0 && <div className="rs-tl__empty">Add an audio or MIDI track, then drop sounds from the Media panel or record.</div>}
            <div ref={head} className="rs-tl__playhead" />
          </div>
        </div>
      </div>}
      {!collapsed && pop && tl.clips.find((c) => c.id === pop) && (() => {
        const c = tl.clips.find((x) => x.id === pop)!;
        return (
          <div className="rs-tl__pop" style={{ right: 12, top: 36 }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <div className="rs-caps"><span>{c.name ?? 'Audio clip'}</span><button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => setPop(null)} aria-label="Close"><Icon name="close" size={12} /></button></div>
            <NumberField label="Gain" step={0.5} min={-60} max={24} unit="db" value={c.gain} defaultValue={0} onChange={(v) => write(updateClip(tl, c.id, { gain: v }))} />
            <NumberField label="Fade in" step={0.01} min={0} unit="s" value={Number(c.fadeIn.toFixed(3))} defaultValue={0} onChange={(v) => write(updateClip(tl, c.id, { fadeIn: Math.max(0, Math.min(c.length - c.fadeOut, v)) }))} />
            <NumberField label="Fade out" step={0.01} min={0} unit="s" value={Number(c.fadeOut.toFixed(3))} defaultValue={0} onChange={(v) => write(updateClip(tl, c.id, { fadeOut: Math.max(0, Math.min(c.length - c.fadeIn, v)) }))} />
            <div className="rs-insp__actions">
              <button className={`rs-btn${c.loop ? ' is-on' : ''}`} onClick={() => write(updateClip(tl, c.id, c.loop ? { loop: false } : { loop: true, srcLength: c.srcLength ?? c.length }))}>Loop</button>
              <button className={`rs-btn${c.muted ? ' is-on' : ''}`} onClick={() => write(updateClip(tl, c.id, { muted: !c.muted }))}>Mute clip</button>
            </div>
          </div>
        );
      })()}
      {!collapsed && roll && <PianoRoll clipId={roll} tl={tl} bpm={bpm} grid={grid} write={write} onClose={() => setRoll(null)} />}
      {!collapsed && <div className="rs-tl__foot rs-insp__hint">Grid {gridSeconds(bpm, grid) > 0 ? `1/${String(grid).split('/')[1]} note` : 'off'} · {bpm} BPM · shaded area = project loop · click the ruler to seek</div>}
    </div>
  );
}
