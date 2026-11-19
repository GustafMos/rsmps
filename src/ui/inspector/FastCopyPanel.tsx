import { useEffect, useRef, useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import type { FastCopyFormat, LibraryAsset } from '../../io/api';
import { DesktopClient, isDesktop } from '../../io/desktop';
import { HAP_COPY_HINT, fastCopyChoices, isFastCopy } from '../../io/hap-copy';
import { useApp } from '../store/context';

const SIZES = [
  { value: 1280, label: '720p, fastest' },
  { value: 1920, label: '1080p' },
  { value: 3840, label: 'Original size, up to 4K' },
];

/**
 * Inspector section of Media In for video clips: makes a "fast copy" (H.264, every frame a key frame) and switches the node to it.
 * The original clip stays in Media. In the desktop app, when its FFmpeg can write HAP, the copy can also be made as HAP
 * (see io/hap-copy.ts); on the web there is no such choice and the panel is as it always was.
 */
export function FastCopyPanel({ node }: { node: NodeInstance }) {
  const { io, ed } = useApp();
  const ids = (node.params.assets as string[] | undefined) ?? [];
  const infos = io.library.list({ includeHidden: true });
  const videos = ids.map((id) => infos.find((a) => a.id === id)).filter((a) => a?.kind === 'video');
  const [maxSide, setMaxSide] = useState(1280);
  const [format, setFormat] = useState<FastCopyFormat>('h264');
  const [hapEncoder, setHapEncoder] = useState(false);
  useEffect(() => {
    if (!isDesktop()) return; // the web version never asks: there is nobody to ask
    let alive = true;
    new DesktopClient()
      .hapInfo()
      .then((i) => alive && setHapEncoder(i.hap))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const formats = fastCopyChoices(isDesktop(), hapEncoder);
  const [busy, setBusy] = useState<{ done: number; total: number; fraction: number } | null>(null);
  const [note, setNote] = useState('');
  const abort = useRef<AbortController | null>(null);
  if (videos.length === 0) return null;
  const allFast = videos.every((a) => isFastCopy(a as LibraryAsset));

  const run = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setNote('');
    let next = [...ids];
    let made = 0;
    try {
      for (let i = 0; i < videos.length; i++) {
        const a = videos[i]!;
        setBusy({ done: i, total: videos.length, fraction: 0 });
        const copy = await io.library.fastCopy(a.id, { maxSide, format, signal: ac.signal, onNote: (t) => ed.toast(t, 'info'), onProgress: (f) => setBusy({ done: i, total: videos.length, fraction: f }) });
        next = next.map((id) => (id === a.id ? copy.id : id));
        made++;
      }
      ed.setParam(node.id, 'assets', next);
      ed.toast(made === 1 ? 'Fast copy made. This node now plays it; the original is still in Media.' : `${made} fast copies made. This node now plays them; the originals are still in Media.`, 'ok');
    } catch (err) {
      if (ac.signal.aborted) setNote('Canceled.');
      else setNote(err instanceof Error ? err.message : String(err));
    }
    abort.current = null;
    setBusy(null);
  };

  return (
    <div className="rs-insp__sec">
      <div className="rs-caps">Fast copy</div>
      <div className="rs-insp__actions">
        {busy ? (
          <button className="rs-btn" onClick={() => abort.current?.abort()}>
            Cancel {Math.round(((busy.done + busy.fraction) / busy.total) * 100)}%
          </button>
        ) : (
          <>
            <select className="rs-select" value={maxSide} onChange={(e) => setMaxSide(Number(e.target.value))} aria-label="Size of the fast copy">
              {SIZES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            {formats.length > 1 && (
              <select className="rs-select" value={format} onChange={(e) => setFormat(e.target.value as FastCopyFormat)} aria-label="Format of the fast copy">
                {formats.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            )}
            <button className="rs-btn" onClick={() => void run()}>{allFast ? 'Make again' : 'Make fast copy'}</button>
          </>
        )}
      </div>
      <p className="rs-insp__hint">
        {note ||
          (allFast
            ? 'This node already plays a fast copy.'
            : 'Converts the clip to the form that plays quickest here: every frame can be shown at once, so scrubbing, looping, playing backwards and time effects (Datamosh, Echo, Retime) stop stuttering. The file gets larger; the original stays in Media.')}
      </p>
      {formats.length > 1 && !busy && <p className="rs-insp__hint">{HAP_COPY_HINT}</p>}
    </div>
  );
}
