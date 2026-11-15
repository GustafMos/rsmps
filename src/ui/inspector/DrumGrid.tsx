import { useEffect, useRef } from 'react';
import {
  DRUM_LABELS,
  DRUM_VOICES,
  clearAll,
  clearVoice,
  normalizePattern,
  randomizeVoice,
  rotateVoice,
  setSteps,
  setStep,
  setSwing,
  type DrumPattern,
  type DrumVoice,
} from '../../engine/audio/drum-pattern';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { useApp, useEd } from '../store/context';
import './drum.css';

const ACCENTS = [1, 0.7, 0.4];

/** True for a value shaped like a drum pattern (so detection never relies on a node id). */
export function looksLikeDrumPattern(v: unknown): boolean {
  const r = v as { tracks?: unknown; steps?: unknown } | null;
  return !!r && typeof r === 'object' && !!r.tracks && typeof r.tracks === 'object' && (r.steps === 16 || r.steps === 32);
}

/** Step grid for a `pattern` json param: click toggles, drag paints, Alt-click or right-click cycles the accent. */
export function DrumGrid({ nodeId, keyName, value }: { nodeId: string; keyName: string; value: unknown }) {
  const { ed, io } = useApp();
  const p = normalizePattern(value);
  const pRef = useRef(p);
  pRef.current = p;
  const grid = useRef<HTMLDivElement>(null);
  const bpm = useEd((s) => Number(s.graph.nodes.find((n) => n.id === nodeId)?.params.bpm ?? 120));
  const sync = useEd((s) => String(s.graph.nodes.find((n) => n.id === nodeId)?.params.sync ?? 'tempo'));
  const duration = useEd((s) => s.graph.project.duration);
  const write = (next: DrumPattern) => ed.setParam(nodeId, keyName, next);

  // highlight the step being played without any React render per frame
  useEffect(() => {
    const stepSeconds = sync === 'project' ? duration / p.steps : 60 / bpm / 4;
    let last = -1;
    const place = () => {
      const st = io.player.getState();
      const step = stepSeconds > 0 ? Math.floor(st.seconds / stepSeconds + 1e-6) % p.steps : -1;
      if (step === last || !grid.current) return;
      grid.current.querySelectorAll('.is-now').forEach((e) => e.classList.remove('is-now'));
      grid.current.querySelectorAll(`[data-step="${step}"]`).forEach((e) => e.classList.add('is-now'));
      last = step;
    };
    place();
    return io.player.subscribe(place);
  }, [io, bpm, sync, duration, p.steps]);

  const paint = (voice: DrumVoice, step: number, mode: 'on' | 'off') => {
    const cur = pRef.current;
    const has = cur.tracks[voice][step] > 0;
    if ((mode === 'on') === has) return;
    write(setStep(cur, voice, step, mode === 'on' ? 1 : 0));
  };
  const down = (e: React.PointerEvent, voice: DrumVoice, step: number) => {
    e.preventDefault();
    const cur = pRef.current;
    const v = cur.tracks[voice][step];
    if (e.altKey || e.button === 2) {
      if (v > 0) write(setStep(cur, voice, step, ACCENTS[(ACCENTS.findIndex((a) => Math.abs(a - v) < 0.05) + 1) % ACCENTS.length]));
      return;
    }
    const mode = v > 0 ? 'off' : 'on';
    ed.beginHold();
    paint(voice, step, mode);
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cell = el?.closest<HTMLElement>('[data-cell]');
      if (cell && cell.dataset.voice) paint(cell.dataset.voice as DrumVoice, Number(cell.dataset.step), mode);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ed.endHold();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="rs-drum" data-nodrag>
      <div ref={grid} className="rs-drum__grid" style={{ gridTemplateColumns: `64px repeat(${p.steps}, 1fr) auto` }} onContextMenu={(e) => e.preventDefault()}>
        {DRUM_VOICES.map((voice) => (
          <div key={voice} style={{ display: 'contents' }}>
            <span className="rs-drum__label" title={voice}>{DRUM_LABELS[voice]}</span>
            {p.tracks[voice].map((v, i) => (
              <button
                key={i}
                data-cell
                data-voice={voice}
                data-step={i}
                className={`rs-drum__cell${v > 0 ? ' is-on' : ''}${i % 4 === 0 ? ' is-beat' : ''}`}
                style={v > 0 ? { opacity: 0.35 + v * 0.65 } : undefined}
                aria-pressed={v > 0}
                aria-label={`${DRUM_LABELS[voice]} step ${i + 1}`}
                onPointerDown={(e) => down(e, voice, i)}
              />
            ))}
            <span className="rs-drum__tools">
              <button title="Shift left" onClick={() => write(rotateVoice(p, voice, -1))}><Icon name="chevronLeft" size={12} /></button>
              <button title="Shift right" onClick={() => write(rotateVoice(p, voice, 1))}><Icon name="chevronRight" size={12} /></button>
              <button title="Random hits" onClick={() => write(randomizeVoice(p, voice, 0.3, Math.floor(Math.random() * 1e6)))}>?</button>
              <button title="Clear this row" onClick={() => write(clearVoice(p, voice))}><Icon name="close" size={12} /></button>
            </span>
          </div>
        ))}
      </div>
      <div className="rs-drum__bar">
        <div className="rs-seg2">
          {([16, 32] as const).map((n) => (
            <button key={n} className={p.steps === n ? 'is-on' : ''} onClick={() => write(setSteps(p, n))}>{n} steps</button>
          ))}
        </div>
        <div style={{ width: 140 }}><NumberField label="Swing" min={0} max={0.75} step={0.01} value={p.swing} defaultValue={0} onChange={(v) => write(setSwing(p, v))} /></div>
        <button className="rs-btn" onClick={() => write(clearAll(p))}>Clear all</button>
      </div>
      <p className="rs-insp__hint">Click or drag to paint steps. Alt-click or right-click a step to cycle its accent (full, medium, soft).</p>
    </div>
  );
}
