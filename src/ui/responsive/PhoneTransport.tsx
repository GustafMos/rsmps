import { useState } from 'react';
import { effectiveDuration } from '../../engine/graph';
import type { InputSchema, OutputSchema } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { SelectField } from '../components/fields';
import { MemoryMeter } from '../transport/MemoryMeter';
import { ProcessesButton } from '../transport/ProcessesButton';
import { RenderPause } from '../transport/RenderPause';
import { Readout, Scrubber } from '../transport/Transport';
import { RecordButton } from '../timeline/RecordButton';
import { useApp, useEd, usePlayer } from '../store/context';
import { PREVIEW_SCALES, loadPreviewScale, savePreviewScale, type PreviewScale } from './deviceDefaults';
import { Sheet } from './Sheet';

const hasAudioSockets = (def: { outputs: unknown; inputs: unknown } | undefined): boolean =>
  !!def && (Object.values(def.outputs as OutputSchema).some((o) => o.type === 'audio') || Object.values(def.inputs as InputSchema).some((i) => i.type === 'audio'));

/**
 * The transport on a phone: play, the time and scrub bar, loop, and a "…" for the rest (fps, length, pause rendering, processes,
 * memory, preview scale, audio). Same player and same Scrubber as the desktop transport, just fewer things on one row.
 */
export function PhoneTransport() {
  const { io, ed } = useApp();
  const playing = usePlayer((s) => s.playing);
  const loop = useEd((s) => s.graph.project.loop);
  const [more, setMore] = useState(false);
  return (
    <footer className="rs-ptp">
      <button className={`rs-btn rs-btn--icon rs-ptp__play${playing ? ' is-on' : ''}`} onClick={() => io.player.toggle()} aria-label={playing ? 'Pause' : 'Play'}>
        <Icon name={playing ? 'pause' : 'play'} size={20} />
      </button>
      <Readout />
      <Scrubber />
      <button className={`rs-btn rs-btn--icon${loop ? ' rs-ptp__loop is-on' : ' rs-ptp__loop'}`} onClick={() => ed.setProject({ loop: !loop })} role="switch" aria-checked={loop} aria-label="Loop" title="Loop: every animated node repeats exactly over the duration">
        <Icon name="loop" size={18} />
      </button>
      <button className="rs-btn rs-btn--icon" onClick={() => setMore(true)} aria-label="More playback settings" aria-haspopup="dialog">
        <Icon name="more" size={18} />
      </button>
      {more && <TransportSheet onClose={() => setMore(false)} />}
    </footer>
  );
}

function TransportSheet({ onClose }: { onClose: () => void }) {
  const { io, ed } = useApp();
  const project = useEd((s) => s.graph.project);
  const lengthSet = useEd((s) => effectiveDuration(s.graph, io.registry) !== null);
  const hasAudio = useEd((s) => s.graph.nodes.some((n) => hasAudioSockets(io.registry.get(n.type))));
  const audio = usePlayer((s) => s.audio);
  const [scale, setScale] = useState<PreviewScale>(() => loadPreviewScale(typeof localStorage === 'undefined' ? null : localStorage) ?? 'auto');
  return (
    <Sheet title="Playback" onClose={onClose}>
      <div className="rs-sheet__grid">
        <NumberField label="FPS" value={project.fps} min={1} max={120} integer defaultValue={24} onChange={(v) => ed.setProject({ fps: v })} />
        <NumberField label="Length" value={project.duration} min={0.1} max={600} step={0.1} unit="s" defaultValue={4} disabled={lengthSet} title={lengthSet ? 'The length follows the Media Timeline' : undefined} onChange={(v) => ed.setProject({ duration: v })} />
        <NumberField label="Frames" value={Math.max(1, Math.round(project.duration * project.fps))} min={1} max={600 * project.fps} integer defaultValue={4 * project.fps} disabled={lengthSet} title={lengthSet ? 'The length follows the Media Timeline' : 'The same length, counted in frames'} onChange={(v) => ed.setProject({ duration: v / project.fps })} />
      </div>
      <div className="rs-sheet__row">
        <span className="rs-sheet__lbl">Preview scale</span>
        <SelectField
          label="Preview scale"
          value={String(scale)}
          options={PREVIEW_SCALES.map((s) => ({ value: String(s), label: s === 'auto' ? 'Auto (lower while playing)' : `${Math.round(s * 100)} %` }))}
          onChange={(v) => {
            const next: PreviewScale = v === 'auto' ? 'auto' : Number(v);
            setScale(next);
            savePreviewScale(io, next);
          }}
        />
      </div>
      <p className="rs-insp__hint">Phones start at a lower preview scale to stay smooth. "Full res" in the viewer renders the current frame once at final quality.</p>
      <div className="rs-sheet__actions">
        <RenderPause />
        <RecordButton compact />
        {(hasAudio || audio.needed) &&
          (!audio.running ? (
            <button
              className="rs-btn rs-btn--primary"
              onClick={() => {
                ed.ensureAudioOutput(); // a clip with sound and no Audio Output yet: add one, wired
                io.player.enableAudio().catch((e) => ed.toast(`Audio: ${e instanceof Error ? e.message : String(e)}`, 'error'));
              }}
            >
              <Icon name="volume" /> Enable audio{audio.micNodes > 0 ? ' + mic' : ''}
            </button>
          ) : (
            <span className="rs-tp__audio"><span className="rs-ps__dot" /> Audio on</span>
          ))}
      </div>
      <div className="rs-sheet__actions">
        <ProcessesButton />
        <MemoryMeter />
      </div>
    </Sheet>
  );
}
