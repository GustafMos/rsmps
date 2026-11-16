# rsmps: command-line renderer

Headless batch rendering of RSMPS v2 graphs. It runs the same engine as the app (WebGPU through the
`webgpu` npm package), so a graph looks identical in the editor and on the command line. Beyond what a
browser can encode it writes **ProRes-compatible 4444 with alpha**, **PNG sequences with alpha**, QuickTime
Animation / PNG-in-MOV and VP9 WebM with alpha.

Source: `src/cli/`. Requires Node 20+. Video, audio and GIF input and all video output need ffmpeg
(the optional dependency `@ffmpeg-installer/ffmpeg`, else `ffmpeg` on PATH, else `$FFMPEG_PATH`).
Still images and PNG sequences / spritesheets do not need ffmpeg.

## Running

```
npm run build:cli                       # bundles src/cli into dist-cli/rsmps.mjs
node dist-cli/rsmps.mjs render graph.rsmps.json ...
npm run cli -- render graph.rsmps.json ...   # rebuild (about 0.3 s) and run
```

`scripts/build-cli.mjs` first regenerates `src/cli/generated-nodes.ts` (a static import list of every
`src/engine/nodes/**/*.node.ts`, so new node files are picked up on the next build and the list can never
be stale). That file is a build artifact: do not edit or commit it. The bundle keeps `sharp`, `webgpu`
and `@ffmpeg-installer/ffmpeg` external, so run it from inside the repo (or next to `node_modules`).

## Commands

```
rsmps render <graph.rsmps.json> [inputs...] --out <dir> [options]
rsmps check  <graph.rsmps.json> [--plugin file.js] [--json]    validate; unknown nodes; counts
rsmps nodes  [--json] [--plugin file.js]                       every node with category, sockets and params
rsmps print-blank --out <dir> (--frames <n> | --seconds <s>) [options]   blank sheets for paper animation (no graph)
```

Exit status: `0` success, `1` at least one item failed (the others still rendered), `2` bad usage or an
unreadable graph.

### Inputs

Positional inputs (files, folders, globs; quote globs on cmd.exe) go to the **first Media In node**,
one batch item per file, in natural order (`a2` before `a10`). Put them before the options.

| Option | Meaning |
| --- | --- |
| `--input <node>=<path...>` | assign to a specific node (label or id); repeatable |
| `--recursive`, `-r` | descend into sub-folders of folder inputs |
| `--sequence` | a folder is one image-sequence video (`frame_0001.png`, ...) played at `--fps` |

### Options

| Option | Meaning |
| --- | --- |
| `--out`, `-o <dir>` | output folder (default `./out`) |
| `--outputs <a,b>` | only these Output nodes (ids or labels) |
| `--items <range>` | batch items, 1-based: `1-5,8,10-` |
| `--set <node>.<param>=<json>` | override a param (repeatable). Output node params work too: `--set Out.columns=8` |
| `--fps`, `--size WxH`, `--loop` / `--no-loop` | project overrides |
| `--duration <s\|auto>` | project length; `auto` = the length of each item's source video |
| `--format <x>` | `png`, `webp`, `jpeg`; or `image`, `sequence`, `spritesheet`, `video`, `print`; or a codec name |
| `--kind <image\|sequence\|spritesheet\|video\|print>` | force the export kind of every output |
| `--codec <name>` | video codec, implies `--kind video` (below) |
| `--quality <0.1-1>`, `--bitrate <Mbps>` | still quality (webp/jpeg), lossy video bitrate |
| `--plugin <file.js>` | load node definitions (default/named exports; objects or arrays); repeatable |
| `--quiet`, `--json`, `--dry-run` | no progress / JSON lines / list what would be written |

