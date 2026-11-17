import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenProject } from '../../io/api';
import { NEEDS_TEXT, availableTemplates, isBlankGraph, templateGraph, templateGroups, type Template } from '../../io/templates';
import { Icon } from '../components/Icon';
import { Dialog } from '../dialogs/Dialog';
import { useSelector } from '../store/createStore';
import { useApp, useEd } from '../store/context';
import { dismissStart, featureStore, openFeature } from '../store/features';
import { importSharedFile } from '../share/ShareDialogs';
import { templateThumb } from './thumbs';
import scanExample1 from '../../../docs/screenshots/scan-example-1.webp';
import scanExample2 from '../../../docs/screenshots/scan-example-2.webp';
import './start.css';

const PREF_KEY = 'rsmps.ui.startScreen';
const readPref = (): boolean => {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
};

/** Open a template in a new tab; a project that is still blank is closed afterwards so a fresh start does not leave an empty tab behind. */
export async function openTemplate(app: ReturnType<typeof useApp>, t: Template): Promise<void> {
  const { ed, io } = app;
  const before = ed.state.activeProject;
  const blank = !!before && isBlankGraph(ed.state.graph, io.registry);
  await ed.newProjectTab(templateGraph(t));
  if (blank && before && ed.state.activeProject !== before) await ed.closeTab(before).catch(() => undefined);
}

function Tile({ t, onOpen }: { t: Template; onOpen: () => void }) {
  const app = useApp();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const id = setTimeout(() => void templateThumb(app, t).then((u) => live && setSrc(u)), 400);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [app, t]);
  return (
    <button className="rs-tile" onClick={onOpen} title={t.description}>
      <div className="rs-tile__img">{src ? <img src={src} alt="" /> : <Icon name={t.needs ? 'video' : 'image'} size={28} />}</div>
      <div className="rs-tile__title">{t.title}</div>
      <div className="rs-tile__desc">{t.description}</div>
      {t.needs && <div className="rs-tile__needs">{NEEDS_TEXT[t.needs]}</div>}
    </button>
  );
}

/** Template tiles by group, with the two example scans in "Paper & scan". */
export function TemplateGallery({ onPicked }: { onPicked?: () => void }) {
  const app = useApp();
  const { ed, io } = app;
  const groups = templateGroups(availableTemplates(io.registry));
  return (
    <>
      {groups.map(({ group, items }) => (
        <section className="rs-start__group" key={group}>
          <h3 className="rs-caps">{group}</h3>
          <div className="rs-start__grid">
            {items.map((t) => (
              <Tile key={t.id} t={t} onOpen={() => { onPicked?.(); void openTemplate(app, t); }} />
            ))}
            {group === 'Paper & scan' &&
              [scanExample1, scanExample2].map((src, i) => (
                <button key={src} className="rs-tile" onClick={() => { onPicked?.(); void ed.newScanTab(); }} title="Example of an animation drawn on paper, photographed and scanned back. Click to start your own scan.">
                  <div className="rs-tile__img"><img src={src} alt={`Example scan animation ${i + 1}`} /></div>
                  <div className="rs-tile__title">Example scan {i + 1}</div>
                  <div className="rs-tile__desc">Drawn on printed sheets and photographed. Click to start your own.</div>
                </button>
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Recent() {
  const { ed, io } = useApp();
  const active = useEd((s) => s.activeProject);
  const [list, setList] = useState<{ p: OpenProject; closed: boolean }[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const open = (await io.projects.listOpen().catch(() => [])).filter((p) => p.id !== active).map((p) => ({ p, closed: false }));
      const closed = (await io.projects.listClosed().catch(() => [])).map((p) => ({ p, closed: true }));
      if (live) setList([...open, ...closed].sort((a, b) => b.p.updatedAt - a.p.updatedAt).slice(0, 6));
    })();
    return () => {
      live = false;
    };
  }, [io, active]);
  if (!list.length) return null;
  return (
    <section className="rs-start__group">
      <h3 className="rs-caps">Recent projects</h3>
      <div className="rs-start__recent">
        {list.map(({ p, closed }) => (
          <button key={p.id} className="rs-btn" onClick={() => void (closed ? ed.reopenProject(p.id) : ed.switchTo(p.id))}>
            {p.name || 'Untitled'}
          </button>
        ))}
      </div>
    </section>
  );
}

function Actions() {
  const app = useApp();
  const { ed } = app;
  return (
    <div className="rs-start__actions">
      <button className="rs-btn rs-btn--primary" onClick={() => void ed.openFileTab()}><Icon name="open" /> Open file…</button>
      <button className="rs-btn" onClick={() => void ed.newScanTab()}><Icon name="image" /> New scan</button>
      <button className="rs-btn" onClick={() => ed.openDialog('blankSheets')}><Icon name="file" /> Print blank sheets</button>
      <button className="rs-btn" onClick={() => void importSharedFile(app)}><Icon name="copy" /> Open a shared look…</button>
    </div>
  );
}

/** File > New from template…: the same gallery in a dialog. */
export function TemplatesDialog() {
  const close = () => openFeature(null);
  return (
    <Dialog title="New from template" onClose={close} width={760} footer={<button className="rs-btn" onClick={close}>Close</button>}>
      <TemplateGallery onPicked={close} />
    </Dialog>
  );
}

/**
 * The start screen: shown over the work area while the project is blank. Not a modal wall: Esc or "Start empty" dismisses it for this
 * session, and "Show this on start" turns it off for good (File > New from template… still opens the gallery).
 */
export function StartScreen() {
  const { io } = useApp();
  const blank = useEd((s) => s.mode === 'edit' && !s.switching && !!s.activeProject && isBlankGraph(s.graph, io.registry));
  const dismissed = useSelector(featureStore, (s) => s.startDismissed);
  const [show, setShow] = useState(readPref);
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => setHost(document.querySelector('.rs-center')), [blank]);
  useEffect(() => {
    if (!blank || dismissed || !show) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.rs-dlg') && dismissStart();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [blank, dismissed, show]);
  if (!blank || dismissed || !show || !host) return null;
  const setPref = (on: boolean) => {
    setShow(on);
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  };
  return createPortal(
    <div className="rs-start" role="region" aria-label="Start">
      <div className="rs-start__head">
        <h2>Start something</h2>
        <span className="rs-start__spacer" />
        <label className="rs-start__pref"><input type="checkbox" checked={show} onChange={(e) => setPref(e.target.checked)} /> Show this on start</label>
        <button className="rs-btn" onClick={dismissStart}>Start empty</button>
      </div>
      <Actions />
      <Recent />
      <TemplateGallery />
    </div>,
    host,
  );
}
