import { useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import { SelectField } from '../components/fields';
import { useApp } from '../store/context';

const SIZES = [
  { value: '50', label: '5 cm' },
  { value: '80', label: '8 cm' },
  { value: '100', label: '10 cm' },
  { value: '135', label: '13.5 cm (largest)' },
];
const PAPERS = [
  { value: 'a4', label: 'A4 paper' },
  { value: 'letter', label: 'Letter paper' },
];

/**
 * Inspector section of Marker Camera: how to use it in a few lines, and the buttons that give the marker to print.
 * The sheet is made in the browser (src/io/print/marker-sheet.ts), loaded only when a button is pressed.
 */
export function MarkerCameraPanel({ node }: { node: NodeInstance }) {
  const { io, ed } = useApp();
  const [size, setSize] = useState('100');
  const [paper, setPaper] = useState('a4');
  const [busy, setBusy] = useState(false);
  // the node follows "any marker" by default: marker 1 is the one to print then
  const id = node.params.marker && node.params.marker !== 'any' ? Number(node.params.marker) - 1 : 0;

  const save = async (kind: 'pdf' | 'png') => {
    setBusy(true);
    try {
      const sheet = await import('../../io/print/marker-sheet');
      const o = { id, sizeMm: Number(size), paper: paper as 'a4' | 'letter' };
      const bytes = kind === 'pdf' ? sheet.markerSheetPdf(o) : sheet.markerSheetPng(o);
      io.exporter.download([{ name: sheet.markerSheetName(o, kind), blob: new Blob([bytes as BlobPart], { type: kind === 'pdf' ? 'application/pdf' : 'image/png' }) }]);
      // the Distance output is in centimetres of the printed size: keep the two in step
      ed.setParam(node.id, 'printSize', Number(size) / 10);
    } catch (e) {
      ed.toast(`The marker could not be made: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">The marker</div>
      <div className="rs-insp__actions">
        <SelectField value={size} options={SIZES} onChange={setSize} label="Width of the black square" />
        <SelectField value={paper} options={PAPERS} onChange={setPaper} label="Paper" />
      </div>
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary" disabled={busy} onClick={() => void save('pdf')}>
          {busy ? 'Making the sheet' : `Print marker ${id + 1} (PDF)`}
        </button>
        <button className="rs-btn" disabled={busy} onClick={() => void save('png')}>
          Save as picture
        </button>
      </div>
      <p className="rs-insp__hint">
        1. Print the sheet at 100% (actual size) and lay it flat on a table or the floor. Keep the white margin; do not cut close to the black square. No printer: add an AR Marker node on a tablet or a
        second phone, view it full screen and lay that device down instead.
      </p>
      <p className="rs-insp__hint">
        2. Wire a Webcam (back camera) into Picture in, this node's Camera into a 3D Object's Camera, and merge the object over this node's Picture output. Wire the Picture into the 3D Object's Size from as
        well, so both have the same shape.
      </p>
      <p className="rs-insp__hint">
        3. Point the camera at the marker: the object stands on it. Walk round it, come closer, go further away. The scene's ground is the paper: x is the marker's right, z is where its top edge points, y
        is up. Turn on Show what is found to see the outline and the axes.
      </p>
      <p className="rs-insp__hint">
        If the object leans or slides as you move round the marker, change Field of view until it stands straight. A larger marker, good light and a steady hand give a calmer object; the marker should fill
        at least a tenth of the picture's width.
      </p>
    </div>
  );
}
