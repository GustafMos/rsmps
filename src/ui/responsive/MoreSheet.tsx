import { useEffect, useState, type ReactNode } from 'react';
import pkg from '../../../package.json';
import { Icon, type IconName } from '../components/Icon';
import { isDesktop } from '../../io/desktop';
import { reloadInSafeMode } from '../safety';
import { useApp } from '../store/context';
import { ProjectTabs } from '../topbar/ProjectTabs';
import { checkNow } from '../updateNotice';
import { showTab } from './shellStore';
import { copyText, perfStore, performanceReport, setPerfPanel } from '../viewer/PerfOverlay';
import { useSelector } from '../store/createStore';

function Row({ icon, label, hint, onClick, href }: { icon: IconName; label: string; hint?: string; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <Icon name={icon} size={20} />
      <span className="rs-more__lbl">{label}</span>
      {hint && <span className="rs-more__hint">{hint}</span>}
      <Icon name="chevronRight" size={14} />
    </>
  );
  return href ? (
    <a className="rs-more__row" href={href} target="_blank" rel="noopener noreferrer">{body}</a>
  ) : (
    <button className="rs-more__row" onClick={onClick}>{body}</button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rs-more__group">
      <div className="rs-caps rs-more__title">{title}</div>
      <div className="rs-more__rows">{children}</div>
    </section>
  );
}

/** The "More" tab: everything the desktop File menu, top bar links and help offer, as a list of thumb-sized rows. */
export function MoreSheet() {
  const app = useApp();
  const { io, ed } = app;
  const [gpu, setGpu] = useState('unknown');
  useEffect(() => {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } };
    nav.gpu?.requestAdapter().then((a) => {
      const i = a?.info;
      if (i) setGpu([i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'WebGPU (no description)');
    }).catch(() => undefined);
  }, []);
  const bugBody = ['## What happened', '', '', '## Steps', '1. ', '', '## Expected', '', '', '---', `App: RSMPS ${pkg.version}`, `Browser: ${navigator.userAgent}`, `GPU: ${gpu}`].join('\n');
  const bugUrl = `https://github.com/GustafMos/rsmps/issues/new?body=${encodeURIComponent(bugBody)}`;
  const perfOn = useSelector(perfStore, (st) => st.on);
  const mem = io.memory();
  const mb = Math.round((mem.engineCacheBytes + mem.gpuPoolBytes + mem.frameCacheBytes + mem.decodedMediaBytes) / 1048576);

  return (
    <div className="rs-more" data-pane-scroll>
      <Group title="Projects">
        <div className="rs-more__tabs"><ProjectTabs /></div>
        <Row icon="plus" label="New project (new tab)" onClick={() => void ed.newProjectTab()} />
        <Row icon="image" label="New scan (photos of printed sheets)" onClick={() => void ed.newScanTab()} />
        <Row icon="open" label="Open file in a new tab…" onClick={() => ed.openFileTab()} />
        <Row icon="save" label="Save…" onClick={() => ed.saveFile()} />
      </Group>
      <Group title="Export">
        <Row icon="export" label="Export…" hint="formats and options" onClick={() => ed.openDialog('export')} />
      </Group>
      <Group title="Project">
        <Row icon="menu" label="Project settings" onClick={() => { ed.select([]); showTab('inspector'); }} />
        <Row icon="stack" label="Presets…" onClick={() => ed.openDialog('presets')} />
        <Row icon="save" label="Save as preset…" onClick={() => ed.openDialog('savePreset')} />
        <Row icon="open" label="Backups…" onClick={() => ed.openDialog('backups')} />
        <Row icon="file" label="Print blank sheets…" onClick={() => ed.openDialog('blankSheets')} />
      </Group>
      <Group title="Tools">
        <Row icon="palette" label="Palette Studio…" onClick={() => { ed.studioTarget = null; ed.openDialog('palette'); }} />
        <Row icon="puzzle" label="Plugins…" onClick={() => ed.openDialog('plugins')} />
      </Group>
      <Group title="Help">
        <Row icon="help" label="Keyboard shortcuts" hint="for a connected keyboard" onClick={() => ed.openDialog('shortcuts')} />
        <Row icon="keyboard" label="Customize shortcuts…" onClick={() => ed.openDialog('keymap')} />
        <Row icon="help" label="About RSMPS…" onClick={() => ed.openDialog('about')} />
        <Row icon="bug" label="Report a bug" href={bugUrl} />
        <Row icon="coffee" label="Support" href="https://ko-fi.com/ripscorpy" />
        {isDesktop() && <Row icon="check" label="Check for updates…" onClick={() => void checkNow(ed)} />}
      </Group>
      <Group title="Performance">
        <Row
          icon="check"
          label={perfOn ? 'Performance readout: on (tap to turn off)' : 'Performance readout: off (tap to turn on)'}
          hint="shows on the Viewer while it plays"
          onClick={() => {
            setPerfPanel(io, !perfOn);
            if (!perfOn) ed.toast('Performance readout is on. Open the Viewer, press play, and the numbers appear over the picture.', 'ok');
          }}
        />
        {perfOn && (
          <Row
            icon="copy"
            label="Copy performance report"
            hint="after playing your clip"
            onClick={() => {
              const snap = io.player.perfSnapshot();
              if (!snap) return;
              void copyText(performanceReport(app, snap)).then((ok) =>
                ed.toast(ok ? 'The performance report was copied. Paste it into a message.' : 'Your browser did not allow copying. Open the Viewer and use the Copy performance report button there.', ok ? 'ok' : 'error'),
              );
            }}
          />
        )}
      </Group>
      <Group title="Safety">
        <Row icon="warn" label="Reload in safe mode (rendering paused)" onClick={() => reloadInSafeMode(app)} />
        <Row
          icon="copy"
          label="Copy graph for bug report"
          onClick={() =>
            navigator.clipboard.writeText(JSON.stringify(ed.state.graph, null, 1)).then(
              () => ed.toast('Graph copied. Paste it into the bug report yourself if you are happy to share it.', 'ok'),
              () => ed.toast('Clipboard is not available here.', 'error'),
            )
          }
        />
      </Group>
      <p className="rs-more__foot rs-num">RSMPS {pkg.version} · memory in use {mb} MB (this tab only)</p>
    </div>
  );
}
