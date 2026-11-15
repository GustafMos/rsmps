// npm run desktop:smoke: runs the packaged (unpacked) app once with --smoke-test and prints its JSON result.
// Build one first: node desktop/scripts/pack.mjs --dir
// Extra arguments are passed to the app (for example --no-sandbox on a CI runner without the SUID sandbox helper).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = join(root, 'release');
const dirs = existsSync(rel) ? readdirSync(rel).filter((d) => d.endsWith('-unpacked') || d.startsWith('mac')) : [];
const candidates = [];
for (const d of dirs) {
  if (process.platform === 'win32') candidates.push(join(rel, d, 'RSMPS.exe'));
  else if (process.platform === 'darwin') candidates.push(join(rel, d, 'RSMPS.app', 'Contents', 'MacOS', 'RSMPS'));
  else candidates.push(join(rel, d, 'rsmps'));
}
const exe = candidates.find(existsSync);
if (!exe) {
  console.error('No unpacked build found in release/. Run: node desktop/scripts/pack.mjs --dir');
  process.exit(2);
}
const r = spawnSync(exe, ['--smoke-test', ...process.argv.slice(2)], { stdio: 'inherit', timeout: 120000 });
process.exit(r.status ?? 1);
