import { useEffect, useState } from 'react';
import { useApp } from '../store/context';

type Preset = Awaited<ReturnType<ReturnType<typeof useApp>['io']['projects']['listPresets']>>[number];

/** Presets, best-known first (built-in ones). Loaded once; empty until then. */
export function usePresetList(): Preset[] {
  const { io } = useApp();
  const [list, setList] = useState<Preset[]>([]);
  useEffect(() => {
    let live = true;
    io.projects.listPresets().then((l) => live && setList(l)).catch(() => undefined);
    return () => { live = false; };
  }, [io]);
  return list;
}

/** Open a preset as a NEW project tab (never over the current project). */
export async function openPresetInNewTab(app: ReturnType<typeof useApp>, id: string, name: string): Promise<void> {
  const g = await app.io.projects.loadPreset(id);
  if (!g) return app.ed.toast('Could not load that preset.', 'error');
  await app.ed.newProjectTab({ ...g, name: g.name && g.name !== 'Untitled' ? g.name : name });
}

/** "Start from a preset": a few buttons, each opens a new tab. */
export function PresetRow({ count = 4 }: { count?: number }) {
  const app = useApp();
  const list = usePresetList().filter((p) => p.builtin).slice(0, count);
  if (!list.length) return null;
  return (
    <div className="rs-presetrow" data-nodrag onPointerDown={(e) => e.stopPropagation()}>
      <span className="rs-caps">Start from a preset</span>
      <div className="rs-presetrow__btns">
        {list.map((p) => <button key={p.id} className="rs-btn" onClick={() => void openPresetInNewTab(app, p.id, p.name)}>{p.name}</button>)}
        <button className="rs-btn rs-btn--ghost" onClick={() => app.ed.openDialog('presets')}>More…</button>
      </div>
    </div>
  );
}
