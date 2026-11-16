import { useEffect, useRef, useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import { matFromQuat, type Quat } from '../../engine/lib/motion-math';
import { bakeSmoothing, isTake, resetToRaw, takeDense, takeDuration, takeRawDense, type MotionTake } from '../../engine/lib/motion-take';
import type { PhoneMotionStatus } from '../../io/phone-motion';
import { useApp, useEd } from '../store/context';

const CUBE: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const EDGES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/** Live motion state of a session, refreshed about 20 times a second while the panel is open. */
function useMotionStatus(token: string): PhoneMotionStatus | null {
  const { io } = useApp();
  const [st, setSt] = useState<PhoneMotionStatus | null>(null);
  useEffect(() => {
    if (!token || !io.phone.motion) {
      setSt(null);
      return;
    }
    const tick = () => setSt(io.phone.motion?.has(token) ? io.phone.motion.session(token).status() : null);
    tick();
    const t = setInterval(tick, 50);
    return () => clearInterval(t);
  }, [io, token]);
  return st;
}

/** A small cube that follows the phone (the scene quaternion, relative to Recenter), with a horizon line and the touch point. */
function Preview({ st }: { st: PhoneMotionStatus | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const css = getComputedStyle(c);
    const fg = css.getPropertyValue('--fg') || '#cbd5e1';
    const accent = css.getPropertyValue('--accent') || '#38bdf8';
    g.clearRect(0, 0, c.width, c.height);
    const f = st?.frame;
    const q: Quat = f ? [f.qx, f.qy, f.qz, f.qw] : [0, 0, 0, 1];
    const m = matFromQuat(q);
    // horizon: the line stays level in the world, so it tilts against the phone's roll and shifts with its pitch
    g.strokeStyle = fg;
    g.globalAlpha = 0.5;
    g.beginPath();
    const roll = ((f?.roll ?? 0) * Math.PI) / 180;
    const off = (f?.pitch ?? 0) * 0.9;
    g.moveTo(10, 50 + off - Math.tan(-roll) * 70);
    g.lineTo(150, 50 + off + Math.tan(-roll) * 70);
    g.stroke();
    g.globalAlpha = 1;
    // the cube: x right, y up (canvas y flipped), z into the screen; a light perspective
    const pts = CUBE.map(([x, y, z]) => {
      const a = [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
      const k = 3.2 / (3.2 + a[2] * 0.5);
      return [80 + a[0] * 20 * k, 50 - a[1] * 20 * k];
    });
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [a, b] of EDGES) {
      g.moveTo(pts[a][0], pts[a][1]);
      g.lineTo(pts[b][0], pts[b][1]);
    }
    g.stroke();
    if (f && f.tc > 0) {
      g.fillStyle = accent;
      g.beginPath();
      g.arc(80 + f.tx * 70, 50 - f.ty * 40, 5, 0, Math.PI * 2);
      g.fill();
    }
  }, [st]);
  return <canvas ref={ref} width={160} height={100} style={{ width: 160, height: 100, border: '1px solid var(--line)', borderRadius: 6 }} aria-label="Live preview of the phone's orientation" />;
}

const CAPS: [keyof NonNullable<PhoneMotionStatus['caps']>, string][] = [
  ['orientation', 'Orientation (gyro)'],
  ['motion', 'Rate and acceleration'],
  ['absolute', 'Compass (north)'],
  ['touch', 'Touch pad'],
  ['geo', 'Location (opt in)'],
  ['ar', 'Position tracking (AR)'],
];

function Curve({ a, b }: { a: number[]; b: number[] }) {
  const n = a.length;
  if (n < 2) return null;
  const lo = Math.min(...a, ...b);
  const hi = Math.max(...a, ...b);
  const span = Math.max(1e-6, hi - lo);
  const path = (v: number[]) => v.map((x, i) => `${(i / (n - 1)) * 200},${38 - ((x - lo) / span) * 34}`).join(' ');
  return (
    <svg width="200" height="40" viewBox="0 0 200 40" role="img" aria-label="Yaw before (grey) and after (blue) smoothing" style={{ border: '1px solid var(--line)', borderRadius: 6 }}>
      <polyline points={path(a)} fill="none" stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} />
      <polyline points={path(b)} fill="none" stroke="var(--accent, #38bdf8)" strokeWidth={1.5} />
    </svg>
  );
}

