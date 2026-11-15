// npm run desktop:dev: starts the Vite dev server (or reuses one on :5173) and opens the desktop shell against it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const url = 'http://localhost:5173';
const up = () => fetch(url).then((r) => r.ok, () => false);

let vite = null;
if (!(await up())) {
  vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'], { cwd: root, stdio: 'inherit' });
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}
const electronPath = createRequire(import.meta.url)('electron');
const app = spawn(electronPath, [join(root, 'desktop', 'main.mjs'), `--dev-url=${url}`], { cwd: root, stdio: 'inherit' });
app.on('exit', (code) => {
  vite?.kill();
  process.exit(code ?? 0);
});
