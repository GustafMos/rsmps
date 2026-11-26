import { useEffect, useRef, useState } from 'react';
import { clampFps, cycleHold, describeShots, normalizeShots, shotFrames, type Shot } from '../../engine/lib/stop-motion';
import { formatElapsed } from '../../io/live-record';
import { Thumb } from '../components/Thumb';
import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { getLive } from '../store/live';
import { countdown } from '../store/stopMotion';

const CELL = 76; // width of one thumbnail plus its gap
const OVERSCAN = 4;

/** Thumbnails of the shots in order. Only the ones in view are drawn, so hundreds of shots stay light. */
function Strip({ shots, selected, fps, onSelect, onHold }: { shots: Shot[]; selected: number; fps: number; onSelect(i: number): void; onHold(i: number): void }) {
  const { io } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 320 });
  const measure = () => {
    const el = box.current;
    if (el) setView((v) => (v.left === el.scrollLeft && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }));
  };
  useEffect(measure, [shots.length]);
  // keep the selected shot (and a newly added one) in view
  useEffect(() => {
    const el = box.current;
    if (!el || selected < 0) return;
    const x = selected * CELL;
    if (x < el.scrollLeft) el.scrollLeft = x;
    else if (x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = x + CELL - el.clientWidth;
  }, [selected, shots.length]);
  const first = Math.max(0, Math.floor(view.left / CELL) - OVERSCAN);
  const last = Math.min(shots.length, Math.ceil((view.left + view.width) / CELL) + OVERSCAN);
  const items = [];
  for (let i = first; i < last; i++) {
    const s = shots[i];
    const frames = shotFrames(s, fps);
    items.push(
      <div key={i} className={`rs-sm__cell${i === selected ? ' is-sel' : ''}`} style={{ left: i * CELL }}>
        <button className="rs-sm__pic" aria-label={`Shot ${i + 1}`} aria-pressed={i === selected} onClick={() => onSelect(i)}>
          <Thumb asset={io.library.assetInfo(s.asset) ?? undefined} size={64} />
          <span className="rs-sm__no">{i + 1}</span>
          {s.kind === 'clip' && <span className="rs-sm__kind">clip</span>}
        </button>
        {s.kind === 'still' ? (
          <button className="rs-sm__hold" title="Hold: how many animation frames this picture lasts. Tap to change." onClick={() => onHold(i)}>
            x{frames}
          </button>
        ) : (
          <span className="rs-sm__hold rs-sm__hold--static">{(s.seconds ?? 0).toFixed(1)} s</span>
        )}
      </div>,
    );
  }
  return (
    <div ref={box} className="rs-sm__strip" onScroll={measure} role="list" aria-label="Shots">
      <div className="rs-sm__track" style={{ width: Math.max(1, shots.length) * CELL }}>
        {items}
      </div>
    </div>
  );
}

