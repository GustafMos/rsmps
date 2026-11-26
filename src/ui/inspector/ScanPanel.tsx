import { useEffect, useMemo, useRef, useState } from 'react';
import { COVERAGE_MEANING, coverageOf, qualitySummary } from '../../engine/lib/scan-coverage';
import { isScanData, normalizeScan } from '../../engine/lib/scan-data';
import type { NodeInstance } from '../../engine/types';
import { scanBlockedReason, type WorldArSupport } from '../../io/world-ar/support';
import { useApp } from '../store/context';
import { loadScanFiles, saveScanZip, type SaveProgress } from '../store/scanFiles';
import { phoneLinkBlockedReason } from '../store/scan3dLink';
import { openScan } from '../store/worldArScan';
import { CoverageMap } from './CoverageMap';
import { Scan3dLinkPanel } from './Scan3dLinkPanel';
import { WORLD_AR_BETA } from './WorldArPanel';

/** Inspector section of the 3D Scan node: start a scan in the AR view, and what the scan holds and how good it is. */
export function ScanPanel({ node }: { node: NodeInstance }) {
  const app = useApp();
  const { io, ed } = app;
  const [support, setSupport] = useState<WorldArSupport>({ state: 'checking', message: 'Checking whether this device can do AR.' });
  useEffect(() => {
    let live = true;
    void io.worldAr?.support().then((s) => live && setSupport(s));
    if (!io.worldAr) setSupport({ state: 'unsupported', message: 'The AR view is not available in this version of the app.' });
    return () => {
      live = false;
    };
  }, [io]);
  const scan = useMemo(() => normalizeScan(node.params.scan), [node.params.scan]);
  const has = isScanData(node.params.scan) && scan.shots.length > 0;
  const report = useMemo(() => coverageOf(scan), [scan]);
  const quality = useMemo(() => qualitySummary(scan), [scan]);
  const blocked = scanBlockedReason(support);
  const depthShots = scan.shots.filter((s) => s.depth).length;
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const save = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setSaving({ fraction: 0, note: 'Starting' });
    await saveScanZip(app, scan, node.label || '3d-scan', setSaving, ac.signal);
    abort.current = null;
    setSaving(null);
  };
  const load = async (files: File[]) => {
    if (!files.length) return;
    if (has && !(await ed.ask({ title: 'Replace this scan?', text: `This node holds a scan of ${scan.shots.length} photos. Loading a file replaces it (Undo brings it back). The photos stay in Media.`, ok: 'Load scan file', cancel: 'Keep it' }))) return;
    await loadScanFiles(app, node.id, files);
  };
  const start = async () => {
    // asked first, then the AR view opens from the OK press (which counts as the press the browser wants)
    if (has && !(await ed.ask({ title: 'Start a new scan?', text: `This node holds a scan of ${scan.shots.length} photos. A new scan replaces it (Undo brings it back). The photos stay in Media. The phone cannot find again where an earlier scan stood, so a scan cannot be continued.`, ok: 'Start new scan', cancel: 'Keep it' }))) return;
    openScan(app, node.id);
  };
  const [linkOpen, setLinkOpen] = useState(false);
  const linkBlocked = phoneLinkBlockedReason(io);
  const startLinked = async () => {
    if (has && !(await ed.ask({ title: 'Start a new scan?', text: `This node holds a scan of ${scan.shots.length} photos. A scan from the linked phone replaces it when it is finished (Undo brings it back). The photos stay in Media.`, ok: 'Scan with the phone', cancel: 'Keep it' }))) return;
    setLinkOpen(true);
  };
  const clear = async () => {
    if (!has) return;
    if (await ed.ask({ title: 'Clear this scan?', text: `Removes the scan of ${scan.shots.length} photos from this node. The photos stay in Media, and Undo brings the scan back.`, ok: 'Clear scan', cancel: 'Keep it' })) ed.setParam(node.id, 'scan', null);
  };
  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">3D Scan</div>
      <p className="rs-insp__hint" role="note">{WORLD_AR_BETA}</p>
      <p className="rs-insp__hint" role="status">{support.message}</p>
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={!!blocked || support.state === 'checking'} title={blocked ?? 'Opens the camera full-screen. The browser asks for the camera first. Nothing leaves this device.'} onClick={() => void start()}>
          Start scan
        </button>
        <button className="rs-btn" disabled={!!linkBlocked || linkOpen} title={linkBlocked ?? 'Scan with a phone that is linked to this computer over the same network: the photos arrive here as they are taken. No zip, no cable.'} onClick={() => void startLinked()}>
          Scan with a linked phone
        </button>
        <button className="rs-btn rs-btn--danger" disabled={!has} title={has ? 'Remove the scan from this node (the photos stay in Media)' : 'There is no scan to clear'} onClick={() => void clear()}>
          Clear
        </button>
      </div>
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={!has || !!saving} title={has ? 'Downloads one zip file with the photos and where the phone was for each, ready for COLMAP, nerfstudio, Brush and similar tools on a computer. Nothing leaves this device.' : 'There is no scan to save'} onClick={() => void save()}>
          Save scan for a computer
        </button>
        {saving && (
          <button className="rs-btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
        <button className="rs-btn" disabled={!!saving} title="Open a scan zip saved on another device (or its scan.json with the numbered photos). The photos are added to Media." onClick={() => picker.current?.click()}>
          Load scan file
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept=".zip,.json,.jpg,.jpeg,.png,application/zip,application/json,image/jpeg,image/png"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void load(files);
          }}
        />
      </div>
      {saving && <progress max={1} value={saving.fraction} aria-label="Saving the scan" style={{ width: '100%' }} />}
      {saving && <p className="rs-insp__hint" role="status">{saving.note} ({Math.round(saving.fraction * 100)}%)</p>}
      <p className="rs-insp__hint">Save scan for a computer: one zip with the photos and the phone's positions, to open with COLMAP, a splat trainer, or the desktop app's Splat from Video. Load scan file does the opposite: pick that zip on any device.</p>
      {blocked && <p className="rs-insp__hint" role="status">Start scan is off here: {blocked}</p>}
      {linkBlocked && <p className="rs-insp__hint" role="status">Scan with a linked phone is off here: {linkBlocked}</p>}
      {linkOpen && <Scan3dLinkPanel nodeId={node.id} onClose={() => setLinkOpen(false)} />}
      <p className="rs-insp__hint">In the AR view: aim at the surface next to the object and tap, make the dome fit the object (pinch, or the Size strip), lift its middle (Height strip), press Start, then walk slowly round it. Photos are taken by themselves; the picture, the map and one line of advice show what is still missing.</p>
      {has ? (
        <>
          <div className="rs-caps">This scan</div>
          <p className="rs-insp__hint" role="status">
            {scan.shots.length} photos · coverage {Math.round(report.fraction * 100)}%
            {quality.rejected ? ` · ${quality.rejected} left out for being blurry` : ''}
            {quality.medianDistance ? ` · median distance ${quality.medianDistance.toFixed(1)} m` : ''}
          </p>
          <CoverageMap grid={report.grid} counts={report.counts} reachable={report.reachable} />
          <p className="rs-insp__hint">Across: all the way round the object. Up: from low to the top. Red: no photo from there yet. Green: covered. Grey: cannot be reached. {COVERAGE_MEANING}</p>
          <p className="rs-insp__hint" role="status"><b>{quality.verdict.text}.</b> {quality.notes.join(' ')}</p>
          <p className="rs-insp__hint">{depthShots ? `Depth: ${depthShots} of ${scan.shots.length} photos came with a depth map.` : 'Depth: this phone gave no depth information in the AR view.'}</p>
        </>
      ) : (
        <p className="rs-insp__hint">No scan yet. A scan needs at least 40 photos, neighbouring photos not more than about 15 degrees apart, and at least two heights.</p>
      )}
      <p className="rs-insp__hint">Continue scan is not possible: after the AR view closes the phone cannot find again where the object stood, so photos from two sessions cannot be put together. Start scan always starts a new scan (and asks before replacing this one).</p>
    </div>
  );
}
