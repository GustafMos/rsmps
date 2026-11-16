// Crash and hang policy for the desktop shell, kept free of Electron so the decisions can be unit-tested.
// main.mjs wires it to webContents 'unresponsive' / 'responsive' / 'render-process-gone' and app 'child-process-gone'.

/** Reasons that mean the renderer is gone (not a clean exit / kill by us). */
const FATAL_RENDERER = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit', 'killed']);

/** How many automatic reloads are allowed inside the window before the app stops reloading by itself. */
export const MAX_AUTO_RELOADS = 3;
export const AUTO_RELOAD_WINDOW_MS = 60_000;

/** `render-process-gone` details.reason -> what to do. 'clean-exit' needs nothing. */
export function onRendererGone(reason, recentReloads, now) {
  if (!FATAL_RENDERER.has(reason)) return { action: 'ignore', recentReloads };
  const recent = recentReloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS);
  if (recent.length >= MAX_AUTO_RELOADS) return { action: 'ask', recentReloads: recent, why: 'loop' };
  return { action: 'reload-safe', recentReloads: [...recent, now] };
}

/** A GPU process crash: the renderer's WebGPU device is gone too, so reload in safe mode. Other helper processes are ignored. */
export function onChildGone(type, reason) {
  if (reason === 'clean-exit') return false;
  return type === 'GPU';
}

/** The same address with `safe=1` in the query (replaces an existing `safe`). Hash and path are kept. */
export function withSafeParam(url) {
  const u = new URL(url);
  u.searchParams.set('safe', '1');
  return u.toString();
}

/** The same address without `safe`. */
export function withoutSafeParam(url) {
  const u = new URL(url);
  u.searchParams.delete('safe');
  return u.toString();
}

/** Text of the "not responding" dialog and its buttons (index 0 = Wait, 1 = safe reload). */
export const UNRESPONSIVE_DIALOG = {
  title: 'RSMPS is not responding',
  message: 'RSMPS is not responding.',
  detail: 'It may be busy with a heavy render. You can wait, or reload in safe mode: the project opens with rendering paused so you can undo the last change or open a backup. Your project is saved automatically.',
  buttons: ['Wait', 'Reload in safe mode'],
};
