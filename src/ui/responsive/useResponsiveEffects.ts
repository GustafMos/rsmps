import { useEffect, useRef } from 'react';
import { installGraphTouch } from '../graph-touch/graphTouch';
import { compactOnFirstOpen, frameLegible } from '../graph-touch/phoneGraph';
import { useApp, useEd } from '../store/context';
import { applyDeviceDefaults } from './deviceDefaults';
import { installFocusReveal, installVisualViewportVars } from './keyboardAvoid';
import { installLongPress } from './longPress';
import { installViewerTouch } from './viewerTouch';
import { dispatchShell, shellStore, showTab, useShell } from './shellStore';
import { useViewport } from './viewport';

/**
 * Everything the small-screen layout needs that is not markup, mounted once from App:
 *  - the visual-viewport CSS variables and focus reveal (sheets stay above the on-screen keyboard)
 *  - long press -> context menu / tooltip on touch (outside the graph, which has its own)
 *  - the touch layer of the node graph (tap-tap wiring, pan, double-tap focus, auto-pan)
 *  - phone defaults: lower preview scale and budgets (once, never over a user's choice)
 *  - playback stops when the tab goes to the background
 *  - on a phone: nodes start collapsed (once per project) and the graph is framed at a readable size
 */
export function useResponsiveEffects(): void {
  const app = useApp();
  const { io, ed, graphCtl: ctl } = app;
  const vp = useViewport();
  const touchy = vp.coarse || vp.cls !== 'desktop';
  const mode = useEd((s) => s.mode);
  const scanStage = useEd((s) => s.scanStage);
  const docRev = useEd((s) => s.docRev);
  const activeProject = useEd((s) => s.activeProject);
  const tab = useShell((s) => s.tab);

  useEffect(() => {
    const a = installVisualViewportVars();
    const b = installFocusReveal();
    return () => {
      a();
      b();
    };
  }, []);

  useEffect(() => (vp.coarse || vp.noHover ? installLongPress() : undefined), [vp.coarse, vp.noHover]);

  // a hidden tab renders nothing and plays nothing: stop playback so the GPU is free (the picture stays)
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && io.player.getState().playing) io.player.pause();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [io]);

  // phone and tablet defaults for the preview scale and the caches
  useEffect(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    applyDeviceDefaults(io, { deviceMemory: nav.deviceMemory, cores: nav.hardwareConcurrency, cls: vp.cls, coarse: vp.coarse });
    // once per boot: the class at start-up decides (rotating a tablet must not change budgets under the user)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io]);

  // the touch layer of the graph (the graph panel may mount later than App: wait for it)
  useEffect(() => {
    if (!touchy) return;
    let stop: (() => void) | undefined;
    let tries = 0;
    let raf = 0;
    const focusNode = (id: string) => {
      ed.select([id]);
      if (vp.cls === 'phone') showTab('inspector');
      else if (vp.cls === 'tablet') dispatchShell({ type: 'panel', side: 'right', op: 'open' });
      else ed.setPrefs({ rightOpen: true });
    };
    const attempt = () => {
      if (ctl.root) stop = installGraphTouch(app, { selectMode: () => shellStore.get().selectMode, onFocusNode: focusNode });
      else if (tries++ < 40) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      cancelAnimationFrame(raf);
      stop?.();
    };
  }, [touchy, vp.cls, app, ed, ctl, mode, scanStage]);

  // the viewer: pinch, two-finger pan, double-tap (the viewer may mount after App: wait for it)
  useEffect(() => {
    if (!touchy) return;
    let stop: (() => void) | undefined;
    let tries = 0;
    let raf = 0;
    const attempt = () => {
      const box = document.querySelector<HTMLElement>('.rs-viewer');
      if (box) stop = installViewerTouch(box);
      else if (tries++ < 40) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      cancelAnimationFrame(raf);
      stop?.();
    };
  }, [touchy, mode, scanStage]);

  // phone: compact nodes on first open, then a readable frame whenever a different document is shown
  const framed = useRef('');
  useEffect(() => {
    if (vp.cls !== 'phone' || mode === 'scan') return;
    const key = `${activeProject}:${docRev}`;
    if (framed.current === key) return;
    const t = window.setTimeout(() => {
      if (!ctl.root || ctl.root.clientWidth < 50) return; // not on screen yet: the pane switch below retries
      framed.current = key;
      compactOnFirstOpen(app);
      window.setTimeout(() => frameLegible(app), 220);
    }, 400);
    return () => window.clearTimeout(t);
  }, [vp.cls, mode, activeProject, docRev, tab, app, ctl]);
}

