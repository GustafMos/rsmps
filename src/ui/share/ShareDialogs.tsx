import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Dialog } from '../dialogs/Dialog';
import { SHARE_FILE_EXT, SHARE_LIMITS, ShareError, encodeShareLink, parseShareText, shareFileText, shareSummary, withoutShareHash } from '../../io/share';
import { useApp } from '../store/context';
import { featureStore, openFeature, setIncoming } from '../store/features';
import { useSelector } from '../store/createStore';
import './share.css';

/** The public web version: links made in the desktop app open there (no custom protocol is registered). */
export const WEB_APP_URL = 'https://gustafmos.github.io/rsmps/';

function baseUrl(): string {
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin + location.pathname;
  } catch {
    /* ignore */
  }
  return WEB_APP_URL;
}

function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return (name || 'look').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'look';
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.rsmps.json,application/json';
    input.style.display = 'none';
    const done = (f: File | null) => {
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Import a shared `.rsmps.json` (or any project file) through the same confirmation as a link. Never replaces the current work. */
export async function importSharedFile(app: ReturnType<typeof useApp>): Promise<void> {
  const file = await pickFile();
  if (!file) return;
  try {
    if (file.size > SHARE_LIMITS.maxJsonChars) throw new ShareError(`"${file.name}" is too large to import as a shared look.`, 'too-large');
    const { graph, report } = parseShareText(await file.text(), app.io.registry);
    setIncoming({ graph, report, source: 'file' });
  } catch (err) {
    setIncoming({ source: 'file', error: err instanceof Error ? err.message : String(err) });
  }
}

/** File > Share…: the current graph without media, as a file or a link. */
export function ShareDialog() {
  const app = useApp();
  const { ed, io } = app;
  const close = () => openFeature(null);
  const [copied, setCopied] = useState(false);
  const assetInfo = useMemo(() => {
    const lib = new Map(io.library.list().map((a) => [a.id, a]));
    return (id: string) => {
      const a = lib.get(id);
      return a ? { name: a.name, kind: a.kind } : undefined;
    };
  }, [io]);
  const graph = ed.state.graph;
  const link = useMemo(() => {
    try {
      return { ok: encodeShareLink(graph, io.registry, { assetInfo }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [graph, io, assetInfo]);
  const report = link.ok?.report;

  const saveFile = () => {
    try {
      const { text } = shareFileText(graph, io.registry, { assetInfo });
      downloadText(`${safeName(graph.name)}${SHARE_FILE_EXT}`, text);
      ed.toast('Saved a copy without your media.', 'ok');
    } catch (err) {
      ed.toast(`Could not share: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };
  const copyLink = async () => {
    if (!link.ok || link.ok.size === 'too-large') return;
    try {
      await navigator.clipboard.writeText(baseUrl() + link.ok.fragment);
      setCopied(true);
      ed.toast(link.ok.size === 'warn' ? 'Link copied. It is long: some apps cut long links, so a file is safer.' : 'Link copied. It holds the whole look; nothing is uploaded.', 'ok');
    } catch {
      ed.toast('The clipboard is not available here. Save the file instead.', 'error');
    }
  };

  return (
    <Dialog title="Share this look" onClose={close} width={460} footer={<button className="rs-btn" onClick={close}>Close</button>}>
      <div className="rs-share">
        <p>
          Shares the nodes and settings, <strong>without your media</strong>. Whoever opens it gets a new tab with empty media slots to drop their own pictures into.
        </p>
        {report && (
          <ul className="rs-share__facts">
            <li>{shareSummary(report, (t) => io.registry.get(t)?.title ?? t)}</li>
            {report.placeholders.length > 0 && <li>{report.placeholders.length} media slot{report.placeholders.length === 1 ? '' : 's'} will be emptied.</li>}
            {report.hasShader && <li>Contains a custom shader (it runs on the GPU only; it cannot run scripts).</li>}
            {report.needsPlugins.length > 0 && <li>Needs plugin: {report.needsPlugins.join(', ')}</li>}
            {report.dropped.map((d) => <li key={d}>{d}</li>)}
          </ul>
        )}
        {link.error && <p className="rs-share__warn" role="alert">{link.error}</p>}
        <div className="rs-share__btns">
          <button className="rs-btn rs-btn--primary" onClick={saveFile}><Icon name="save" /> Save file ({SHARE_FILE_EXT})</button>
          <button className="rs-btn" disabled={!link.ok || link.ok.size === 'too-large'} onClick={() => void copyLink()}>
            <Icon name="copy" /> {copied ? 'Copied' : 'Copy link'}
          </button>
          <button className="rs-btn" onClick={() => void importSharedFile(app)}><Icon name="open" /> Open a shared file…</button>
        </div>
        {link.ok && (
          <p className={`rs-share__size${link.ok.size !== 'ok' ? ' is-warn' : ''}`}>
            {link.ok.size === 'too-large'
              ? `This look is too large for a link (${(link.ok.chars / 1000).toFixed(1)} kB; the limit is ${SHARE_LIMITS.maxFragmentChars / 1000} kB). Save the file instead.`
              : link.ok.size === 'warn'
                ? `The link is ${(link.ok.chars / 1000).toFixed(1)} kB long. Some chat apps cut long links; a file is safer.`
                : `The link is ${(link.ok.chars / 1000).toFixed(1)} kB. The look sits after the # in the address, which is never sent to a server.`}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "Open shared graph?": shown for a `#g=` link or a shared file; opens a NEW tab, never replaces the current work. */
export function IncomingShareDialog() {
  const app = useApp();
  const { ed, io } = app;
  const incoming = useSelector(featureStore, (s) => s.incoming);
  if (!incoming) return null;
  const done = () => {
    setIncoming(null);
    try {
      if (incoming.source === 'link') history.replaceState(null, '', withoutShareHash(location.href));
    } catch {
      /* ignore */
    }
  };
  if (incoming.error || !incoming.graph || !incoming.report) {
    return (
      <Dialog title="Cannot open this" onClose={done} width={440} footer={<button className="rs-btn rs-btn--primary" onClick={done}>OK</button>}>
        <p className="rs-share__warn" role="alert">{incoming.error ?? 'The shared data is empty.'}</p>
        <p>Nothing was opened and nothing was changed.</p>
      </Dialog>
    );
  }
  const { graph, report } = incoming;
  const title = (t: string) => io.registry.get(t)?.title ?? t;
  return (
    <Dialog
      title="Open shared graph?"
      onClose={done}
      width={460}
      footer={
        <>
          <button className="rs-btn" onClick={done}>Cancel</button>
          <button className="rs-btn rs-btn--primary" onClick={() => { done(); void ed.newProjectTab(graph); }}>Open in a new tab</button>
        </>
      }
    >
      <div className="rs-share">
        <p><strong>{graph.name}</strong> comes from {incoming.source === 'link' ? 'a link' : 'a file'}. It is only data: opening it runs nothing, and it opens in a new tab, next to your work.</p>
        <ul className="rs-share__facts">
          <li>{shareSummary(report, title)}</li>
          {report.hasShader && <li>Contains a custom shader. It compiles on the GPU and cannot run scripts.</li>}
          {report.needsPlugins.length > 0 && <li>Needs plugin: {report.needsPlugins.join(', ')} (not installed automatically; those nodes stay empty)</li>}
          {report.placeholders.length > 0 && <li>Has {report.placeholders.length} empty media slot{report.placeholders.length === 1 ? '' : 's'}: drop your own pictures or clips there.</li>}
          {report.dropped.map((d) => <li key={d}>Removed: {d}</li>)}
        </ul>
      </div>
    </Dialog>
  );
}
