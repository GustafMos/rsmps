import type { NodeInstance } from '../../engine/types';
import type { AddonInfo } from '../../io/api';
import { isScanData, normalizeScan } from '../../engine/lib/scan-data';
import { useAddons } from '../dialogs/AddonsSection';
import { useApp } from '../store/context';
import { ProcessPanel } from './ProcessPanel';

/** Which of the Splat from Video add-ons are missing ([] when COLMAP (either build) and Brush are installed). */
export function missingSplatAddons(list: AddonInfo[] | null): string[] {
  if (!list) return [];
  const ok = (id: string) => list.some((a) => a.id === id && a.state === 'installed');
  return [...(ok('colmap') || ok('colmap-cuda') ? [] : ['COLMAP']), ...(ok('brush') ? [] : ['Brush'])];
}

/**
 * Splat from Video's inspector section: the generic process panel plus which add-ons are missing (with a button to the add-ons list;
 * nothing is ever downloaded from here) and what the last run reported.
 */
export function SplatTrainPanel({ node }: { node: NodeInstance }) {
  const { io, ed } = useApp();
  const list = useAddons(io);
  const missing = io.addons.supported ? missingSplatAddons(list) : [];
  const chosen = isScanData(node.params.scan) ? normalizeScan(node.params.scan) : null;
  const scans = ed.state.graph.nodes.filter((n) => n.type === 'scan-3d' && isScanData(n.params.scan) && normalizeScan(n.params.scan).shots.length >= 3);
  // the scan is copied into this node (without its depth maps, which Splat from Video does not use): the photos stay in Media
  const useScan = (n: NodeInstance) => ed.setParam(node.id, 'scan', { ...normalizeScan(n.params.scan), shots: normalizeScan(n.params.scan).shots.map(({ depth: _depth, ...s }) => s) });
  const scanPick = (
    <div className="rs-insp__sec">
      <div className="rs-caps">From a 3D Scan (experimental)</div>
      {chosen ? (
        <>
          <p className="rs-insp__hint" role="status">Using a 3D Scan of {chosen.shots.length} photos with the camera positions the phone saved. COLMAP only matches the photos and places points; it does not solve the cameras (if the positions do not fit the photos it solves them from the pictures instead, and says so). Photos and Clip are ignored.</p>
          <button className="rs-btn" onClick={() => ed.setParam(node.id, 'scan', null)}>Stop using the scan</button>
        </>
      ) : scans.length ? (
        <>
          <p className="rs-insp__hint">Use the photos of a 3D Scan node in this project, together with where the phone was for each one:</p>
          <div className="rs-insp__actions">
            {scans.map((n) => (
              <button key={n.id} className="rs-btn" onClick={() => useScan(n)}>
                Use {n.label || '3D Scan'} ({normalizeScan(n.params.scan).shots.length} photos)
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="rs-insp__hint">No 3D Scan with photos in this project yet. Take one on the phone, save it with Save scan for a computer, and open it here with Load scan file on a 3D Scan node.</p>
      )}
    </div>
  );
  const extra = missing.length ? (
    <div className="rs-insp__req" role="note">
      <p>
        Missing add-on{missing.length > 1 ? 's' : ''}: <strong>{missing.join(' and ')}</strong>. They are separate programs that run on your computer; install them under Plugins &gt; Official add-ons (nothing is downloaded until you press Install there).
      </p>
      <button className="rs-btn" onClick={() => ed.openDialog('plugins')}>Open add-ons…</button>
    </div>
  ) : null;
  return (
    <ProcessPanel
      node={node}
      extra={<>{scanPick}{extra}</>}
      runLabel="Reconstruct"
      rerunLabel="Reconstruct again"
      facts={(st) => {
        const m = st.result?.meta ?? {};
        return typeof m.registered === 'number' ? `${m.registered} of ${m.frames} frames placed · ${Number(m.splats).toLocaleString('en-US')} splats` : null;
      }}
      hint="Picks frames from the clip, finds the camera with COLMAP and trains the splats with Brush, all on this computer (minutes; Draft is quickest). Works best on a sharp, steady walk around a still, textured subject: see docs/SPLATS.md."
    />
  );
}
