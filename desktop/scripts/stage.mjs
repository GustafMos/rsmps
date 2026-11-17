// Stages exactly what goes into the app bundle (.desktop-stage/): the web build (no source maps), the Electron main
// process, a minimal package.json (so none of the repo's node_modules is packaged) and the third-party licence file.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stage = join(root, '.desktop-stage');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html is missing. Run the web build first (npm run build).');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// web build minus source maps (phone.html and its assets stay: the on-demand phone server serves them)
cpSync(join(root, 'dist'), join(stage, 'web'), { recursive: true, filter: (p) => !p.endsWith('.map') });
cpSync(join(root, 'desktop', 'main.mjs'), join(stage, 'main.mjs'));
cpSync(join(root, 'desktop', 'backups.mjs'), join(stage, 'backups.mjs')); // imported by main.mjs
cpSync(join(root, 'desktop', 'crash.mjs'), join(stage, 'crash.mjs'));
cpSync(join(root, 'desktop', 'build', 'phone-server.mjs'), join(stage, 'phone-server.mjs'));
cpSync(join(root, 'desktop', 'build', 'addons.mjs'), join(stage, 'addons.mjs')); // add-on manager, FFmpeg export and the splat-train pipeline (bundled)
cpSync(join(root, 'desktop', 'build', 'icon-256.png'), join(stage, 'icon.png')); // window icon (Windows/Linux)

writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: 'RSMPS',
      version: pkg.version,
      description: pkg.description,
      main: 'main.mjs',
      type: 'module',
      author: pkg.author,
      homepage: pkg.homepage,
      license: pkg.license,
    },
    null,
    2,
  ),
);

// THIRD_PARTY_LICENSES.txt: production dependencies that end up in the web bundle (sharp and ffmpeg are Node-only).
const NODE_ONLY = new Set(['sharp', '@ffmpeg-installer/ffmpeg']);
const seen = new Map();
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(dir) === dir) return null;
  }
}
function visit(name, from) {
  const dir = locate(name, from);
  if (!dir) return;
  const real = resolve(dir);
  if (seen.has(real)) return;
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  seen.set(real, { dir, p });
  for (const dep of Object.keys(p.dependencies ?? {})) visit(dep, dir);
}
for (const dep of [...Object.keys(pkg.dependencies ?? {}), 'ws', 'selfsigned']) if (!NODE_ONLY.has(dep)) visit(dep, root); // ws + selfsigned are bundled into phone-server.mjs

const parts = [
  `RSMPS ${pkg.version}: third-party software notices`,
  '',
  'RSMPS itself is MIT licensed (see LICENSE). The application also contains the software below.',
  'Electron and Chromium licences ship next to this file (LICENSE.electron.txt, LICENSES.chromium.html).',
  'FFmpeg is NOT distributed with RSMPS. The optional FFmpeg add-on is downloaded by the user on request from its upstream source; its licence is shown before the download.',
  'COLMAP (BSD-3-Clause) and Brush (Apache-2.0) are NOT distributed with RSMPS either. The optional add-ons for Splat from Video are downloaded by the user on request from their GitHub releases; their licences are shown before the download.',
  '',
];
const list = [...seen.values()].sort((a, b) => a.p.name.localeCompare(b.p.name));
for (const { dir, p } of list) {
  const lic = typeof p.license === 'string' ? p.license : (p.license?.type ?? JSON.stringify(p.licenses ?? 'UNKNOWN'));
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f) && statSync(join(dir, f)).isFile());
  parts.push('='.repeat(78), `${p.name}@${p.version}  (${lic})`, typeof p.repository === 'string' ? p.repository : (p.repository?.url ?? p.homepage ?? ''), '');
  parts.push(file ? readFileSync(join(dir, file), 'utf8').trim() : `(no licence file shipped in the package; licence declared as ${lic})`, '');
}
const notices = join(root, 'THIRD_PARTY_NOTICES.md');
if (existsSync(notices)) parts.push('='.repeat(78), 'Project notes (THIRD_PARTY_NOTICES.md)', '', readFileSync(notices, 'utf8').trim(), '');
writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), parts.join('\n'));
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
console.log(`staged ${list.length} dependency licences into ${stage}`);
