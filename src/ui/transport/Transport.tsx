import type { InputSchema, OutputSchema } from '../../engine/types';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { formatTime } from '../lib/drag';
import { useApp, useEd, usePlayer } from '../store/context';
import { useKeyboardTarget } from '../playKeys';
import { RecordButton } from '../timeline/RecordButton';
import '../palette/studio.css';
import './transport.css';

export function Transport() {
  const { io, ed } = useApp();
  const playing = usePlayer((s) => s.playing);
  const project = useEd((s) => s.graph.project);
  const hasAudio = useEd((s) => s.graph.nodes.some((n) => hasAudioSockets(io.registry.get(n.type))));
  const [volume, setVolume] = useState(1);
  const audio = usePlayer((s) => s.audio);
  const kbdTarget = useKeyboardTarget();
  const kbdName = useEd((s) => {
    const n = s.graph.nodes.find((x) => x.id === kbdTarget);
    return n ? n.label || io.registry.get(n.type)?.title || n.type : '';
  });

  return (
    <footer className="rs-tp">
      <div className="rs-tp__group">
        <button className="rs-btn rs-btn--icon" onClick={() => io.player.step(-1)} title="Previous frame (←)"><Icon name="stepBack" /></button>
        <button className={`rs-btn rs-btn--icon rs-tp__play${playing ? ' is-on' : ''}`} onClick={() => io.player.toggle()} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button className="rs-btn rs-btn--icon" onClick={() => io.player.step(1)} title="Next frame (→)"><Icon name="stepFwd" /></button>
        <button
          className={`rs-btn rs-tp__loop${project.loop ? ' is-on' : ''}`}
          onClick={() => ed.setProject({ loop: !project.loop })}
          role="switch"
          aria-checked={project.loop}
          title="One-click looping: when on, every animated node repeats exactly over the duration, so the last frame flows into the first."
        >
          <Icon name="loop" />
          <span>LOOP</span>
          <span className="rs-tp__loopstate">{project.loop ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      <Readout />
      <Scrubber />

      <div className="rs-tp__group">
        <div className="rs-tp__field"><NumberField label="FPS" value={project.fps} min={1} max={120} integer defaultValue={24} onChange={(v) => ed.setProject({ fps: v })} /></div>
        <div className="rs-tp__field rs-tp__field--wide"><NumberField label="Length" value={project.duration} min={0.1} max={600} step={0.1} unit="s" defaultValue={4} onChange={(v) => ed.setProject({ duration: v })} /></div>
        <RecordButton compact />
        {kbdTarget && (
          <span className="rs-tp__kbd" title="Computer keys play the selected node: A–; notes, 1–9 octave, Z/X octave down/up, C/V softer/harder. Esc or deselect to release the keys.">
            <Icon name="keyboard" size={14} /> Keyboard plays {kbdName}
          </span>
        )}
        {(hasAudio || audio.needed) && (
          <>
            {!audio.running ? (
              <button
                className="rs-btn rs-btn--primary"
                onClick={() => io.player.enableAudio().catch((e) => ed.toast(`Audio: ${e instanceof Error ? e.message : String(e)}`, 'error'))}
                title={audio.micNodes > 0 ? 'Starts sound. The browser will ask for permission to use the microphone.' : 'Browsers need a click before they allow sound'}
              >
                <Icon name="volume" /> Enable audio{audio.micNodes > 0 ? ' + mic' : ''}
              </button>
            ) : (
              <span className="rs-tp__audio" title="The audio engine is running"><span className="rs-ps__dot" /> Audio on</span>
            )}
            {audio.needed && !audio.running && audio.micNodes > 0 && <span className="rs-tp__note">asks for the microphone</span>}
            <div className="rs-tp__field">
              <NumberField label="Vol" value={volume} min={0} max={1} step={0.01} defaultValue={1} onChange={(v) => { setVolume(v); io.player.setVolume(v); }} />
            </div>
          </>
        )}
      </div>
    </footer>
  );
}

function hasAudioSockets(def: ReturnType<ReturnType<typeof useApp>['io']['registry']['get']>): boolean {
  if (!def) return false;
  return Object.values(def.outputs as OutputSchema).some((o) => o.type === 'audio') || Object.values(def.inputs as InputSchema).some((i) => i.type === 'audio');
}

/** Time and frame readout: updated straight from the player, never through React state. */
function Readout() {
  const { io, ed } = useApp();
  const time = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const draw = () => {
      const s = io.player.getState();
      if (time.current) time.current.textContent = formatTime(s.seconds, ed.state.graph.project.fps);
      if (frame.current) frame.current.textContent = `${s.frame + 1} / ${s.totalFrames}`;
    };
    draw();
    return io.player.subscribe(draw);
  }, [io, ed]);
  return (
    <div className="rs-tp__read rs-num">
      <span ref={time} className="rs-tp__time">0:00.00</span>
      <span ref={frame} className="rs-tp__frame">1 / 1</span>
    </div>
  );
}

/** Scrubber with the cached-frames bar. Everything is imperative. */
function Scrubber() {
  const { io, ed } = useApp();
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const cache = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ set: ReadonlySet<number> | null; size: number; total: number; w: number }>({ set: null, size: -1, total: 0, w: 0 });

  useEffect(() => {
    const draw = () => {
      const s = io.player.getState();
      const t = track.current;
      if (!t) return;
      const total = Math.max(1, s.totalFrames);
      if (head.current) head.current.style.left = `${((s.frame + 0.5) / total) * 100}%`;
      const cv = cache.current;
      const l = last.current;
      const w = t.clientWidth;
      if (cv && (l.set !== s.cachedFrames || l.size !== s.cachedFrames.size || l.total !== total || l.w !== w)) {
        last.current = { set: s.cachedFrames, size: s.cachedFrames.size, total, w };
        cv.width = w;
        cv.height = 4;
        const ctx = cv.getContext('2d')!;
        ctx.clearRect(0, 0, w, 4);
        ctx.fillStyle = '#5fd68a';
        let run = -1;
        for (let f = 0; f <= total; f++) {
          const on = f < total && s.cachedFrames.has(f);
          if (on && run < 0) run = f;
          if (!on && run >= 0) {
            ctx.fillRect(Math.floor((run / total) * w), 0, Math.max(1, Math.ceil(((f - run) / total) * w)), 4);
            run = -1;
          }
        }
      }
    };
    draw();
    const unsub = io.player.subscribe(draw);
    const ro = new ResizeObserver(() => {
      last.current.w = -1;
      draw();
    });
    if (track.current) ro.observe(track.current);
    return () => {
      unsub();
      ro.disconnect();
    };
  }, [io]);

  const seekTo = (clientX: number) => {
    const t = track.current!;
    const r = t.getBoundingClientRect();
    const s = io.player.getState();
    const total = Math.max(1, s.totalFrames);
    const frame = Math.min(total - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * total)));
    io.player.seek(frame / ed.state.graph.project.fps);
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  };

  return (
    <div className="rs-tp__scrub" ref={track} onPointerDown={down} onPointerMove={move} title="Drag to scrub. Green = cached frames that play back instantly.">
      <div className="rs-tp__rail" />
      <canvas ref={cache} className="rs-tp__cache" />
      <div ref={head} className="rs-tp__head" />
    </div>
  );
}
