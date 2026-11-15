import { useEd, useApp } from '../store/context';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField } from '../components/fields';
import './scan.css';

/** "1 Photos / 2 Clean up & export" switch shown under the tab strip of a scan tab. */
export function ScanStepper() {
  const { ed } = useApp();
  const stage = useEd((s) => s.scanStage);
  return (
    <div className="rs-stepper" role="tablist" aria-label="Scan stage">
      <button role="tab" aria-selected={stage === 1} className={stage === 1 ? 'is-on' : ''} onClick={() => ed.setScanStage(1)}><b>1</b> Photos</button>
      <span className="rs-stepper__arrow">→</span>
      <button role="tab" aria-selected={stage === 2} className={stage === 2 ? 'is-on' : ''} onClick={() => ed.setScanStage(2)}><b>2</b> Clean up &amp; export</button>
    </div>
  );
}

const KINDS = [
  { value: 'video', label: 'Video (MP4)' },
  { value: 'image', label: 'Still image' },
  { value: 'sequence', label: 'Image sequence' },
  { value: 'spritesheet', label: 'Spritesheet' },
];

/** Two-click clean-up: edits the key params of the ready-made chain, found by the labels it was created with. */
export function ScanQuickSettings() {
  const { ed } = useApp();
  const graph = useEd((s) => s.graph);
  const find = (label: string) => graph.nodes.find((n) => n.label === label);
  const up = find('Upscale');
  const lv = find('Contrast');
  const clean = find('Clean paper');
  const out = find('Export');
  const asset = ed.scanAsset();
  const baseH = asset?.height ?? 0;
  const h = Number(up?.params.height ?? baseH);
  return (
    <div className="rs-quick" role="group" aria-label="Quick settings">
      <span className="rs-caps">Quick settings</span>
      {up && (
        <>
          <div className="rs-quick__f"><NumberField label="Output height" integer min={16} max={16000} softMax={8192} unit="px" value={h} defaultValue={baseH} onChange={(v) => ed.setParam(up.id, 'height', v)} askKey="scan-height" /></div>
          <div className="rs-quick__scales">
            {[1, 2, 3, 4].map((m) => <button key={m} className={baseH && h === baseH * m ? 'is-on' : ''} onClick={() => baseH && ed.setParam(up.id, 'height', baseH * m)} title={baseH ? `${baseH * m}px tall` : ''}>×{m}</button>)}
          </div>
        </>
      )}
      {clean && (
        <CheckField value={clean.params.output === 'ink'} onChange={(on) => ed.setParam(clean.id, 'output', on ? 'ink' : 'paper')} label="Drawing only (transparent)" />
      )}
      {lv && (
        <>
          <div className="rs-quick__f"><NumberField label="Paper white" min={0.3} max={1} step={0.01} value={Number(lv.params.inWhite ?? 1)} defaultValue={1} onChange={(v) => ed.setParam(lv.id, 'inWhite', v)} title="Lower this to turn grey paper white" /></div>
          <div className="rs-quick__f"><NumberField label="Ink black" min={0} max={0.7} step={0.01} value={Number(lv.params.inBlack ?? 0)} defaultValue={0} onChange={(v) => ed.setParam(lv.id, 'inBlack', v)} title="Raise this to make lines darker" /></div>
        </>
      )}
      <div className="rs-quick__f"><NumberField label="FPS" integer min={1} max={120} value={graph.project.fps} defaultValue={12} onChange={(v) => ed.setProject({ fps: v })} /></div>
      {out && (
        <>
          <div className="rs-quick__f rs-quick__sel"><SelectField value={String(out.params.kind ?? 'video')} options={KINDS} onChange={(v) => ed.setParam(out.id, 'kind', v)} label="Export type" /></div>
          <button className="rs-btn rs-btn--primary" onClick={() => void ed.runExport([out.id], 'current')}>Export</button>
        </>
      )}
    </div>
  );
}