Without overrides each Output node's own params decide (`kind`, `imageFormat`, `scale`, `columns`,
`padding`, `name`). `kind: auto` becomes a video when a source is a video or the picture changes between
frames, otherwise a still. An Output node with kind `print` writes its print sheets (PDF and/or page PNGs, set by the node's Print options) with the same code as the app; see PRINT_AND_SCAN.md.

### Codecs

| `--codec` | File | Alpha | Notes |
| --- | --- | --- | --- |
| `h264` (`avc`), `hevc`, `av1` | `.mp4` | no | yuv420p, even size (padded), `--bitrate` |
| `vp9` | `.webm` | no | yuv420p |
| `prores` | `.mov` | no | prores_ks profile 3 (HQ), yuv422p10le |
| `prores4444` | `.mov` | **yes** | prores_ks profile 4, yuva444p10le, 16-bit alpha |
| `qtrle` | `.mov` | yes | QuickTime Animation, lossless |
| `png` | `.mov` | yes | PNG frames in MOV, lossless |
| `webm-alpha` | `.webm` | yes | libvpx-vp9 yuva420p (needs a player that reads WebM alpha, e.g. browsers) |

Alpha codecs receive **straight** (non-premultiplied) RGBA. Codecs without alpha, and JPEG, get the
picture composited over black.

### Audio

Video exports mux, in this order: the rendered graph audio (an Audio Output with something wired to it,
rendered offline), else the first source video's own sound, else nothing.

### Naming

The Output `name` pattern supports `{name}` (source file stem), `{index}`, `{width}`, `{height}`,
`{frame}`. Clashes get `-2`, `-3`. PNG sequences go into a sub-folder named after the pattern without
`{frame}`: `out/hero/hero_0000.png`.

### print-blank

Blank sheets (frame boxes, scan markers, frame numbers, optional guides; no picture) for animation drawn entirely on paper, from the same code as the app's
**File > Print blank sheets**. No graph is needed; the sheets scan back in the Scan tab like any printed sheet. `rsmps print-blank --help` lists everything.

| Option | Meaning |
| --- | --- |
| `--frames <n>` or `--seconds <s>` | how many frames (seconds use `--fps`, default 12) |
| `--aspect <a>` | `project` (with `--size WxH`), `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `4:5`, `2:3`, `21:9` or `W:H` (default 16:9) |
| `--per-sheet <n>` or `--columns <c> --rows <r>` | frames per sheet (largest frames that fit) or an exact grid |
| `--paper a4\|a3\|letter\|a5\|legal`, `--landscape`, `--margin <mm>`, `--gutter <mm>`, `--dpi <n>` | page |
| `--guides cross,thirds,safe,grid,horizon,pegs` | guides inside every frame |
| `--ghost`, `--no-numbers`, `--no-boxes` | faint onion-skin numbers inside; leave out numbers / boxes |
| `--shoot-on <n>`, `--beats 4,9,...`, `--beats-from audio.wav`, `--exposure-sheet` | timing: holds, beat marks (1-based frames, or found in a WAV), exposure sheet page |
| `--format pdf\|png\|both`, `--name <text>`, `--out <dir>` | output |

```
rsmps print-blank --frames 48 --per-sheet 6 --aspect 16:9 --paper a4 --guides thirds,cross --exposure-sheet --out sheets/
rsmps print-blank --seconds 4 --fps 12 --aspect 4:3 --landscape --shoot-on 2 --format both --out sheets/
```

The Output node's Print group also controls rotoscope styles (`printStyle`: full, faint, outline, blue), paper layers (`printLayers`), layouts (`printLayout`: grid, flipbook, zine)
and `printKind` (sheets, separations, svg-plot). They work with `render` like any Output param, e.g. `--set Out.printStyle="blue"` or `--set Out.printKind="svg-plot"`; see PRINT_AND_SCAN.md.

## Recipes

**Batch a folder of sprites through a graph**

```
rsmps render outline.rsmps.json ./sprites --out ./done
rsmps render outline.rsmps.json "./art/**/*.png" --out ./done --set Edge.thickness=3 --format webp --quality 0.9
rsmps render outline.rsmps.json ./sprites --items 5-10 --out ./done     # just items 5 to 10
```

Every file is one item; a file that fails to decode is reported (`FAILED item 3 ...`), the rest still
render and the exit status is 1.

**ProRes-compatible 4444 with alpha**

```
rsmps render fx.rsmps.json --codec prores4444 --out ./video
rsmps render fx.rsmps.json clip.mov --duration auto --codec prores4444 --out ./video
```

**PNG sequence with alpha**

```
rsmps render fx.rsmps.json --kind sequence --out ./frames        # frames/fx/fx_0000.png ...
rsmps render fx.rsmps.json --kind sequence --set Out.name="shot_{frame}" --out ./frames
```

**Spritesheet for Godot**

```
rsmps render walk.rsmps.json --kind spritesheet --set Out.columns=8 --set Out.padding=0 --out ./godot
```

Writes `walk.png` and `walk.json` (`frameWidth`, `frameHeight`, `columns`, `rows`, `padding`, `fps`,
per-frame rects). In Godot use `Sprite2D` with `hframes = columns`, `vframes = rows` (or an
`AnimatedSprite2D` / `SpriteFrames` "Add Frames from Sprite Sheet" with the same grid); set
`Out.scale` to a whole number for crisp pixel-art enlargement and use `Nearest` texture filtering.

## Notes and limits

- Text nodes cannot rasterise fonts headlessly: they render empty (a warning is printed).
- Video input is decoded by one long-lived ffmpeg process per video, back-pressured; a backward seek
  (for example a looping video) re-spawns it with `-ss`.
- Rendering is single-GPU and sequential (`final` quality, proxy 1); there is no `--jobs`.
- Plugins are loaded with a dynamic `import()`; a `.js`/`.mjs` module exporting plain node definition
  objects needs no imports from the repo (`defineNode` is the identity function).
