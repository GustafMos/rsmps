import pkg from '../../package.json';
import { isDesktop } from '../io/desktop';
import { checkForUpdate, downloadTarget, isAllowedReleaseUrl, skipVersion, type ReleaseInfo, type UpdateResult } from '../io/updates';
import type { Editor } from './store/editor';

const STARTUP_DELAY_MS = 10_000;

function run(manual: boolean): Promise<UpdateResult> {
  return checkForUpdate({ fetch: (u, i) => fetch(u, i), storage: localStorage, now: Date.now, current: pkg.version, manual });
}

/** Opened through window.open: the desktop shell routes it to the system browser (setWindowOpenHandler in desktop/main.mjs). */
function open(url: string, store: boolean): void {
  if (store ? !/^https:\/\//.test(url) : !isAllowedReleaseUrl(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function showNotice(ed: Editor, info: ReleaseInfo): void {
  const get = downloadTarget(info);
  ed.toast(`RSMPS ${info.version} is available`, 'info', [
    { label: "What's new", run: () => open(info.url, false) },
    { label: 'Get it', run: () => open(get, get !== info.url) },
    { label: 'Skip this version', run: () => skipVersion(localStorage, info.version) },
  ]);
}

/** Desktop only: ~10 s after start, at most once per 24 h, silent on any failure. Returns a cancel function. */
export function startUpdateCheck(ed: Editor): () => void {
  if (!isDesktop() || /[?&]safe/.test(location.search)) return () => undefined;
  const t = setTimeout(() => {
    void run(false).then((r) => r.status === 'newer' && showNotice(ed, r.info)).catch(() => undefined);
  }, STARTUP_DELAY_MS);
  return () => clearTimeout(t);
}

/** File > Check for updates…: always answers. */
export async function checkNow(ed: Editor): Promise<void> {
  const r = await run(true).catch((): UpdateResult => ({ status: 'failed' }));
  if (r.status === 'newer') showNotice(ed, r.info);
  else if (r.status === 'latest') ed.toast('You have the latest version', 'ok');
  else ed.toast('Could not check', 'error');
}
