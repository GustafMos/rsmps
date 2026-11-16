// Autosave mirror for the desktop app: the renderer posts every stored backup here and it is written as a plain
// `.rsmps.json` file under <userData>/backups/<project>/, the newest KEEP per project. Pure Node (no Electron), so it is
// unit-tested with a temporary folder. Served by main.mjs under app://rsmps/__rsmps/backups.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const KEEP = 10;
const MAX_BODY = 64 * 1024 * 1024;

const safe = (s, fallback) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').slice(0, 60) || fallback;

/** @param {string} dir the backups folder (created on demand) */
export function createBackupMirror(dir, keep = KEEP) {
  const root = resolve(dir);

  function write({ project, name, at, graph }) {
    if (!graph || typeof graph !== 'object' || graph.schema !== 'rsmps/graph') throw new Error('Not an RSMPS project.');
    const p = safe(project, 'project');
    const folder = join(root, p);
    mkdirSync(folder, { recursive: true });
    const stamp = String(Math.floor(Number(at) || Date.now())).padStart(14, '0');
    const file = `${stamp}-${safe(name, 'Untitled')}.rsmps.json`;
    const target = join(folder, file);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(graph));
    renameSync(tmp, target); // never leave a half-written backup behind
    const all = readdirSync(folder).filter((f) => f.endsWith('.rsmps.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(folder, old), { force: true });
    return `${p}/${file}`;
  }

  function list() {
    const out = [];
    let projects = [];
    try {
      projects = readdirSync(root);
    } catch {
      return out;
    }
    for (const project of projects) {
      let files = [];
      try {
        files = readdirSync(join(root, project)).filter((f) => f.endsWith('.rsmps.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(\d+)-(.*)\.rsmps\.json$/.exec(f);
        if (!m) continue;
        let bytes = 0;
        try {
          bytes = statSync(join(root, project, f)).size;
        } catch {
          /* ignore */
        }
        out.push({ project, name: m[2].replace(/_/g, ' '), at: Number(m[1]), file: `${project}/${f}`, bytes });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Returns the file text, refusing anything outside the backups folder. */
  function read(rel) {
    const full = resolve(root, String(rel));
    if (!full.startsWith(root + sep) || !full.endsWith('.rsmps.json')) throw new Error('Not a backup file.');
    return readFileSync(full, 'utf8');
  }

  return { dir: root, write, list, read };
}

export { MAX_BODY };
