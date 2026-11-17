import type { NodeInstance } from '../../engine/types';
import type { AddonInfo } from '../../io/api';
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
      extra={extra}
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
