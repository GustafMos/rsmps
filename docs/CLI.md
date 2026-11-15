# rsmps: command-line renderer

Headless batch rendering of RSMPS v2 graphs. It runs the same engine as the app (WebGPU through the
`webgpu` npm package), so a graph looks identical in the editor and on the command line. Beyond what a
browser can encode it writes **ProRes 4444 with alpha**, **PNG sequences with alpha**, QuickTime
Animation / PNG-in-MOV and VP9 WebM with alpha.

Source: `src/cli2/`. Requires Node 20+. Video, audio and GIF input and all video output need ffmpeg
(the optional dependency `@ffmpeg-installer/ffmpeg`, else `ffmpeg` on PATH, else `$FFMPEG_PATH`).
Still images and PNG sequences / spritesheets do not need ffmpeg.

## Running

```
npm run build:cli2                       # bundles src/cli2 into dist-cli/rsmps.mjs
node dist-cli/rsmps.mjs render graph.rsmps.json ...
npm run cli2 -- render graph.rsmps.json ...   # rebuild (about 0.3 s) and run
```

`scripts/build-cli.mjs` first regenerates `src/cli2/generated-nodes.ts` (a static import list of every
`src/engine/nodes/**/*.node.ts`, so new node files are picked up on the next build and the list can never
be stale). That file is a build artifact: do not edit or commit it. The bundle keeps `sharp`, `webgpu`
and `@ffmpeg-installer/ffmpeg` external, so run it from inside the repo (or next to `node_modules`).

## Commands

```
rsmps render <graph.rsmps.json> [inputs...] --out <dir> [options]
rsmps check  <graph.rsmps.json> [--plugin file.js] [--json]    validate; unknown nodes; counts
rsmps nodes  [--json] [--plugin file.js]                       every node with category, sockets and params
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
| `--format <x>` | `png`, `webp`, `jpeg`; or `image`, `sequence`, `spritesheet`, `video`; or a codec name |
| `--kind <image\|sequence\|spritesheet\|video>` | force the export kind of every output |
| `--codec <name>` | video codec, implies `--kind video` (below) |
| `--quality <0.1-1>`, `--bitrate <Mbps>` | still quality (webp/jpeg), lossy video bitrate |
| `--plugin <file.js>` | load node definitions (default/named exports; objects or arrays); repeatable |
| `--quiet`, `--json`, `--dry-run` | no progress / JSON lines / list what would be written |

Without overrides each Output node's own params decide (`kind`, `imageFormat`, `scale`, `columns`,
`padding`, `name`). `kind: auto` becomes a video when a source is a video or the picture changes between
frames, otherwise a still. An Output node with kind `print` is skipped with a message.

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

## Recipes

**Batch a folder of sprites through a graph**

```
rsmps render outline.rsmps.json ./sprites --out ./done
rsmps render outline.rsmps.json "./art/**/*.png" --out ./done --set Edge.thickness=3 --format webp --quality 0.9
rsmps render outline.rsmps.json ./sprites --items 5-10 --out ./done     # just items 5 to 10
```

Every file is one item; a file that fails to decode is reported (`FAILED item 3 ...`), the rest still
render and the exit status is 1.

**ProRes 4444 with alpha**

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
