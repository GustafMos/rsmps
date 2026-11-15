import { KEY_NOTES, clampOctave, noteName, octaveBaseNote } from '../../engine/audio/keyboard-map';
import { playNote, pianoStore } from '../playKeys';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import './piano.css';

const WHITE = KEY_NOTES.filter((k) => !k.black);

/** On-screen keyboard for a playable node: shows the computer-key labels, lights up held notes, plays with the mouse. */
export function Piano({ nodeId }: { nodeId: string }) {
  const app = useApp();
  const octave = useEd((s) => clampOctave(Number(s.graph.nodes.find((n) => n.id === nodeId)?.params.baseOctave ?? 5)));
  const lit = useSelector(pianoStore, (s) => (s.node === nodeId ? s.notes : null));
  const base = octaveBaseNote(octave);
  const w = 100 / WHITE.length;
  const press = (e: React.PointerEvent, semitone: number) => {
    e.preventDefault();
    const note = base + semitone;
    if (note > 127) return;
    playNote(app, 'mouse', nodeId, note, true);
  };
  const enter = (e: React.PointerEvent, semitone: number) => {
    if (e.buttons !== 1) return;
    playNote(app, 'mouse', nodeId, 0, false);
    const note = base + semitone;
    if (note <= 127) playNote(app, 'mouse', nodeId, note, true);
  };
  const release = () => playNote(app, 'mouse', nodeId, 0, false);

  return (
    <div className="rs-piano" data-nodrag onPointerUp={release} onPointerLeave={release} onPointerCancel={release}>
      <div className="rs-piano__keys">
        {WHITE.map((k, i) => (
          <button
            key={k.code}
            className={`rs-piano__white${lit?.has(base + k.semitone) ? ' is-lit' : ''}`}
            style={{ left: `${i * w}%`, width: `${w}%` }}
            title={noteName(base + k.semitone)}
            onPointerDown={(e) => press(e, k.semitone)}
            onPointerEnter={(e) => enter(e, k.semitone)}
          >
            <span className="rs-piano__label">{k.label}</span>
          </button>
        ))}
        {KEY_NOTES.filter((k) => k.black).map((k) => {
          const prev = WHITE.findIndex((x) => x.semitone === k.semitone - 1);
          return (
            <button
              key={k.code}
              className={`rs-piano__black${lit?.has(base + k.semitone) ? ' is-lit' : ''}`}
              style={{ left: `${(prev + 1) * w - w * 0.3}%`, width: `${w * 0.6}%` }}
              title={noteName(base + k.semitone)}
              onPointerDown={(e) => press(e, k.semitone)}
              onPointerEnter={(e) => enter(e, k.semitone)}
            >
              <span className="rs-piano__label">{k.label}</span>
            </button>
          );
        })}
      </div>
      <p className="rs-insp__hint">
        Octave {octave} ({noteName(base)} and up). While this node is selected the computer keyboard plays it: A–; are the keys, 1–9 set the octave (5 is normal), Z/X step the octave, C/V soften or strengthen the keys.
      </p>
    </div>
  );
}
