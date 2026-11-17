import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlankPlanInfo, PrintBlankOptions } from '../../io/api';
import { FRAME_GUIDES, type FrameGuide } from '../../io/print/layout';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField, TextField } from '../components/fields';
import { Dialog } from '../dialogs/Dialog';
import { useApp, useEd } from '../store/context';

const ASPECTS = [
  { value: 'project', label: 'Same as this project' },
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1 (square)' },
  { value: '3:4', label: '3:4 (portrait)' },
  { value: '9:16', label: '9:16 (vertical video)' },
  { value: '4:5', label: '4:5' },
  { value: '2:3', label: '2:3' },
  { value: '21:9', label: '21:9 (cinema)' },
  { value: 'custom', label: 'Custom (width : height)' },
];

const GUIDE_LABEL: Record<FrameGuide, string> = {
  cross: 'Center cross',
  thirds: 'Thirds',
  safe: 'Safe area',
  grid: 'Light grid',
  horizon: 'Perspective horizon line',
  pegs: 'Registration / peg marks',
};

/** File > Print blank sheets: frame boxes, scan markers and frame numbers only, for animation drawn entirely on paper. No project graph is needed. */
export function BlankSheetsDialog() {
  const { io, ed } = useApp();
  const project = useEd((s) => s.graph.project);
  const [by, setBy] = useState<'frames' | 'seconds'>('frames');
  const [frames, setFrames] = useState(48);
  const [seconds, setSeconds] = useState(4);
  const [fps, setFps] = useState(project.fps || 12);
  const [aspect, setAspect] = useState('project');
  const [customW, setCustomW] = useState(4);
  const [customH, setCustomH] = useState(3);
  const [perSheet, setPerSheet] = useState(6);
  const [paper, setPaper] = useState<'a4' | 'a3' | 'letter' | 'a5' | 'legal'>('a4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [margin, setMargin] = useState(10);
  const [gutter, setGutter] = useState(5);
  const [guides, setGuides] = useState<FrameGuide[]>([]);
  const [ghost, setGhost] = useState(false);
  const [numbers, setNumbers] = useState(true);
  const [shootOn, setShootOn] = useState(1);
  const [exposure, setExposure] = useState(false);
  const [audioId, setAudioId] = useState('');
  const [name, setName] = useState('Paper animation');
  const [format, setFormat] = useState<'pdf' | 'png' | 'both'>('pdf');
  const [busy, setBusy] = useState<string | null>(null);
  const audio = io.library.list().filter((a) => a.kind === 'audio' || (a.kind === 'video' && a.hasAudio));
  const beatsRef = useRef<{ id: string; fps: number; frames: number[] } | null>(null);

  const options = useMemo<PrintBlankOptions>(
    () => ({
      frames: by === 'frames' ? frames : undefined,
      seconds: by === 'seconds' ? seconds : undefined,
      fps,
      aspect: aspect === 'custom' ? { width: Math.max(0.1, customW), height: Math.max(0.1, customH) } : aspect,
      project: { width: project.width, height: project.height },
      perSheet,
      paper,
      orientation,
      marginMm: margin,
      gutterMm: gutter,
      guides,
      ghostNumbers: ghost,
      numbers,
      shootOn,
      exposureSheet: exposure,
      name,
      output: format,
    }),
    [by, frames, seconds, fps, aspect, customW, customH, project.width, project.height, perSheet, paper, orientation, margin, gutter, guides, ghost, numbers, shootOn, exposure, name, format],
  );

  const plan = useMemo<{ info: BlankPlanInfo | null; error: string | null }>(() => {
    try {
      return { info: io.scan.planBlank(options), error: null };
    } catch (err) {
      return { info: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [io, options]);

  useEffect(() => {
    beatsRef.current = null;
  }, [audioId, fps]);

  const toggleGuide = (g: FrameGuide) => setGuides((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const download = async () => {
    setBusy('Preparing the sheets…');
    try {
      let beats: number[] | undefined;
      if (audioId) {
        if (!beatsRef.current || beatsRef.current.id !== audioId || beatsRef.current.fps !== fps) {
          setBusy('Listening for beats…');
          beatsRef.current = { id: audioId, fps, frames: await io.scan.beatsFromAsset(audioId, fps) };
        }
        beats = beatsRef.current.frames;
      }
      const files = await io.scan.printBlank({ ...options, beats, exposureSheet: exposure || !!beats }, (f, label) => setBusy(`${label} (${Math.round(f * 100)}%)`));
      io.exporter.download(files);
      ed.toast(`${files.length} file${files.length === 1 ? '' : 's'} ready. Print at 100% / "Actual size".`, 'ok');
      ed.openDialog(null);
    } catch (err) {
      ed.toast(`Could not make the sheets: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const close = () => ed.openDialog(null);
  const summary = plan.info
    ? `${plan.info.frames} frame${plan.info.frames === 1 ? '' : 's'} · ${plan.info.columns} × ${plan.info.rows} per sheet · ${plan.info.pages} sheet${plan.info.pages === 1 ? '' : 's'} · frames ${plan.info.cellWidthMm.toFixed(0)} × ${plan.info.cellHeightMm.toFixed(0)} mm`
    : plan.error;

  return (
    <Dialog
      title="Print blank sheets"
      onClose={close}
      width={660}
      footer={
        <>
          <span className={plan.error ? 'rs-sc__bad' : 'rs-dlg__note'} style={{ marginRight: 'auto' }}>{busy ?? summary}</span>
          <button className="rs-btn" onClick={close}>Cancel</button>
          <button className="rs-btn rs-btn--primary" onClick={() => void download()} disabled={!!busy || !plan.info}>{format === 'png' ? 'Download PNG pages' : format === 'both' ? 'Download PDF and PNGs' : 'Download PDF'}</button>
        </>
      }
    >
      <p className="rs-dlg__note">Sheets with only frame boxes, the scan markers and frame numbers. Draw on them, photograph them, and the Scan tab turns them into an animation exactly like printed sheets. Print at 100% (&quot;Actual size&quot;).</p>
      <div className="rs-sc__opts">
        <SelectField large value={by} onChange={(v) => setBy(v as 'frames' | 'seconds')} options={[{ value: 'frames', label: 'Count frames' }, { value: 'seconds', label: 'Seconds × frame rate' }]} />
        {by === 'frames' ? <NumberField large label="Frames" integer min={1} max={60000} value={frames} defaultValue={48} onChange={setFrames} /> : <NumberField large label="Seconds" min={0.1} max={5000} step={0.5} value={seconds} defaultValue={4} onChange={setSeconds} />}
        <NumberField large label="Frame rate" integer min={1} max={120} value={fps} defaultValue={12} onChange={setFps} />
      </div>
      <div className="rs-sc__opts">
        <SelectField large value={aspect} onChange={setAspect} options={ASPECTS} />
        {aspect === 'custom' && (
          <>
            <NumberField large label="Width" min={0.1} max={100} step={0.1} value={customW} defaultValue={4} onChange={setCustomW} />
            <NumberField large label="Height" min={0.1} max={100} step={0.1} value={customH} defaultValue={3} onChange={setCustomH} />
          </>
        )}
        <NumberField large label="Frames per sheet" integer min={1} max={200} value={perSheet} defaultValue={6} onChange={setPerSheet} />
      </div>
      <div className="rs-sc__opts">
        <SelectField large value={paper} onChange={(v) => setPaper(v as typeof paper)} options={[{ value: 'a4', label: 'A4' }, { value: 'a3', label: 'A3' }, { value: 'letter', label: 'Letter' }, { value: 'a5', label: 'A5' }, { value: 'legal', label: 'Legal' }]} />
        <SelectField large value={orientation} onChange={(v) => setOrientation(v as 'portrait' | 'landscape')} options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
        <NumberField large label="Margin (mm)" min={5} max={40} step={0.5} value={margin} defaultValue={10} onChange={setMargin} />
        <NumberField large label="Gutter (mm)" min={3} max={20} step={0.5} value={gutter} defaultValue={5} onChange={setGutter} />
      </div>
      <div className="rs-caps">Guides inside every frame</div>
      <div className="rs-sc__opts">
        {FRAME_GUIDES.map((g) => <CheckField key={g} value={guides.includes(g)} onChange={() => toggleGuide(g)} label={GUIDE_LABEL[g]} />)}
      </div>
      <div className="rs-sc__opts">
        <CheckField value={numbers} onChange={setNumbers} label="Frame numbers above the boxes" />
        <CheckField value={ghost} onChange={setGhost} label="Faint onion-skin numbers inside" />
      </div>
      <div className="rs-caps">Timing</div>
      <div className="rs-sc__opts">
        <SelectField large value={String(shootOn)} onChange={(v) => setShootOn(Number(v))} options={[{ value: '1', label: 'Shoot on ones' }, { value: '2', label: 'Shoot on twos' }, { value: '3', label: 'Shoot on threes' }, { value: '4', label: 'Shoot on fours' }]} />
        <CheckField value={exposure} onChange={setExposure} label="Add an exposure sheet page" />
        <SelectField large value={audioId} onChange={setAudioId} options={[{ value: '', label: 'Beat marks: blank column to fill in' }, ...audio.map((a) => ({ value: a.id, label: `Beat marks from "${a.name}"` }))]} />
      </div>
      <div className="rs-sc__opts">
        <TextField large value={name} onChange={setName} placeholder="Title and file name" />
        <SelectField large value={format} onChange={(v) => setFormat(v as typeof format)} options={[{ value: 'pdf', label: 'PDF' }, { value: 'png', label: 'PNG pages' }, { value: 'both', label: 'PDF and PNG pages' }]} />
      </div>
    </Dialog>
  );
}
