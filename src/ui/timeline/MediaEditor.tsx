import { useEffect, useRef, useState } from 'react';
import {
  clipEnd,
  editEnd,
  formatTime,
  groupOf,
  moveClip,
  normalizeEdit,
  removeClip,
  snapTargets,
  snapTime,
  splitAt,
  trimEnd,
  trimStart,
  updateClip,
  type EditClip,
  type MediaEdit,
} from '../../engine/lib/media-edit';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { useApp, useEd } from '../store/context';
import { ClipHandles, ClipWave } from './ClipParts';
import { dragWindow, usePanelFrame } from './panel';
import './timeline.css';

const TRACK_H = 40;
const HEAD_W = 120;

interface Lane {
  kind: 'video' | 'audio';
  track: number;
}

/**
 * The small video editor under the graph for a Media Timeline node: video tracks (top = in front) and sound tracks, clips as blocks
 * labelled with their source, drag to move (also between tracks), drag the edges to trim, fade corners, split at the playhead (S),
 * Delete, snapping to clip edges and the playhead (Alt = free). Linked clips (a video and its own sound) move and trim together.
 * Shares its chrome (resizable, collapsible), fade handles and waveform with the audio Timeline editor.
 */
export function MediaEditor({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { ed, io } = useApp();
  const node = useEd((s) => s.graph.nodes.find((n) => n.id === nodeId));
  const project = useEd((s) => s.graph.project);
  const [pps, setPps] = useState(60);
  const { h, collapsed, toggle, grip } = usePanelFrame();
  const [sel, setSel] = useState<string | null>(null);
  const [pop, setPop] = useState<string | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const edit = normalizeEdit(node?.params.edit);
  const editRef = useRef(edit);
  editRef.current = edit;
  const write = (next: MediaEdit) => ed.setParam(nodeId, 'edit', next);
  const end = editEnd(edit);
  const total = Math.max(project.duration, end, 6) + 2;
  const setsLength = node?.params.setsLength === true;

  const maxOf = (kind: Lane['kind']) => Math.max(-1, ...edit.clips.filter((c) => c.kind === kind).map((c) => c.track));
  const nV = Math.max(2, maxOf('video') + 2);
  const nA = Math.max(1, maxOf('audio') + 2);
  const lanes: Lane[] = [
    ...Array.from({ length: nV }, (_, i) => ({ kind: 'video' as const, track: nV - 1 - i })),
    ...Array.from({ length: nA }, (_, i) => ({ kind: 'audio' as const, track: i })),
  ];

  // playhead without React per frame
  useEffect(() => {
    const place = () => {
      if (head.current) head.current.style.transform = `translateX(${io.player.getState().seconds * pps}px)`;
    };
    place();
    return io.player.subscribe(place);
  }, [io, pps]);

  const playhead = () => io.player.getState().seconds;

  /** Cut the selected clip (else the front video clip under the playhead) at the playhead. */
  const split = () => {
    const at = playhead();
    const list = editRef.current.clips;
    const clip = (sel ? list.find((c) => c.id === sel) : undefined) ?? list.find((c) => c.kind === 'video' && at > c.start && at < clipEnd(c));
    if (!clip) return;
    const r = splitAt(editRef.current, clip.id, at);
    if (r.right.length) write(r.edit);
  };
  const remove = () => {
    if (!sel) return;
    write(removeClip(editRef.current, sel));
    setSel(null);
    setPop(null);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!sel) return;
        e.preventDefault();
        remove();
      } else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        split();
      }
    };
    const el = root.current;
    el?.addEventListener('keydown', key as EventListener);
    return () => el?.removeEventListener('keydown', key as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, nodeId]);

  const thr = 8 / pps;

  const dragClip = (e: React.PointerEvent, clip: EditClip, part: 'move' | 'l' | 'r') => {
    e.preventDefault();
    e.stopPropagation();
    setSel(clip.id);
    root.current?.focus();
    const x0 = e.clientX;
    ed.beginHold();
    const base = editRef.current;
    const ids = new Set(groupOf(base, clip.id).map((c) => c.id));
    const targets = snapTargets(base, ids, playhead());
    const snap = (t: number, alt: boolean) => (alt ? t : snapTime(t, targets, thr));
    dragWindow(
      (ev) => {
        const dt = (ev.clientX - x0) / pps;
        if (part === 'move') {
          const ns = clip.start + dt;
          const a = snap(ns, ev.altKey);
          const b = snap(ns + clip.duration, ev.altKey) - clip.duration;
          const start = a !== ns ? a : b;
          const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-lane]');
          const track = lane && lane.dataset.kind === clip.kind ? Number(lane.dataset.track) : undefined;
          write(moveClip(base, clip.id, start, track));
        } else if (part === 'l') write(trimStart(base, clip.id, snap(clip.start + dt, ev.altKey)));
        else write(trimEnd(base, clip.id, snap(clipEnd(clip) + dt, ev.altKey)));
      },
      () => ed.endHold(),
    );
  };

  const dragFade = (e: React.PointerEvent, clip: EditClip, part: 'fadeIn' | 'fadeOut' | 'loop') => {
    if (part === 'loop') return;
    e.preventDefault();
    e.stopPropagation();
    setSel(clip.id);
    const x0 = e.clientX;
    const base = editRef.current;
    ed.beginHold();
    dragWindow(
      (ev) => {
        const dt = (ev.clientX - x0) / pps;
        if (part === 'fadeIn') write(updateClip(base, clip.id, { fadeIn: Math.max(0, Math.min(clip.duration - clip.fadeOut, clip.fadeIn + dt)) }));
        else write(updateClip(base, clip.id, { fadeOut: Math.max(0, Math.min(clip.duration - clip.fadeIn, clip.fadeOut - dt)) }));
      },
      () => ed.endHold(),
    );
  };

  const step = pps >= 100 ? 1 : pps >= 40 ? 2 : pps >= 18 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);

  if (!node) return null;
  const popClip = pop ? edit.clips.find((c) => c.id === pop) : undefined;
  return (
    <div ref={root} className={`rs-tl${collapsed ? ' is-collapsed' : ''}`} style={collapsed ? undefined : { height: h }} tabIndex={-1} role="region" aria-label="Media timeline">
      {!collapsed && <div className="rs-tl__grip" onPointerDown={grip} role="separator" aria-orientation="horizontal" title="Drag to resize the editor" />}
      <div className="rs-tl__head">
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Expand the editor' : 'Collapse the editor'}><span style={{ display: 'inline-flex', transform: collapsed ? 'rotate(180deg)' : undefined }}><Icon name="chevronDown" /></span></button>
        <span className="rs-caps">Edit{node.label ? ` · ${node.label}` : ''}</span>
        <span className="rs-tl__len rs-num" title="Length of the edit">{formatTime(end)}</span>
        <span className="rs-tl__sp" />
        {!collapsed && <>
          <button className={`rs-btn${setsLength ? ' is-on' : ''}`} onClick={() => ed.setParam(nodeId, 'setsLength', !setsLength)} aria-pressed={setsLength} title="The whole project (playback and export) becomes exactly as long as this edit.">Set project length</button>
          <button className="rs-btn" onClick={split} title="Cut the selected clip at the playhead (S)">Split</button>
          <button className="rs-btn" onClick={remove} disabled={!sel} title="Delete the selected clip (Del)"><Icon name="trash" /></button>
          <div style={{ width: 120 }}><NumberField label="Zoom" min={10} max={400} integer value={pps} defaultValue={60} onChange={setPps} /></div>
        </>}
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      {!collapsed && <div className="rs-tl__body">
        <div className="rs-tl__heads" style={{ width: HEAD_W }}>
          <div className="rs-tl__corner" />
          {lanes.map((l, i) => (
            <div key={`${l.kind}${l.track}`} className={`rs-tl__thead${i === nV ? ' rs-tl__lane--split' : ''}`} style={{ height: TRACK_H }}>
              <div className="rs-tl__trow">
                <Icon name={l.kind === 'video' ? 'video' : 'audio'} size={13} />
                <span className="rs-tl__lbl rs-num">{l.kind === 'video' ? 'V' : 'A'}{l.track + 1}</span>
                {l.kind === 'video' && l.track === nV - 1 && <span className="rs-insp__hint" style={{ margin: 0 }}>front</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="rs-tl__scroll">
          <div className="rs-tl__canvas" style={{ width: total * pps }}>
            <div
              className="rs-tl__ruler"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const seek = (cx: number) => io.player.seek(Math.max(0, (cx - r.left) / pps));
                seek(e.clientX);
                dragWindow((ev) => seek(ev.clientX));
              }}
            >
              <div className="rs-tl__loop" style={{ width: project.duration * pps }} title="Project length" />
              {ticks.map((t) => (
                <span key={t} className="rs-tl__tick rs-num" style={{ left: t * pps }}>{t}s</span>
              ))}
            </div>
            {lanes.map((l, i) => (
              <div key={`${l.kind}${l.track}`} className={`rs-tl__lane${i === nV ? ' rs-tl__lane--split' : ''}`} data-lane={`${l.kind}${l.track}`} data-kind={l.kind} data-track={l.track} style={{ height: TRACK_H }} onPointerDown={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
                <div className="rs-tl__loop rs-tl__loop--lane" style={{ width: project.duration * pps }} />
                {edit.clips.filter((c) => c.kind === l.kind && c.track === l.track).map((c) => (
                  <div
                    key={c.id}
                    className={`rs-tl__clip ${c.kind === 'video' ? 'rs-tl__clip--v' : 'rs-tl__clip--a'}${c.id === sel ? ' is-sel' : ''}${c.mute ? ' is-muted' : ''}`}
                    style={{ left: c.start * pps, width: Math.max(4, c.duration * pps) }}
                    onPointerDown={(e) => dragClip(e, c, 'move')}
                    onDoubleClick={() => setPop(c.id)}
                    title={`${c.name ?? (c.kind === 'video' ? 'Clip' : 'Sound')} · ${formatTime(c.start)} to ${formatTime(clipEnd(c))} · drag to move (Alt: no snap) · edges trim · S splits at the playhead · Del · double-click: opacity, fades`}
                  >
                    {c.kind === 'audio' && c.asset && <ClipWave clip={{ length: c.duration, offset: c.in, loop: false, srcLength: c.duration, asset: c.asset }} pps={pps} />}
                    <span className="rs-tl__edge rs-tl__edge--l" onPointerDown={(e) => dragClip(e, c, 'l')} />
                    <span className="rs-tl__cname">{c.name ?? (c.kind === 'video' ? 'Clip' : 'Sound')}</span>
                    <ClipHandles clip={{ length: c.duration, fadeIn: c.fadeIn, fadeOut: c.fadeOut, loop: false }} pps={pps} loopHandle={false} onGrab={(ev, part) => dragFade(ev, c, part)} />
                    <span className="rs-tl__edge rs-tl__edge--r" onPointerDown={(e) => dragClip(e, c, 'r')} />
                  </div>
                ))}
              </div>
            ))}
            {edit.clips.length === 0 && <div className="rs-tl__empty" style={{ position: 'absolute', left: 0, right: 0, top: 24 + TRACK_H }}>Wire pictures into the Clips input of this node (and sounds into Sounds): each one is added at the end.</div>}
            <div className="rs-tl__end" style={{ left: end * pps }} title="End of the edit" />
            <div ref={head} className="rs-tl__playhead" />
          </div>
        </div>
      </div>}
      {!collapsed && popClip && (
        <div className="rs-tl__pop" style={{ right: 12, top: 36 }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <div className="rs-caps"><span>{popClip.name ?? 'Clip'}</span><button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => setPop(null)} aria-label="Close"><Icon name="close" size={12} /></button></div>
          <NumberField label={popClip.kind === 'video' ? 'Opacity' : 'Volume'} unit="%" step={1} min={0} max={200} integer value={Math.round(popClip.level * 100)} defaultValue={100} onChange={(v) => write(updateClip(edit, popClip.id, { level: v / 100 }))} />
          <NumberField label="Fade in" step={0.01} min={0} unit="s" value={Number(popClip.fadeIn.toFixed(3))} defaultValue={0} onChange={(v) => write(updateClip(edit, popClip.id, { fadeIn: Math.max(0, Math.min(popClip.duration - popClip.fadeOut, v)) }))} />
          <NumberField label="Fade out" step={0.01} min={0} unit="s" value={Number(popClip.fadeOut.toFixed(3))} defaultValue={0} onChange={(v) => write(updateClip(edit, popClip.id, { fadeOut: Math.max(0, Math.min(popClip.duration - popClip.fadeIn, v)) }))} />
          <div className="rs-insp__actions">
            <button className={`rs-btn${popClip.mute ? ' is-on' : ''}`} onClick={() => write(updateClip(edit, popClip.id, { mute: !popClip.mute }))}>Mute clip</button>
          </div>
        </div>
      )}
      {!collapsed && <div className="rs-tl__foot rs-insp__hint">Higher video tracks are in front · clips overlapping on one track cross-dissolve · drag to move, edges trim, S splits at the playhead, Del removes · Alt = no snapping · dashed line = end of the edit</div>}
    </div>
  );
}