/** Inspector section of Phone Motion: sensors, live preview, Recenter, Record and the take tools. */
export function PhoneMotionPanel({ node }: { node: NodeInstance }) {
  const { ed, io } = useApp();
  const token = String(node.params.session ?? '');
  const fps = useEd((s) => s.graph.project.fps);
  const st = useMotionStatus(token);
  const [err, setErr] = useState('');
  const take: MotionTake | null = isTake(node.params.take) ? node.params.take : null;
  const session = token && io.phone.motion?.has(token) ? io.phone.motion.session(token) : null;
  const recording = !!st?.recording;
  const setParams = (pairs: [string, unknown][]) => {
    ed.beginHold(); // several params, one undo step
    for (const [k, v] of pairs) ed.setParam(node.id, k, v);
    ed.endHold();
  };

  const startRec = () => {
    setErr('');
    if (!session || !st?.live) {
      setErr('Start motion on the phone first: the live indicator on this panel must be on.');
      return;
    }
    session.startRecording();
  };
  const stopRec = () => {
    if (!session) return;
    const loop = !!node.params.recLoop;
    const t = session.stopRecording({ fps, loop, loopBlend: loop ? Number(node.params.recBlend ?? 0) : 0 });
    if (!t) {
      setErr('Nothing was recorded (no motion arrived). Keep the phone page open and moving.');
      return;
    }
    setParams([['take', t], ['source', 'recorded'], ['takeSmoothing', 0]]);
  };

  const smoothing = Number(node.params.takeSmoothing ?? 0);
  const keepFast = Number(node.params.keepFast ?? 0);
  const preview = (() => {
    if (!take || smoothing <= 0) return null;
    const before = takeRawDense(take).ch.yaw;
    const after = takeDense(take, { amount: smoothing, keepFast }).ch.yaw;
    const step = Math.max(1, Math.floor(before.length / 200));
    const pick = (a: ArrayLike<number>) => Array.from({ length: Math.ceil(a.length / step) }, (_, i) => a[i * step]);
    return { a: pick(before), b: pick(after) };
  })();

  if (!token) return <div className="rs-insp__sec"><div className="rs-caps">Phone motion</div><p className="rs-insp__hint">Link a phone above, open the page on it and press Start motion.</p></div>;
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Phone motion</div>
      <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Preview st={st} />
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div role="status">
            <span aria-hidden="true" style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 6, background: st?.live ? '#22c55e' : '#64748b' }} />
            {st?.live ? `Receiving motion (${st.hz} per second)` : st?.caps ? 'Phone linked: press Start motion on the phone' : 'Waiting for the phone'}
          </div>
          {st?.caps && CAPS.map(([k, label]) => <div key={k} style={{ opacity: st.caps![k] ? 1 : 0.45 }}>{st.caps![k] ? '✓' : '–'} {label}{k === 'ar' && st.caps![k] ? ' (untested)' : ''}</div>)}
          {st?.live && <div className="rs-insp__hint">Position comes from: {st.positionSource === 'ar' ? 'AR tracking' : st.positionSource === 'location' ? 'location (metres from where you started)' : 'the touch pad (two fingers = virtual dolly)'}</div>}
        </div>
      </div>
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={!session} onClick={() => session?.recenter()} title="Make the current pose the neutral one (double-tap on the phone does the same)">Recenter</button>
        {!recording ? (
          <button className="rs-btn" disabled={!session} onClick={startRec} title="Capture the phone's movement until you press Stop">● Record motion</button>
        ) : (
          <button className="rs-btn is-on" onClick={stopRec}>■ Stop ({st?.recordedSeconds.toFixed(1)} s)</button>
        )}
      </div>
      {err && <p className="rs-insp__warn" role="alert">{err}</p>}
      {!take && !recording && <p className="rs-insp__hint">Record a move, then play it back with Source: Recorded. Exports and the command line use the take; they cannot use the live phone.</p>}
      {take && (
        <>
          <p className="rs-insp__hint">
            Take: {takeDuration(take).toFixed(1)} s at {take.fps} fps{take.loop ? ', loops' : ''}{take.baked ? ', smoothed (baked)' : ''}. Raw recording is kept.
          </p>
          {preview && <Curve a={preview.a} b={preview.b} />}
          <div className="rs-insp__actions">
            <button
              className="rs-btn"
              disabled={smoothing <= 0}
              title="Make the smoothing permanent (one undo step). The raw recording is kept."
              onClick={() => setParams([['take', bakeSmoothing(take, { amount: smoothing, keepFast })], ['takeSmoothing', 0]])}
            >
              Smooth take
            </button>
            <button className="rs-btn" disabled={!take.baked} onClick={() => setParams([['take', resetToRaw(take)]])}>Reset to raw</button>
            <button className="rs-btn" onClick={() => setParams([['take', null], ['source', 'live'], ['takeSmoothing', 0]])}>Delete take</button>
          </div>
          {smoothing <= 0 && <p className="rs-insp__hint">Raise "Take smoothing" to preview a smoother take, then press Smooth take to keep it.</p>}
        </>
      )}
    </div>
  );
}
