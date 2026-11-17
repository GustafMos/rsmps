// Regenerates the format tables in docs/CLI.md and docs/FORMATS.md from the registry (src/io/export-codecs.ts), between the marker comments
//   <!-- formats:cli:start --> ... <!-- formats:cli:end -->      and      <!-- formats:guide:start --> ... <!-- formats:guide:end -->
// A test (src/io/export-codecs.test.ts) checks that docs/CLI.md names every row, so a new row fails it until this has been run.
//
//   node scripts/gen-format-docs.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({ entryPoints: [join(root, 'src', 'io', 'export-codecs.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
const { WIRED_ROWS, registryCounts } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const WHO = { own: 'the app itself', 'builtin-webcodecs': 'the browser', ffmpeg: 'FFmpeg' };
const names = (r) => [`\`${r.id}\``, ...(r.aliases ?? []).filter((a) => a !== r.id && a !== r.value).slice(0, 2).map((a) => `\`${a}\``)].join(', ');
const alpha = (r) => (r.alpha ? 'yes' : 'no');
const note = (r) => r.hint.replace(/\s*Written by (your own FFmpeg|the app itself)\.?/g, '').replace(/\s*Written by the browser where it can encode \w+, else by FFmpeg\.?/, '').trim();

function table(kinds, head) {
  const rows = WIRED_ROWS.filter((r) => kinds.includes(r.kind));
  const lines = [`| ${head} | File | Alpha | Written by | Notes |`, '| --- | --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${names(r)} | \`.${r.ext}\` | ${r.kind === 'audio' ? '' : alpha(r)} | ${WHO[r.route]} | **${r.label}.** ${note(r)} |`);
  return lines.join('\n');
}

const cli = [
  '#### Video and animated pictures (`--codec`, or `--format`)',
  '',
  table(['video', 'animated'], '`--codec`'),
  '',
  '#### Pictures and image sequences (`--format`)',
  '',
  table(['still'], '`--format`'),
  '',
  '#### Sound only (`--format`)',
  '',
  table(['audio'], '`--format`'),
].join('\n');

const c = registryCounts();
const fam = (kind, label) => {
  const rows = WIRED_ROWS.filter((r) => (Array.isArray(kind) ? kind : [kind]).includes(r.kind));
  const by = (route) => rows.filter((r) => r.route === route).map((r) => r.label).join(', ');
  return `| ${label} | ${by('own')} | ${by('builtin-webcodecs')} | ${by('ffmpeg')} |`;
};
const guide = [
  '| Family | Written by the app itself (every version) | Written by the browser | Needs FFmpeg (desktop add-on or command line) |',
  '| --- | --- | --- | --- |',
  fam(['video', 'animated'], 'Video and animated pictures'),
  fam('still', 'Pictures and image sequences'),
  fam('audio', 'Sound files'),
  '',
  `${WIRED_ROWS.length} formats in all: ${c.byRoute.own} written by the app itself, ${c.byRoute['builtin-webcodecs']} by the browser's own encoders, ${c.byRoute.ffmpeg} by FFmpeg.`,
].join('\n');

function inject(file, tag, body) {
  const f = join(root, file);
  let s = readFileSync(f, 'utf8');
  const a = `<!-- formats:${tag}:start -->`;
  const b = `<!-- formats:${tag}:end -->`;
  const i = s.indexOf(a);
  const j = s.indexOf(b);
  if (i < 0 || j < 0) throw new Error(`${file}: markers ${a} / ${b} not found`);
  s = s.slice(0, i + a.length) + '\n' + body + '\n' + s.slice(j);
  writeFileSync(f, s);
  console.log(`${file}: ${tag} table written`);
}
inject('docs/CLI.md', 'cli', cli);
inject('docs/FORMATS.md', 'guide', guide);
