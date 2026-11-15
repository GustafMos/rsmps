import { useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '../../engine/audio/timeline';
import { useApp } from '../store/context';
import { getPeaks, type Peaks } from './peaks';

const MAX_W = 4096;

/** Min/max waveform of an audio clip (source region offset .. offset + srcLength, repeated when looping). */
export function ClipWave({ clip, pps }: { clip: TimelineClip; pps: number }) {
  const { io } = useApp();
  const cv = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const asset = clip.asset;
  useEffect(() => {
    setPeaks(null);
    if (!asset) return;
    let live = true;
    void getPeaks(io, asset).then((p) => live && setPeaks(p));
    return () => { live = false; };
  }, [io, asset]);

  const w = Math.min(MAX_W, Math.max(1, Math.round(clip.length * pps)));
  const src = Math.max(0.001, clip.loop ? (clip.srcLength ?? clip.length) : clip.length);
  useEffect(() => {
    const c = cv.current;
    if (!c || !peaks) return;
    const h = c.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * clip.length; // seconds into the clip
      const s0 = clip.offset + (t % src);
      const s1 = clip.offset + (((x + 1) / w) * clip.length % src || src);
      const a = Math.max(0, Math.floor(Math.min(s0, s1) * peaks.bps));
      const b = Math.min(peaks.min.length - 1, Math.max(a, Math.ceil(Math.max(s0, s1) * peaks.bps)));
      if (a >= peaks.min.length) continue;
      let lo = 0;
      let hi = 0;
      for (let i = a; i <= b; i++) {
        if (peaks.min[i] < lo) lo = peaks.min[i];
        if (peaks.max[i] > hi) hi = peaks.max[i];
      }
      const y0 = mid - Math.min(1, hi) * mid;
      const y1 = mid - Math.max(-1, lo) * mid;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [peaks, w, clip.length, clip.offset, src]);
  return <canvas ref={cv} className="rs-tl__wave" width={w} height={40} style={{ width: clip.length * pps }} aria-hidden="true" />;
}

/** Fade corner handles + loop handle for a clip. `onDrag` receives the pointer event and which handle was grabbed. */
export function ClipHandles({ clip, pps, onGrab }: { clip: TimelineClip; pps: number; onGrab: (e: React.PointerEvent, part: 'fadeIn' | 'fadeOut' | 'loop') => void }) {
  const w = clip.length * pps;
  const fi = Math.min(w, clip.fadeIn * pps);
  const fo = Math.min(w, clip.fadeOut * pps);
  return (
    <>
      {(fi > 0 || fo > 0) && (
        <svg className="rs-tl__fades" width={w} height="100%" viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" aria-hidden="true">
          {fi > 0 && <polygon points={`0,0 ${fi},0 0,100`} />}
          {fo > 0 && <polygon points={`${w},0 ${w - fo},0 ${w},100`} />}
        </svg>
      )}
      <span className="rs-tl__fade rs-tl__fade--l" style={{ left: fi }} title="Drag to fade in" onPointerDown={(e) => onGrab(e, 'fadeIn')} />
      <span className="rs-tl__fade rs-tl__fade--r" style={{ right: fo }} title="Drag to fade out" onPointerDown={(e) => onGrab(e, 'fadeOut')} />
      <span className={`rs-tl__loophandle${clip.loop ? ' is-on' : ''}`} title={clip.loop ? 'Looping: drag to change the length, click to turn looping off' : 'Drag right to repeat this clip, click to loop it'} onPointerDown={(e) => onGrab(e, 'loop')}>↻</span>
    </>
  );
}

