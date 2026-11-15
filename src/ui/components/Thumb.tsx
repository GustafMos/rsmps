import { useEffect, useState } from 'react';
import type { AssetInfo } from '../../engine/types';
import { useIo } from '../store/context';
import { Icon } from './Icon';

const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', midi: 'midi' } as const;

/** Library thumbnail with a kind icon fallback (audio/midi have no picture). */
export function Thumb({ asset, size = 56 }: { asset: AssetInfo | undefined; size?: number }) {
  const io = useIo();
  const [url, setUrl] = useState<string | null>(null);
  const id = asset?.id;
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (id && (asset?.kind === 'image' || asset?.kind === 'video')) {
      io.library
        .thumbnail(id)
        .then((u) => live && setUrl(u))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [io, id, asset?.kind]);
  if (!asset) {
    return (
      <div className="rs-thumb rs-thumb--missing" style={{ width: size, height: size }} title="Missing file">
        <Icon name="warn" />
      </div>
    );
  }
  return (
    <div className="rs-thumb" style={{ width: size, height: size }} title={asset.name}>
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <Icon name={KIND_ICON[asset.kind]} size={20} />}
      {asset.kind === 'video' && (
        <span className="rs-thumb__badge">
          <Icon name="video" size={11} />
        </span>
      )}
    </div>
  );
}

export function fileMatches(file: File, accept: 'image-video' | 'audio' | 'midi' | 'any'): boolean {
  const t = file.type;
  const n = file.name.toLowerCase();
  if (accept === 'any') return true;
  if (accept === 'image-video') return t.startsWith('image/') || t.startsWith('video/');
  if (accept === 'audio') return t.startsWith('audio/');
  return n.endsWith('.mid') || n.endsWith('.midi');
}

export const ACCEPT_ATTR = { 'image-video': 'image/*,video/*', audio: 'audio/*', midi: '.mid,.midi', any: '' } as const;
