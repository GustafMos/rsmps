/**
 * rsmps: headless renderer for RSMPS v2 graphs (WebGPU through the `webgpu` package, ffmpeg for video).
 *
 *   rsmps render <graph.rsmps.json> [inputs...] --out <dir> [options]
 *   rsmps nodes [--json]
 *   rsmps check <graph.rsmps.json> [--plugin file.js]
 *
 * Run `rsmps --help` or see docs/CLI.md.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, numberOpt, one, type OptionSpec } from './args';
import { CODEC_NAMES, IMAGE_FORMATS, CODECS, normalizeImageFormat, parseCodec } from './encode';
import { findFfmpeg } from './ffmpeg';
import { createRegistry, loadPlugins } from './nodes';
import { applyOverrides, assignInputs, loadGraph, parseItemRange } from './prepare';
import { renderGraphBatch, selectOutputs, type Kind, type Overrides, type Reporter } from './render';
import { batchCount, validateGraph } from '../engine/graph';
import { cmdPrintBlank } from './print-blank';
import type { Registry } from '../engine/define';
import type { ParamDef } from '../engine/types';

const HELP = `rsmps - headless renderer for RSMPS graphs

Usage
  rsmps render <graph.rsmps.json> [inputs...] --out <dir> [options]
  rsmps check  <graph.rsmps.json> [--plugin file.js]
  rsmps nodes  [--json] [--plugin file.js]
  rsmps print-blank --out <dir> (--frames <n> | --seconds <s>) [options]   blank sheets for paper animation (--help)

Inputs (render)
  Files, folders and globs (quote globs on cmd.exe). By default they all go to the first Media In
  node (one batch item per file). Put positional inputs before options.
  --input <node>=<path...>   assign to a specific node (label or id); repeatable
  --recursive, -r            descend into sub-folders of folder inputs
  --sequence                 treat folder inputs as image sequences (frame_0001.png ...), see --fps

Options (render)
  --out, -o <dir>            output folder (default ./out)
  --outputs <a,b>            only these Output nodes (ids or labels)
  --items <range>            batch items, 1-based: 1-5,8,10-
  --set <node>.<param>=<json>  override a param; repeatable. Output params work too: --set Out.columns=8
  --fps <n>                  project fps (and the fps of image-sequence inputs)
  --duration <s|auto>        project duration in seconds; 'auto' = length of each item's source video
  --loop / --no-loop         project loop mode
  --size WxH                 project canvas size
  --format <x>               png|webp|jpeg, or image|sequence|spritesheet|video, or a codec name
  --kind <image|sequence|spritesheet|video|print>   force the export kind of every output
  --codec <name>             video codec (implies --kind video): ${CODEC_NAMES}
  --quality <0.1-1>          still image quality (webp/jpeg)
  --bitrate <Mbps>           lossy video bitrate
  --plugin <file.js>         load node definitions from a module; repeatable
  --quiet, -q                no progress output
  --json                     machine-readable progress, one JSON object per line
  --dry-run                  validate and list what would be written, render nothing
  Game assets (apply to every spritesheet Output; the same as the Output node's params, which --set can also reach)
  --for <preset>             generic|godot|unity|gamemaker|rpgmaker|web: a starting point for that engine
  --sheet-layout <x>         grid|row|column|pack      --columns <n>   --sheet-padding <n>   --extrude <n>
  --trim                     trim transparent borders (offsets go into the metadata)
  --pot                      power-of-two sheet sizes   --max-sheet <n>  largest page, more pages when needed
  --sheet-meta <x>           json|aseprite|texturepacker|css|none
  --sheet-from <clip|batch>  batch = ONE sheet from every item, one animation tag per item
  --anim-name <name>         animation tag name (default: the source file name)
  --pivot <x,y>              write this pivot (0..1 of the frame, y down) into the metadata
  --bleed                    color under transparent pixels = nearest opaque color (PNG, no dark fringes when filtered)
  --report <json|text>       write export-report.json / .txt: size, distinct colors, off-palette fraction, frames per file
  --process                  run the processes an Output needs (clip analysis...) before rendering, in memory.
                             Without it, a render that would export a stand-in fails and lists them.

Exit status: 0 success, 1 some item failed, 2 bad usage.
`;

const RENDER_SPEC: Record<string, OptionSpec> = {
  out: { value: true, alias: 'o' },
  outputs: { value: true },
  items: { value: true },
  set: { value: true, repeat: true },
  input: { value: true, repeat: true, greedy: true },
  fps: { value: true },
  duration: { value: true },
  loop: {},
  'no-loop': {},
  size: { value: true },
  format: { value: true },
  kind: { value: true },
  codec: { value: true },
  quality: { value: true },
  bitrate: { value: true },
  plugin: { value: true, repeat: true },
  quiet: { alias: 'q' },
  json: {},
  'dry-run': {},
  process: {},
  for: { value: true },
  'sheet-layout': { value: true },
  columns: { value: true },
  'sheet-padding': { value: true },
  extrude: { value: true },
  trim: {},
  pot: {},
  'max-sheet': { value: true },
  'sheet-meta': { value: true },
  'sheet-from': { value: true },
  'anim-name': { value: true },
  pivot: { value: true },
  bleed: {},
  report: { value: true },
  recursive: { alias: 'r' },
  sequence: {},
  help: { alias: 'h' },
};

function makeReporter(quiet: boolean, json: boolean): Reporter {
  const tty = process.stderr.isTTY && !json && !quiet;
  let lastLen = 0;
  let lastPrint = 0;
  const clearLine = () => {
    if (tty && lastLen) process.stderr.write('\r' + ' '.repeat(lastLen) + '\r');
    lastLen = 0;
  };
  return {
    info(msg) {
      if (quiet || json) return;
      clearLine();
      console.log(msg);
    },
    warn(msg) {
      if (json) return;
      clearLine();
      console.error(`warning: ${msg}`);
    },
    event(e) {
      if (json) console.log(JSON.stringify(e));
    },
    progress(label, done, total) {
      if (json) {
        console.log(JSON.stringify({ event: 'progress', output: label, frame: done, frames: total }));
        return;
      }
      if (quiet || !tty) return;
      const now = Date.now();
      if (done < total && now - lastPrint < 100) return;
      lastPrint = now;
      const line = `  ${label}: frame ${done}/${total}`;
      process.stderr.write('\r' + line.padEnd(lastLen));
      lastLen = line.length;
    },
  };
}

async function setup(plugins: string[]): Promise<Registry> {
  const registry = createRegistry();
  if (plugins.length) await loadPlugins(registry, plugins);
  return registry;
}

function describeParam(p: ParamDef): string {
  switch (p.type) {
    case 'number':
      return `number ${JSON.stringify(p.default)}${p.min !== undefined || p.max !== undefined ? ` [${p.min ?? ''}..${p.max ?? ''}]` : ''}${p.unit ? ` ${p.unit}` : ''}`;
    case 'enum':
      return `enum ${JSON.stringify(p.default)} of ${p.options.map((o) => o.value).join('|')}`;
    default:
      return `${p.type} ${JSON.stringify(p.default)}`;
  }
}

async function cmdNodes(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { json: {}, plugin: { value: true, repeat: true } });
  const registry = await setup(p.values.get('plugin') ?? []);
  const defs = registry.list().sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  if (p.flags.has('json')) {
    console.log(
      JSON.stringify(
        defs.map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          description: d.description,
          inputs: Object.fromEntries(Object.entries(d.inputs).map(([k, v]) => [k, (v as { type: string }).type])),
          outputs: Object.fromEntries(Object.entries(d.outputs).map(([k, v]) => [k, (v as { type: string }).type])),
          params: Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, v])),
        })),
        (_k, v) => (typeof v === 'function' ? undefined : v),
        2,
      ),
    );
    return 0;
  }
  let cat = '';
  for (const d of defs) {
    if (d.category !== cat) {
      cat = d.category;
      console.log(`\n[${cat}]`);
    }
    const ins = Object.entries(d.inputs).map(([k, v]) => `${k}:${(v as { type: string }).type}`).join(', ');
    const outs = Object.entries(d.outputs).map(([k, v]) => `${k}:${(v as { type: string }).type}`).join(', ');
    console.log(`  ${d.id} - ${d.description}`);
    console.log(`      in: ${ins || '-'}   out: ${outs || '-'}`);
    for (const [k, v] of Object.entries(d.params)) console.log(`      ${k}: ${describeParam(v as ParamDef)}`);
  }
  console.log(`\n${defs.length} nodes.`);
  return 0;
}

async function cmdCheck(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { plugin: { value: true, repeat: true }, json: {} });
  if (p.positionals.length !== 1) throw new Error('Usage: rsmps check <graph.rsmps.json>');
  const registry = await setup(p.values.get('plugin') ?? []);
  const graph = loadGraph(p.positionals[0]);
  const problems = validateGraph(graph, registry).map((x) => ({ node: x.nodeId, message: x.message }));
  const unknown = [...new Set(graph.nodes.filter((n) => !registry.get(n.type)).map((n) => n.type))];
  const outs = selectOutputs(graph, registry).nodes;
  if (outs.length === 0) problems.push({ node: undefined, message: 'No image-out node: nothing to export.' });
  if (p.flags.has('json')) console.log(JSON.stringify({ ok: problems.length === 0, nodes: graph.nodes.length, unknownNodeTypes: unknown, problems }, null, 2));
  else {
    if (unknown.length) console.log(`Unknown node types: ${unknown.join(', ')} (load them with --plugin)`);
    for (const x of problems) console.log(`${x.node ? x.node + ': ' : ''}${x.message}`);
    console.log(problems.length ? `${problems.length} problem(s).` : `OK: ${graph.nodes.length} nodes, ${graph.edges.length} wires, ${outs.length} output(s), ${batchCount(graph, registry)} batch item(s).`);
  }
  return problems.length ? 1 : 0;
}

async function cmdRender(argv: string[]): Promise<number> {
  const p = parseArgs(argv, RENDER_SPEC);
  if (p.flags.has('help')) {
    console.log(HELP);
    return 0;
  }
  if (p.positionals.length < 1) throw new Error('Usage: rsmps render <graph.rsmps.json> [inputs...] --out <dir>');
  const quiet = p.flags.has('quiet');
  const json = p.flags.has('json');
  const rep = makeReporter(quiet, json);
  const registry = await setup(p.values.get('plugin') ?? []);
  let graph = loadGraph(p.positionals[0]);

  const problems = validateGraph(graph, registry);
  if (problems.length) throw new Error(`The graph has problems:\n  ${problems.map((x) => `${x.nodeId ? x.nodeId + ': ' : ''}${x.message}`).join('\n  ')}`);

  // Project overrides and --set.
  const durationRaw = one(p, 'duration');
  const durationAuto = durationRaw === 'auto';
  const fps = numberOpt(p, 'fps', 1);
  graph = applyOverrides(graph, registry, {
    size: one(p, 'size'),
    fps,
    duration: durationAuto ? undefined : numberOpt(p, 'duration', 0.001),
    loop: p.flags.has('loop') ? true : p.flags.has('no-loop') ? false : undefined,
    sets: p.values.get('set'),
  });

  // Inputs.
  const targeted = (p.values.get('input') ?? []).reduce<{ node: string; paths: string[] }[]>((acc, v) => {
    const eq = v.indexOf('=');
    if (eq > 0 && !/^[a-zA-Z]:[\\/]/.test(v.slice(0, eq + 1))) acc.push({ node: v.slice(0, eq), paths: [v.slice(eq + 1)] });
    else if (acc.length) acc[acc.length - 1].paths.push(v);
    else throw new Error(`Bad --input "${v}": expected <node>=<path>.`);
    return acc;
  }, []);
  const assigned = assignInputs(graph, registry, { positional: p.positionals.slice(1), targeted, recursive: p.flags.has('recursive'), sequence: p.flags.has('sequence') });
  graph = assigned.graph;
  for (const a of assigned.assigned) rep.info(`${a.count} input(s) → ${a.node}`);

  // Export overrides.
  const ov: Overrides = {};
  const kinds = ['image', 'sequence', 'spritesheet', 'video', 'print'];
  const fmt = one(p, 'format');
  const kind = one(p, 'kind');
  const codecName = one(p, 'codec');
  if (fmt) {
    if (IMAGE_FORMATS.includes(fmt.toLowerCase())) ov.imageFormat = normalizeImageFormat(fmt)!;
    else if (kinds.includes(fmt.toLowerCase())) ov.kind = fmt.toLowerCase() as Kind;
    else if (parseCodec(fmt)) ov.codec = CODECS[parseCodec(fmt)!];
    else throw new Error(`Unknown --format "${fmt}". Use png, webp, jpeg, image, sequence, spritesheet, video, print or a codec (${CODEC_NAMES}).`);
  }
  if (kind) {
    if (!kinds.includes(kind)) throw new Error(`Unknown --kind "${kind}" (${kinds.join(', ')}).`);
    ov.kind = kind as Kind;
  }
  if (codecName) {
    const c = parseCodec(codecName);
    if (!c) throw new Error(`Unknown --codec "${codecName}". Available: ${CODEC_NAMES}.`);
    ov.codec = CODECS[c];
  }
  if (ov.codec && !ov.kind) ov.kind = 'video';
  const outputParams: Record<string, unknown> = {};
  const choice = (flag: string, key: string, allowed: string[]) => {
    const v = one(p, flag);
    if (v === undefined) return;
    if (!allowed.includes(v)) throw new Error(`Unknown --${flag} "${v}" (${allowed.join(', ')}).`);
    outputParams[key] = v;
  };
  choice('for', 'preset', ['generic', 'godot', 'unity', 'gamemaker', 'rpgmaker', 'web']);
  choice('sheet-layout', 'sheetLayout', ['grid', 'row', 'column', 'pack']);
  choice('sheet-meta', 'sheetMeta', ['json', 'aseprite', 'texturepacker', 'css', 'none']);
  choice('sheet-from', 'sheetFrom', ['clip', 'batch']);
  const intFlag = (flag: string, key: string) => {
    const v = numberOpt(p, flag, 0);
    if (v !== undefined) outputParams[key] = Math.round(v);
  };
  intFlag('columns', 'columns');
  intFlag('sheet-padding', 'padding');
  intFlag('extrude', 'extrude');
  intFlag('max-sheet', 'maxSheet');
  if (p.flags.has('trim')) outputParams.sheetTrim = true;
  if (p.flags.has('pot')) outputParams.powerOfTwo = true;
  if (p.flags.has('bleed')) outputParams.bleed = true;
  if (one(p, 'anim-name') !== undefined) outputParams.animName = one(p, 'anim-name');
  const pivot = one(p, 'pivot');
  if (pivot !== undefined) {
    const xy = pivot.split(',').map(Number);
    if (xy.length !== 2 || xy.some((n) => !Number.isFinite(n))) throw new Error('--pivot expects x,y (for example 0.5,1).');
    outputParams.pivotOn = true;
    outputParams.pivot = xy;
  }
  if (Object.keys(outputParams).length) ov.outputParams = outputParams;
  const reportFormat = one(p, 'report');
  if (reportFormat !== undefined && reportFormat !== 'json' && reportFormat !== 'text') throw new Error('--report expects json or text.');
  ov.quality = numberOpt(p, 'quality', 0.1);
  ov.bitrate = numberOpt(p, 'bitrate', 0.1);

  const outDir = resolve(one(p, 'out') ?? 'out');
  const count = batchCount(graph, registry);
  const items = one(p, 'items') ? parseItemRange(one(p, 'items')!, count) : undefined;
  const dry = p.flags.has('dry-run');
  const outputs = (one(p, 'outputs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const needsFfmpeg = ov.codec || ov.kind === 'video' || graph.nodes.some((n) => n.type === 'media-in' && Array.isArray(n.params.assets) && (n.params.assets as string[]).some((a) => /\.(mp4|mov|m4v|mkv|webm|avi|gif|mpe?g|wmv|flv|ogv|wav|mp3|flac|ogg|m4a|aac|opus|aiff?)$/i.test(a)));
  if (needsFfmpeg && !(await findFfmpeg())) throw new Error('ffmpeg was not found. Install the optional dependency @ffmpeg-installer/ffmpeg, put ffmpeg on PATH or set FFMPEG_PATH.');

  if (!dry) mkdirSync(outDir, { recursive: true });
  const summary = await renderGraphBatch({
    graph,
    registry,
    outDir,
    outputs,
    items,
    overrides: ov,
    durationFromSource: durationAuto,
    sequenceFps: fps ?? graph.project.fps,
    dryRun: dry,
    reporter: rep,
    report: reportFormat as 'json' | 'text' | undefined,
    processes: p.flags.has('process') ? 'run' : 'fail',
  });

  if (dry) {
    if (json) console.log(JSON.stringify({ event: 'plan', outDir, plan: summary.plan, errors: summary.errors, skipped: summary.skipped }));
    else if (!quiet) {
      console.log(`Dry run: ${summary.plan.length} job(s) would write into ${outDir}`);
      for (const f of summary.plan) console.log(`  item ${f.item} · ${f.output} · ${f.kind} ${f.width}x${f.height}${f.frames > 1 ? ` · ${f.frames} frames` : ''} → ${f.path}${f.note ? ` (${f.note})` : ''}`);
    }
  } else if (json) {
    console.log(JSON.stringify({ event: 'done', files: summary.files.length, errors: summary.errors.length, seconds: summary.seconds, outDir }));
  } else if (!quiet) {
    console.log(`Done: ${summary.files.length} file(s) in ${outDir} (${summary.seconds.toFixed(1)} s)${summary.errors.length ? `, ${summary.errors.length} failed` : ''}.`);
  }
  if (summary.errors.length && !json) {
    for (const e of summary.errors) console.error(`FAILED item ${e.item} (${e.output}): ${e.message}`);
  }
  return summary.errors.length ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'render':
        return await cmdRender(rest);
      case 'nodes':
        return await cmdNodes(rest);
      case 'check':
        return await cmdCheck(rest);
      case 'print-blank':
        return await cmdPrintBlank(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return cmd === undefined ? 2 : 0;
      default:
        console.error(`Unknown command "${cmd}".\n`);
        console.error(HELP);
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

// Run when executed directly (tsx src/cli/main.ts or the bundled dist-cli/rsmps.mjs), not when imported by tests.
const entry = process.argv[1] ?? '';
if (/[\\/](main\.ts|rsmps\.mjs)$/.test(entry)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
