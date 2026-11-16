// Used by npm run desktop:build and desktop:dist:*: web build (unless --skip-web), icons, stage, electron-builder.
// Usage: node desktop/scripts/pack.mjs [--win|--mac|--linux] [--dir] [--skip-web] [more electron-builder args]
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const skipWeb = args.includes('--skip-web');
const passthrough = args.filter((a) => a !== '--skip-web');

function run(a) {
  const r = spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!skipWeb) run([join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
run([join(root, 'desktop', 'scripts', 'make-icons.mjs')]);
run([join(root, 'desktop', 'scripts', 'bundle-modules.mjs')]);
run([join(root, 'desktop', 'scripts', 'stage.mjs')]);
run([join(root, 'node_modules', 'electron-builder', 'cli.js'), '--projectDir', '.desktop-stage', '--config', join(root, 'desktop', 'electron-builder.yml'), `-c.electronVersion=${electronVersion}`, '--publish', 'never', ...passthrough]);
