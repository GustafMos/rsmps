// Prints the CHANGELOG.md section for a version: node desktop/scripts/release-notes.mjs 0.4.0 > notes.md
// Exits 1 if the version has no section, so a release cannot go out without changelog notes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const head = (l) => /^## \[/.test(l);
const start = lines.findIndex((l) => head(l) && l.startsWith(`## [${version}]`));
if (!version || start < 0) {
  console.error(`CHANGELOG.md has no section "## [${version}]".`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && head(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
process.stdout.write(`${body}\n`);
