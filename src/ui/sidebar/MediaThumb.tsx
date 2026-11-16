import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { useIo } from '../store/context';
import type { MediaItem, TypeGroup } from '../lib/mediaFilter';

export const GROUP_ICON: Record<TypeGroup, IconName> = { video: 'video', image: 'image', sequence: 'grid', audio: 'audio', model3d: 'cube', lut: 'palette', subtitles: 'file', textures: 'frame', other: 'file' };

/**
 * Thumbnails already made in this session, by asset id. The library makes each one once (and keeps the promise); this only stops a
 * row that scrolls back into view from flashing its icon while it asks again. Only rows on screen ever ask (the list is virtual),
 * and the collapsed rail shows icons only.
 */
const urls = new Map<string, string>();

export function MediaThumb({ item, size }: { item: MediaItem; size: number }) {
  const io = useIo();
  const [url, setUrl] = useState<string | null>(urls.get(item.id) ?? null);
  const wantsPicture = item.kind === 'image' || item.kind === 'video';
  useEffect(() => {
    const known = urls.get(item.id);
    if (known || !wantsPicture) {
      setUrl(known ?? null);
      return;
    }
    let live = true;
    io.library
      .thumbnail(item.id)
      .then((u) => {
        if (u) urls.set(item.id, u);
        if (live) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [io, item.id, wantsPicture]);
  return (
    <div className="rs-thumb" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name={GROUP_ICON[item.group]} size={size >= 48 ? 20 : 14} />}
      {item.group === 'video' && size >= 48 && (
        <span className="rs-thumb__badge">
          <Icon name="video" size={11} />
        </span>
      )}
      {item.group === 'sequence' && size >= 48 && (
        <span className="rs-thumb__badge">
          <Icon name="grid" size={11} />
        </span>
      )}
    </div>
  );
}
