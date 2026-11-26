/**
 * The capture screen of the stop motion mode: binds the markup in phone.html (#sm) to the logic in stopmotion.ts. Needs a real page and a
 * camera, so it holds no decisions of its own.
 */
import type { StopMotionPhone, ShotView } from './stopmotion';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createStopMotionView(sm: StopMotionPhone, hooks: { switchCamera(): void; close(): void }) {
  const root = $<HTMLElement>('sm');
  const video = $<HTMLVideoElement>('smVideo');
  const onion = $<HTMLElement>('smOnion');
  const strip = $<HTMLElement>('smStrip');
  const urls = new Map<Blob, string>();
  const url = (b: Blob): string => {
    let u = urls.get(b);
    if (!u) {
      u = URL.createObjectURL(b);
      urls.set(b, u);
    }
    return u;
  };
  /** Pictures no longer shown give their memory back. */
  const sweep = (keep: Set<Blob>) => {
    for (const [b, u] of urls) if (!keep.has(b)) (URL.revokeObjectURL(u), urls.delete(b));
  };

  const render = () => {
    const st = sm.state();
    $('smCount').textContent = `Shot ${st.count}${st.unsent ? ` · sending ${st.unsent}${st.progress !== null ? ` ${Math.round(st.progress * 100)}%` : ''}` : ''}`;
    $('smLink').textContent = st.linked ? 'Linked' : 'Linking…';
    $('smNote').textContent = st.note;
    const shutter = $<HTMLButtonElement>('smShutter');
    shutter.disabled = st.taking;
    $('smAuto').textContent = st.auto.running ? `Stop (${st.auto.count}${st.settings.stopAfter ? ` of ${st.settings.stopAfter}` : ''})` : 'Auto shoot';
    ($('smAuto') as HTMLButtonElement).classList.toggle('on', st.auto.running);
    $<HTMLButtonElement>('smUndo').disabled = st.shots.length === 0;
    $<HTMLButtonElement>('smLock').textContent = st.locked ? 'Unlock exposure and focus' : 'Lock exposure and focus';
    const set = (id: string, fn: (el: HTMLInputElement) => void) => {
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) fn(el); // never fight the finger that is typing
    };
    set('smOnionOn', (e) => (e.checked = st.settings.onion));
    set('smOnionStrength', (e) => (e.value = String(st.settings.onionStrength)));
    set('smEvery', (e) => (e.value = String(st.settings.interval)));
    set('smStopAfter', (e) => (e.value = String(st.settings.stopAfter)));
    ($('smSize') as unknown as HTMLSelectElement).value = String(st.settings.maxSide);

    const keep = new Set<Blob>();
    const layers = sm.onionLayers();
    onion.replaceChildren(
      ...layers.map((l) => {
        keep.add(l.thumb);
        const img = document.createElement('img');
        img.src = url(l.thumb);
        img.alt = '';
        img.style.opacity = String(l.opacity);
        return img;
      }),
    );
    strip.replaceChildren(
      ...st.shots.map((s: ShotView) => {
        const d = document.createElement('div');
        d.className = `smShot ${s.state}`;
        d.setAttribute('role', 'listitem');
        d.title = s.state === 'stored' ? `Shot ${s.n}: saved on the computer` : s.state === 'failed' ? `Shot ${s.n}: the computer did not accept it` : `Shot ${s.n}: on its way`;
        if (s.thumb) {
          keep.add(s.thumb);
          const img = document.createElement('img');
          img.src = url(s.thumb);
          img.alt = `Shot ${s.n}`;
          d.append(img);
        }
        if (s.state === 'stored') {
          const t = document.createElement('b');
          t.textContent = '✓';
          d.append(t);
        }
        return d;
      }),
    );
    sweep(keep);
    strip.scrollLeft = strip.scrollWidth;
  };
  sm.subscribe(render);

  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  $('smShutter').onclick = () => void sm.shoot();
  $('smUndo').onclick = () => void sm.undo();
  $('smAuto').onclick = () => sm.toggleAuto();
  $('smLock').onclick = () => void sm.toggleLock();
  $('smFlip').onclick = () => hooks.switchCamera();
  $('smBack').onclick = () => hooks.close();
  $('smOnionOn').onchange = () => sm.setSetting({ onion: $<HTMLInputElement>('smOnionOn').checked });
  $('smOnionStrength').oninput = () => sm.setSetting({ onionStrength: num('smOnionStrength') });
  $('smEvery').onchange = () => sm.setSetting({ interval: num('smEvery') });
  $('smStopAfter').onchange = () => sm.setSetting({ stopAfter: num('smStopAfter') });
  $('smSize').onchange = () => sm.setSetting({ maxSide: Number(($('smSize') as unknown as HTMLSelectElement).value) });

  return {
    show(on: boolean): void {
      root.hidden = !on;
      document.body.classList.toggle('smOpen', on);
      if (on) render();
    },
    /** The camera stream changed (camera switch): the live view follows. */
    setStream(stream: MediaStream | null): void {
      video.srcObject = stream ? new MediaStream(stream.getVideoTracks()) : null;
      void video.play().catch(() => undefined);
    },
    video,
  };
}
