import { useEffect, useState } from 'react';
import type { AssetInfo, AssetsParam } from '../../engine/types';
import { useIo } from '../store/context';
import { Icon } from './Icon';

import type { IconName } from './Icon';

/** Icon per asset kind; a kind this table does not know yet falls back to a neutral file icon. */
const KIND_ICON: Partial<Record<AssetInfo['kind'], IconName>> = { image: 'image', video: 'video', audio: 'audio', midi: 'midi', model: 'cube', lut: 'cube', splat: 'cube' };

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
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <Icon name={KIND_ICON[asset.kind] ?? 'file'} size={20} />}
      {asset.kind === 'video' && (
        <span className="rs-thumb__badge">
          <Icon name="video" size={11} />
        </span>
      )}
    </div>
  );
}

type Accept = AssetsParam['accept'];

export function fileMatches(file: File, accept: Accept): boolean {
  const t = file.type;
  const n = file.name.toLowerCase();
  if (accept === 'any') return true;
  if (accept === 'image-video') return t.startsWith('image/') || t.startsWith('video/');
  if (accept === 'audio') return t.startsWith('audio/');
  if (accept === 'model') return /.(glb|gltf|obj)$/.test(n);
  if (accept === 'lut') return n.endsWith('.cube');
  if (accept === 'splat') return n.endsWith('.ply') || n.endsWith('.splat');
  if (accept === 'subtitles') return n.endsWith('.srt') || n.endsWith('.vtt');
  if (accept === 'midi') return n.endsWith('.mid') || n.endsWith('.midi');
  return true; // an accept kind this build does not know: let the node decide
}

export const ACCEPT_ATTR: Record<string, string> = { 'image-video': 'image/*,video/*', audio: 'audio/*', midi: '.mid,.midi', model: '.glb,.gltf,.obj', lut: '.cube', splat: '.ply,.splat', subtitles: '.srt,.vtt', any: '' };
export const ACCEPT_LABEL: Record<string, string> = { 'image-video': 'images and videos', audio: 'audio', midi: 'MIDI files', model: '3D models', lut: 'LUT files (.cube)', splat: 'Gaussian splats (.ply, .splat)', subtitles: 'subtitles (.srt, .vtt)', any: 'files' };
