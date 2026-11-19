import pkg from '../../../package.json';

/** The page for a new bug report, with only the app version, the browser and the GPU filled in (nothing about the project). */
export function bugReportUrl(gpu = 'unknown', userAgent: string = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent): string {
  const body = ['## What happened', '', '', '## Steps', '1. ', '', '## Expected', '', '', '---', `App: RSMPS ${pkg.version}`, `Browser: ${userAgent}`, `GPU: ${gpu}`].join('\n');
  return `https://github.com/GustafMos/rsmps/issues/new?body=${encodeURIComponent(body)}`;
}
