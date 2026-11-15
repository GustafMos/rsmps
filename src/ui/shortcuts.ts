import { useEffect } from 'react';
import { frameGraph } from './graph/gestures';
import { isTypingTarget } from './lib/drag';
import { useApp } from './store/context';

/** Global keyboard shortcuts. Typing in any field is never intercepted. */
export function useShortcuts(): void {
  const app = useApp();
  const { ed, io, graphCtl: ctl } = app;

  useEffect(() => {
    const mouse = { x: 0, y: 0 };
    const track = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    const panelUnderPointer = () => (document.elementFromPoint(mouse.x, mouse.y) as HTMLElement | null)?.closest<HTMLElement>('[data-panel]')?.dataset.panel;

    const keydown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('.rs-dlg')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const hoverGraph = ctl.hovering;
      const used = () => e.preventDefault();

      if (e.code === 'Space') {
        used();
        if (e.repeat) return;
        if (hoverGraph) {
          ctl.spaceDown = true;
          ctl.spaceUsed = false;
          ctl.root?.classList.add('is-space');
        } else io.player.toggle();
        return;
      }
      if (mod && k === 'z') return used(), e.shiftKey ? ed.redo() : ed.undo();
      if (mod && k === 'y') return used(), ed.redo();
      if (mod && k === 'c') return used(), ed.copy();
      if (mod && k === 'v') {
        used();
        ed.paste(hoverGraph ? ctl.toWorld(ctl.pointer.x, ctl.pointer.y) : undefined);
        return;
      }
      if (mod && k === 'd') return used(), ed.duplicate();
      if (mod && k === 'a') return used(), ed.selectAll();
      if (mod && k === 'g') {
        used();
        if (e.altKey) ed.removeFromFrame(ed.state.selection);
        else if (e.shiftKey && ed.state.selectedFrame) ed.ungroup(ed.state.selectedFrame);
        else ed.groupSelection();
        return;
      }
      if (mod && k === 'e') return used(), ed.openDialog('export');
      if (mod && k === 's') {
        used();
        io.projects.saveToFile(ed.state.graph).then(() => ed.toast('Project saved', 'ok')).catch((err) => {
          if (!(err instanceof DOMException && err.name === 'AbortError')) ed.toast(`Could not save: ${String(err)}`, 'error');
        });
        return;
      }
      if (mod && k === 'o') {
        used();
        io.projects.openFromFile().then((g) => g && ed.loadGraph(g, true)).catch((err) => ed.toast(`Could not open: ${String(err)}`, 'error'));
        return;
      }
      if (mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return used(), ed.setItem(ed.state.item + (e.key === 'ArrowRight' ? 1 : -1));
      if (mod) return;

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          used();
          ed.deleteSelection();
          return;
        case 'ArrowLeft':
          used();
          io.player.step(-1);
          return;
        case 'ArrowRight':
          used();
          io.player.step(1);
          return;
        case '`':
        case '¬': {
          used();
          const panel = panelUnderPointer();
          const cur = ed.state.prefs.maximized;
          if (cur) ed.setPrefs({ maximized: null });
          else if (panel === 'viewer' || panel === 'graph') ed.setPrefs({ maximized: panel });
          return;
        }
        case '?':
          used();
          ed.openDialog('shortcuts');
          return;
        case 'Escape':
          ed.openAddMenu(null);
          ed.openContextMenu(null);
          if (ed.state.selection.length) ed.select([]);
          return;
        case 'Home':
          used();
          frameGraph(app);
          return;
      }
      if (e.shiftKey && k === 'a') {
        used();
        const r = ctl.rect();
        const inside = hoverGraph;
        const cx = inside ? ctl.pointer.x : r.left + r.width / 2;
        const cy = inside ? ctl.pointer.y : r.top + r.height / 2;
        ed.openAddMenu({ clientX: cx, clientY: cy, world: ctl.toWorld(cx, cy) });
        return;
      }
      if (e.altKey || e.shiftKey) return;
      if (k === 'f') {
        used();
        frameGraph(app, ed.state.selection.length > 0);
      } else if (k === 'b') {
        used();
        ed.state.selection.forEach((id) => ed.toggleBypass(id));
      } else if (k === 'h') {
        used();
        if (ed.state.selection.length) ed.toggleCollapse(ed.state.selection);
      } else if (k === 'l') {
        used();
        ed.autoLayout(true);
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !ctl.spaceDown) return;
      ctl.spaceDown = false;
      ctl.root?.classList.remove('is-space');
      if (!ctl.spaceUsed && !isTypingTarget(e.target)) io.player.toggle();
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [app, ed, io, ctl]);
}