/** Inspector section of the Stop Motion node: take pictures, record snippets, auto shoot, and edit the shots. `id` is the node's id. */
export function StopMotionPanel({ id, params }: { id: string; params: Readonly<Record<string, unknown>> }) {
  const app = useApp();
  const sm = getLive(app).stopMotion;
  const ui = useSelector(sm.store, (s) => s);
  const shots = normalizeShots(params.shots);
  const fps = clampFps(params.fps);
  const [sel, setSel] = useState(-1);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ui.auto.running && ui.snippet !== 'recording') return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [ui.auto.running, ui.snippet]);
  useEffect(() => {
    if (sel >= shots.length) setSel(shots.length - 1);
  }, [shots.length, sel]);

  const mine = ui.nodeId === id;
  const auto = mine && ui.auto.running;
  const recording = mine && ui.snippet === 'recording';
  const rec = app.io.liveRecorder;
  const busy = ui.busy;
  const take = async () => {
    if (await sm.take(id)) setSel(sm.shots(id).length - 1);
  };
  const cur = sel >= 0 && sel < shots.length ? shots[sel] : null;
  const confirmClear = () => {
    if (shots.length && window.confirm(`Delete all ${shots.length} shots from this animation? The pictures stay in Media, and Undo brings the shots back.`)) {
      sm.clearAll(id);
      setSel(-1);
    }
  };

  return (
    <div className="rs-insp__sec rs-sm">
      <div className="rs-caps">Shoot</div>
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary rs-sm__take" disabled={busy || recording} title="Takes the picture that is coming in right now as the next shot" onClick={take}>
          {busy ? 'Saving' : 'Take picture'}
        </button>
        <button className="rs-btn" disabled={shots.length === 0} title="Remove the last shot" onClick={() => sm.undoLast(id)}>
          Undo last shot
        </button>
      </div>
      <div className="rs-insp__actions">
        <button className={`rs-btn${recording ? ' is-on' : ''}`} disabled={ui.snippet === 'saving' || auto} title="Records the live picture as a short clip that becomes one shot, played at its own speed" onClick={() => sm.toggleSnippet(id)}>
          {recording ? `Stop snippet ${formatElapsed(rec.elapsed)}` : ui.snippet === 'saving' ? 'Saving' : 'Record snippet'}
        </button>
        <button className={`rs-btn${auto ? ' is-on' : ''}`} disabled={recording} title="Takes a picture by itself every few seconds (set the time in Auto shoot every): time-lapse and hyperlapse" onClick={() => sm.toggleAuto(id)}>
          {auto ? `Stop auto shoot · next in ${countdown(ui.auto, performance.now())} s · ${ui.auto.count}${ui.auto.limit ? ` of ${ui.auto.limit}` : ''}` : 'Start auto shoot'}
        </button>
      </div>
      <p className="rs-insp__hint">
        Auto shoot takes a picture every {Number(params.interval) || 2} s (change it under Shooting below). The page must stay open and on screen while it runs: the phone must not lock or switch to another app. The screen is kept awake for you where the browser allows it.
      </p>

      <div className="rs-caps">
        Shots <span className="rs-sm__count">{describeShots(shots, fps)} at {fps} fps</span>
      </div>
      {shots.length === 0 ? (
        <p className="rs-insp__hint">No shots yet. Wire a Webcam into Picture, then press Take picture for each frame.</p>
      ) : (
        <Strip shots={shots} selected={sel} fps={fps} onSelect={setSel} onHold={(i) => sm.hold(id, i, cycleHold(shots[i].hold))} />
      )}
      {cur && (
        <div className="rs-insp__actions rs-sm__tools" role="toolbar" aria-label={`Shot ${sel + 1}`}>
          <button className="rs-btn" disabled={sel === 0} title="Move this shot earlier" onClick={() => (sm.move(id, sel, -1), setSel(sel - 1))}>
            Earlier
          </button>
          <button className="rs-btn" disabled={sel >= shots.length - 1} title="Move this shot later" onClick={() => (sm.move(id, sel, 1), setSel(sel + 1))}>
            Later
          </button>
          <button className="rs-btn" onClick={() => sm.duplicate(id, sel)}>
            Duplicate
          </button>
          <button className="rs-btn" disabled={busy || recording} title="Replace this shot with the picture coming in now" onClick={() => void sm.retake(id, sel)}>
            Retake
          </button>
          {cur.kind === 'still' && (
            <>
              <button className="rs-btn" disabled={(cur.hold ?? 1) <= 1} aria-label="Hold shorter" onClick={() => sm.hold(id, sel, (cur.hold ?? 1) - 1)}>
                -
              </button>
              <span className="rs-sm__holdv" title="Animation frames this picture lasts">Hold {cur.hold ?? 1}</span>
              <button className="rs-btn" aria-label="Hold longer" onClick={() => sm.hold(id, sel, (cur.hold ?? 1) + 1)}>
                +
              </button>
            </>
          )}
          <button className="rs-btn rs-btn--danger" onClick={() => (sm.remove(id, sel), setSel(Math.min(sel, shots.length - 2)))}>
            Delete
          </button>
        </div>
      )}
      {shots.length > 0 && (
        <div className="rs-insp__actions">
          <button className="rs-btn rs-btn--danger" onClick={confirmClear}>
            Clear all
          </button>
        </div>
      )}
      <p className="rs-insp__hint">The pictures are kept in Media, so they stay with the project and export exactly as you see them. Deleting a shot only takes it out of the animation.</p>
    </div>
  );
}
