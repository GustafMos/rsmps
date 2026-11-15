import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField, TextField } from '../components/fields';
import { useApp, useEd } from '../store/context';
import './inspector.css';

const SIZES = [
  { value: '1920x1080', label: '1920 × 1080 (HD)' },
  { value: '1080x1920', label: '1080 × 1920 (vertical)' },
  { value: '1080x1080', label: '1080 × 1080 (square)' },
  { value: '3840x2160', label: '3840 × 2160 (4K)' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '640x360', label: '640 × 360' },
  { value: '320x180', label: '320 × 180' },
  { value: 'custom', label: 'Custom' },
];

export function ProjectSettingsPanel() {
  const { ed } = useApp();
  const p = useEd((s) => s.graph.project);
  const name = useEd((s) => s.graph.name);
  const sizeKey = `${p.width}x${p.height}`;
  return (
    <div className="rs-insp__scroll">
      <div className="rs-insp__sec">
        <div className="rs-caps">Project</div>
        <TextField large value={name} onChange={(v) => ed.setName(v)} placeholder="Untitled" />
      </div>
      <div className="rs-insp__sec">
        <div className="rs-caps">Canvas</div>
        <div className="rs-insp__row"><label className="rs-insp__label">Size preset</label>
          <div className="rs-insp__ctl rs-insp__nowrap"><SelectField large value={SIZES.some((s) => s.value === sizeKey) ? sizeKey : 'custom'} options={SIZES} onChange={(v) => { const m = /^(\d+)x(\d+)$/.exec(v); if (m) ed.setProject({ width: +m[1], height: +m[2] }); }} />
            <button className="rs-btn" onClick={() => ed.setProject({ width: p.height, height: p.width })} title="Swap width and height (landscape ⇄ portrait)"><Icon name="swap" size={14} /> Swap</button></div></div>
        <div className="rs-insp__row"><label className="rs-insp__label">Width</label>
          <div className="rs-insp__ctl"><NumberField large value={p.width} min={1} max={16384} integer unit="px" defaultValue={1920} onChange={(v) => ed.setProject({ width: v })} /></div></div>
        <div className="rs-insp__row"><label className="rs-insp__label">Height</label>
          <div className="rs-insp__ctl"><NumberField large value={p.height} min={1} max={16384} integer unit="px" defaultValue={1080} onChange={(v) => ed.setProject({ height: v })} /></div></div>
        <p className="rs-insp__hint">The project canvas is the default frame for every output; each Output node can override it in its own Frame settings.</p>
      </div>
      <div className="rs-insp__sec">
        <div className="rs-caps">Time</div>
        <div className="rs-insp__row"><label className="rs-insp__label">Frame rate</label>
          <div className="rs-insp__ctl"><NumberField large value={p.fps} min={1} max={120} integer unit="hz" defaultValue={24} onChange={(v) => ed.setProject({ fps: v })} /></div></div>
        <div className="rs-insp__row"><label className="rs-insp__label">Duration</label>
          <div className="rs-insp__ctl"><NumberField large value={p.duration} min={0.1} max={600} step={0.1} unit="s" defaultValue={4} onChange={(v) => ed.setProject({ duration: v })} /></div></div>
        <div className="rs-insp__row"><label className="rs-insp__label">Loop</label>
          <div className="rs-insp__ctl"><CheckField value={p.loop} onChange={(v) => ed.setProject({ loop: v })} label={p.loop ? 'Seamless loop' : 'Off'} /></div></div>
        <p className="rs-insp__hint">When on, every animated node repeats exactly over the duration, so the last frame flows into the first.</p>
      </div>
      <div className="rs-insp__sec">
        <div className="rs-caps">Length units</div>
        <div className="rs-insp__row"><label className="rs-insp__label">Mode</label>
          <div className="rs-insp__ctl"><SelectField large value={p.lengthMode} options={[{ value: 'relative', label: 'Relative to image' }, { value: 'absolute', label: 'Absolute pixels' }]} onChange={(v) => ed.setProject({ lengthMode: v as 'relative' | 'absolute' })} /></div></div>
        {p.lengthMode === 'relative' && (
          <div className="rs-insp__row"><label className="rs-insp__label">Reference</label>
            <div className="rs-insp__ctl"><NumberField large value={p.referenceSide} min={16} max={16384} integer unit="px" defaultValue={1080} onChange={(v) => ed.setProject({ referenceSide: v })} /></div></div>
        )}
        <p className="rs-insp__hint">
          {p.lengthMode === 'relative'
            ? `Relative: a blur of 10px means 10px on an image ${p.referenceSide}px tall and scales with other sizes, so mixed-resolution batches look the same.`
            : 'Absolute: 1px is always exactly one texel of the image, which suits native pixel-art work.'}
        </p>
      </div>
    </div>
  );
}
