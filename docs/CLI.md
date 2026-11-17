# rsmps: command-line renderer

Headless batch rendering of RSMPS v2 graphs. It runs the same engine as the app (WebGPU through the
`webgpu` npm package), so a graph looks identical in the editor and on the command line. Beyond what a
browser can encode it writes **ProRes-compatible 4444 with alpha**, **PNG sequences with alpha**, QuickTime
Animation / PNG-in-MOV and VP9 WebM with alpha. Many formats (HAP, Motion JPEG, GIF, QOI, TIFF, OpenEXR, WAV, FLAC and more) are written by the app itself and need no FFmpeg.

Source: `src/cli/`. Requires Node 20+. Video, audio and GIF input need ffmpeg (the optional dependency
`@ffmpeg-installer/ffmpeg`, else `ffmpeg` on PATH, else `$FFMPEG_PATH`), and so does output in the formats marked FFmpeg below (H.264 and the
other codecs the browser writes, ProRes-compatible, DXV-compatible ...). The formats the app writes itself, still images, image sequences and sprite sheets do not need ffmpeg.

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
rsmps formats [--json]                                          every output format, who writes it, and whether it works here
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
| `--format <x>` | a picture format (`png`, `webp`, `jpeg`, `avif`, `qoi`, `tiff`, `tga`, `bmp`, `exr`, `hdr`, `tiff16`, `dpx`, `ico`, `ppm`, `jp2`), a sound format (`wav`, `flac`, `mp3` ...: sound only), `image`, `sequence`, `spritesheet`, `video`, `print`, or a codec name |
| `--kind <image\|sequence\|spritesheet\|video\|print>` | force the export kind of every output |
| `--codec <name>` | video codec, implies `--kind video` (below) |
| `--quality <0.1-1>`, `--bitrate <Mbps>` | still quality (webp/jpeg), lossy video bitrate |
| `--plugin <file.js>` | load node definitions (default/named exports; objects or arrays); repeatable |
| `--quiet`, `--json`, `--dry-run` | no progress / JSON lines / list what would be written |

Without overrides each Output node's own params decide (`kind`, `imageFormat`, `scale`, `columns`,
`padding`, `name`). `kind: auto` becomes a video when a source is a video or the picture changes between
frames, otherwise a still. An Output node with kind `print` writes its print sheets (PDF and/or page PNGs, set by the node's Print options) with the same code as the app; see PRINT_AND_SCAN.md.

### Game assets (sprite sheets, engine presets, report)

Apply to every sprite sheet Output; each flag is the same as the Output node's param of the same meaning (`--set Out.sheetLayout=pack` works too).
See docs/GAME_ASSETS.md for what they do.

| Option | Output param | Meaning |
| --- | --- | --- |
| `--for <preset>` | `preset`, `videoFor` | `generic`, `godot`, `unity`, `gamemaker`, `rpgmaker`, `web`: starting points that override the sheet fields they list. Video presets: `vj` (DXV-compatible if this FFmpeg has the `dxv` encoder, else ProRes-compatible 422 HQ), `editing` (ProRes-compatible 422 HQ), `web` (H.264, AAC). `web` applies to both: a sheet Output gets the CSS-sprites preset, a video Output the H.264 one. A fallback inside a preset is printed as a warning |
| `--sheet-layout <x>` | `sheetLayout` | `grid`, `row`, `column`, `pack` |
| `--columns <n>`, `--sheet-padding <n>`, `--extrude <n>` | `columns`, `padding`, `extrude` | grid columns (0 = about square), gap between cells, edge pixels repeated around each frame |
| `--trim`, `--pot`, `--max-sheet <n>` | `sheetTrim`, `powerOfTwo`, `maxSheet` | trim transparent borders, power-of-two pages, largest page (more pages: `name_2.png`) |
| `--sheet-meta <x>` | `sheetMeta` | `json` (generic, default), `aseprite`, `texturepacker`, `css`, `none` |
| `--sheet-from <clip|batch>` | `sheetFrom` | `batch` = ONE sheet holding every batch item, one animation tag per item (named after its file) |
| `--anim-name <name>`, `--pivot x,y` | `animName`, `pivotOn` + `pivot` | tag name; pivot (0..1, y down) written to the metadata |
| `--bleed` | `bleed` | color under transparent pixels = nearest opaque color (PNG; also for stills and sequences) |
| `--report <json|text>` | | write `export-report.json` / `.txt`: per image file width x height, colors, frames, bytes, pages and the off-palette fraction of a Palette Lock (report mode) upstream |

```
rsmps render look.rsmps.json ./sprites/*.png --kind spritesheet --sheet-from batch --sheet-layout pack --trim --extrude 1 --pot --sheet-meta aseprite --out ./atlas
rsmps render look.rsmps.json ./sprites --for godot --bleed --report text --out ./done
```

### Formats

`rsmps formats` (or `--list-formats`; `--json` for scripts) prints every format with who writes it and whether it works on this machine:

```
rsmps formats
  hap-alpha       HAP Alpha                 mov   own               yes (own)
  prores4444      ProRes-compatible 4444    mov   ffmpeg            yes (ffmpeg)
  dxv             DXV-compatible            mov   ffmpeg            no       needs the dxv encoder, which this FFmpeg lacks
```

Every format is one row of one table (`src/io/export-codecs.ts`) and one entry here, whichever way it is written:

- **The app itself** (route `own`): HAP, HAP Alpha, HAP Q, Motion JPEG, PNG and uncompressed MOV, animated GIF and PNG, QOI, TIFF (8 and 16 bit), TGA, BMP, ICO, PPM, OpenEXR, Radiance HDR, WAV, AIFF and FLAC. **No FFmpeg needed.** HAP is compressed on the GPU, so it works in the headless renderer too. Motion JPEG uses `sharp` here (the browser uses its canvas).
- **The browser's encoders** in the app (route `builtin-webcodecs`): H.264, H.265, VP9, AV1, PNG, WebP, JPEG, AVIF, AAC and Opus WebM. The command line writes the pictures with `sharp` and the video and sound with FFmpeg.
- **FFmpeg** (route `ffmpeg`, your own copy: `ffmpeg` on PATH, `$FFMPEG_PATH` or the optional dependency): ProRes-compatible, DXV-compatible, DNxHR-compatible, CineForm-compatible, lossless and delivery codecs, animated WebP and AVIF, DPX, JPEG 2000, MP3, Opus, Vorbis and ALAC.

A format that exists on two routes has one entry and the better route is chosen for you: HAP, Motion JPEG, PNG MOV, GIF, APNG, TIFF, TGA and BMP are always written by the app, even when FFmpeg could write them. (GIF in particular: the app keeps a palette per frame and is exact for pixel art; there is no second FFmpeg GIF entry.)

Sound-only export (`--format wav24`, `flac`, `aiff`, `mp3` ...) writes the Audio Output's mix, one file per batch item. Options of the formats the app writes itself are Output params: `--set Out.hapQuality=better` (CPU refinement, slow), `--set Out.hapSnappy=false`, `--set Out.gifDither=floyd`, `--set Out.gifPalette=global`, `--set Out.gifColors=64`, `--set Out.gifLoop=0`.

<!-- formats:cli:start -->
#### Video and animated pictures (`--codec`, or `--format`)

| `--codec` | File | Alpha | Written by | Notes |
| --- | --- | --- | --- | --- |
| `h264`, `h.264`, `x264` | `.mp4` | no | the browser | **H.264 MP4.** Works everywhere. |
| `hevc`, `h265`, `h.265` | `.mp4` | no | the browser | **H.265 MP4.** Works where the browser can encode it. |
| `vp9` | `.webm` | no | the browser | **VP9 WebM.** Open format. Works everywhere. |
| `av1` | `.mp4` | no | the browser | **AV1 MP4.** Open format. Works where the browser can encode it. |
| `dxv`, `dxv-compatible` | `.mov` | no | FFmpeg | **DXV-compatible.** Resolume's own format: plays and loops with almost no load. No transparency. Files are large (about 1 byte per pixel per frame). Sizes are padded to even numbers and the encoder pads to 16 itself. Written by FFmpeg, not by Resolume software: test your file in Resolume before a show. |
| `hap` | `.mov` | no | the app itself | **HAP.** GPU-friendly format (DXT1 textures), supported by many VJ and media-server applications; check your software's documentation. No transparency. Large files. |
| `hap-alpha`, `hapalpha` | `.mov` | yes | the app itself | **HAP Alpha.** HAP with transparency (DXT5 textures). Large files. |
| `hap-q`, `hapq` | `.mov` | no | the app itself | **HAP Q.** HAP with higher picture quality (DXT5-YCoCg textures). No transparency. Large files. |
| `mjpeg`, `photo-jpeg`, `motion-jpeg` | `.mov` | no | the app itself | **Motion JPEG MOV.** Every frame is a JPEG picture: plays quickly in VJ software and edits well. No transparency. |
| `prores-proxy` | `.mov` | no | FFmpeg | **ProRes-compatible Proxy.** Follows the ProRes format but is written by FFmpeg, not by Apple software. Smallest files, for offline editing. No transparency. |
| `prores-lt` | `.mov` | no | FFmpeg | **ProRes-compatible LT.** Follows the ProRes format but is written by FFmpeg, not by Apple software. Light files. No transparency. |
| `prores-standard` | `.mov` | no | FFmpeg | **ProRes-compatible 422.** Follows the ProRes format but is written by FFmpeg, not by Apple software. No transparency. |
| `prores`, `prores422` | `.mov` | no | FFmpeg | **ProRes-compatible 422 HQ.** Follows the ProRes format but is written by FFmpeg, not by Apple software. 422 HQ has no transparency. Resolume plays it natively. |
| `prores4444`, `prores-4444` | `.mov` | yes | FFmpeg | **ProRes-compatible 4444.** Follows the ProRes format but is written by FFmpeg, not by Apple software. 4444 keeps transparency. |
| `prores-4444xq` | `.mov` | yes | FFmpeg | **ProRes-compatible XQ.** Follows the ProRes format but is written by FFmpeg, not by Apple software. 4444 XQ: highest quality, with transparency. Very large files. |
| `dnxhr-lb` | `.mov` | no | FFmpeg | **DNxHR-compatible LB.** Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. Low bandwidth proxy. |
| `dnxhr-sq` | `.mov` | no | FFmpeg | **DNxHR-compatible SQ.** Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. Standard quality. |
| `dnxhr-hq` | `.mov` | no | FFmpeg | **DNxHR-compatible HQ.** Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. High quality 8-bit. |
| `dnxhr-hqx` | `.mov` | no | FFmpeg | **DNxHR-compatible HQX.** Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. High quality 10-bit. |
| `dnxhr-444` | `.mov` | no | FFmpeg | **DNxHR-compatible 444.** Follows the DNxHR format, written by FFmpeg. Needs a picture of at least 256x120. Full color 10-bit. No transparency. |
| `cineform` | `.mov` | no | FFmpeg | **CineForm-compatible.** Follows the CineForm format, written by FFmpeg, not by GoPro software. 10-bit 4:2:2, no transparency. |
| `cineform-alpha` | `.mov` | yes | FFmpeg | **CineForm-compat. alpha.** CineForm-compatible with transparency (12-bit RGBA). Written by FFmpeg, not by GoPro software. Large files. |
| `qtrle`, `animation` | `.mov` | yes | FFmpeg | **Animation alpha MOV.** QuickTime Animation: lossless, with transparency. Large files. |
| `png`, `mov-png` | `.mov` | yes | the app itself | **PNG MOV lossless.** PNG pictures in a MOV: lossless, with transparency. Large files. |
| `raw-mov`, `mov-raw`, `uncompressed` | `.mov` | yes | the app itself | **Uncompressed MOV.** Raw 8-bit pixels (QuickTime 32-bit ARGB) in a MOV: lossless, with transparency, no decoding work. Very large files: 4 bytes per pixel per frame. |
| `ffv1` | `.mkv` | yes | FFmpeg | **FFV1 MKV lossless.** Open lossless archive format, with transparency. Large files; few players read it. |
| `utvideo` | `.avi` | yes | FFmpeg | **UT Video AVI.** Fast open lossless format, with transparency. Large files. |
| `v210` | `.mov` | no | FFmpeg | **Uncompressed 10-bit.** Uncompressed 10-bit 4:2:2 (v210) in a MOV. Very large files: about 2.7 bytes per pixel per frame. |
| `rawvideo` | `.avi` | yes | FFmpeg | **Uncompressed RGBA AVI.** Raw pixels, 4 bytes per pixel per frame: a 1080p second is about 200 MB. Few players read it. |
| `h264-crf` | `.mp4` | no | FFmpeg | **H.264 FFmpeg quality.** H.264 by constant quality (CRF 18, medium preset): the file size follows the picture. No bitrate setting. |
| `h264-intra` | `.mp4` | no | FFmpeg | **H.264 all-intra.** H.264 with every frame a key frame: loops and scrubs frame-exactly in VJ and editing software. Larger files. |
| `hevc-crf` | `.mp4` | no | FFmpeg | **H.265 FFmpeg quality.** H.265 by constant quality (CRF 20, medium preset). |
| `hevc-intra` | `.mp4` | no | FFmpeg | **H.265 all-intra.** H.265 with every frame a key frame. Larger files. |
| `av1-ffmpeg` | `.mp4` | no | FFmpeg | **AV1 FFmpeg quality.** AV1 by constant quality, with SVT-AV1 when your FFmpeg has it, else libaom. Slow to encode. |
| `webm-alpha`, `webmalpha`, `vp9-alpha` | `.webm` | yes | FFmpeg | **WebM VP9 with alpha.** VP9 with transparency: needs a player that reads WebM alpha, such as a browser. |
| `gif` | `.gif` | yes | the app itself | **Animated GIF.** : a palette per frame (or one shared) of up to 256 colors, exact for pixel art, one transparent level. No sound. Files get large for photographic content. |
| `apng` | `.png` | yes | the app itself | **Animated PNG.** Full color and smooth transparency, loops forever, lossless. No sound. |
| `webp-anim` | `.webp` | yes | FFmpeg | **Animated WebP.** Small files with transparency, loops forever. No sound. |
| `avif-anim` | `.avif` | no | FFmpeg | **Animated AVIF.** Small files, loops forever; needs a player or browser that reads animated AVIF. No transparency, no sound. |
| `vp8` | `.webm` | no | FFmpeg | **VP8 WebM.** Older open format. |
| `mpeg2` | `.mpg` | no | FFmpeg | **MPEG-2 MPG.** Legacy format for old players and DVD tools. |
| `mpeg4` | `.avi` | no | FFmpeg | **MPEG-4 AVI.** Legacy MPEG-4 part 2 in an AVI. |

#### Pictures and image sequences (`--format`)

| `--format` | File | Alpha | Written by | Notes |
| --- | --- | --- | --- | --- |
| `png-image` | `.png` | yes | the browser | **PNG.** Lossless, with transparency. Works everywhere. |
| `webp` | `.webp` | yes | the browser | **WebP.** Small files with transparency; the Quality setting applies. |
| `jpeg`, `jpg` | `.jpg` | no | the browser | **JPEG.** Small files, no transparency (the picture is placed over black); the Quality setting applies. |
| `avif` | `.avif` | yes | the browser | **AVIF.** Very small files with transparency. Offered only where the browser can encode it; the Quality setting applies. |
| `qoi` | `.qoi` | yes | the app itself | **QOI.** Lossless and very fast to write, with transparency. Few programs read it yet. |
| `tiff`, `tif` | `.tif` | yes | the app itself | **TIFF.** TIFF, 8-bit with transparency, deflate compression. |
| `tga` | `.tga` | yes | the app itself | **TGA.** Targa with transparency, run-length compressed. |
| `bmp` | `.bmp` | no | the app itself | **BMP.** Windows bitmap, 24-bit, no transparency (the picture is placed over black). |
| `exr` | `.exr` | yes | the app itself | **OpenEXR.** Half-float colors above 1.0 are kept, with transparency; zip compressed. Written linear (the sRGB curve removed), as compositing programs expect. Only graphs that produce high-range values gain anything over 8-bit. |
| `hdr` | `.hdr` | no | the app itself | **Radiance HDR.** RGBE colors above 1.0 are kept, no transparency. Written linear (the sRGB curve removed). Only graphs that produce high-range values gain anything over 8-bit. |
| `tiff16` | `.tif` | yes | the app itself | **TIFF 16-bit.** 16-bit TIFF with transparency, deflate compression. The values are the picture as shown (display encoded, clipped to 0..1). |
| `dpx` | `.dpx` | no | FFmpeg | **DPX.** DPX 10-bit, no transparency. |
| `ico` | `.ico` | yes | the app itself | **ICO icon.** Windows icon holding the picture at 16 to 256 pixels (pixel art is enlarged with hard pixels). |
| `ppm` | `.ppm` | no | the app itself | **PPM.** Plain portable pixmap, no transparency (placed over black). Readable by nearly every tool. |
| `jp2` | `.jp2` | yes | FFmpeg | **JPEG 2000.** JPEG 2000 with transparency. |

#### Sound only (`--format`)

| `--format` | File | Alpha | Written by | Notes |
| --- | --- | --- | --- | --- |
| `wav32f`, `wav32` | `.wav` |  | the app itself | **WAV 32-bit float.** Uncompressed, exact. |
| `wav24` | `.wav` |  | the app itself | **WAV 24-bit.** Uncompressed studio quality. |
| `wav`, `wav16` | `.wav` |  | the app itself | **WAV 16-bit.** Uncompressed CD quality. |
| `aiff24` | `.aiff` |  | the app itself | **AIFF 24-bit.** Uncompressed, for Apple and studio software. |
| `aiff`, `aif` | `.aiff` |  | the app itself | **AIFF 16-bit.** Uncompressed, for Apple and studio software. |
| `flac24` | `.flac` |  | the app itself | **FLAC 24-bit.** Lossless and about half the size of WAV. |
| `flac` | `.flac` |  | the app itself | **FLAC 16-bit.** Lossless and about half the size of WAV. |
| `aac` | `.m4a` |  | the browser | **AAC M4A.** Small files that play everywhere. |
| `webm-opus`, `webm` | `.webm` |  | the browser | **Opus WebM.** Small, high quality sound in a WebM file. |
| `mp3` | `.mp3` |  | FFmpeg | **MP3.**  |
| `opus` | `.opus` |  | FFmpeg | **Opus OGG.**  |
| `vorbis` | `.ogg` |  | FFmpeg | **Vorbis OGG.**  |
| `alac` | `.m4a` |  | FFmpeg | **ALAC M4A.**  |
<!-- formats:cli:end -->

The audio that goes with a container is chosen for you (MOV and AVI: PCM, MKV: FLAC, WebM: Opus, MP4: AAC; GIF, APNG, WebP and AVIF carry no sound). MOV files the app writes itself carry 16-bit PCM when the graph has sound. They are written as they are made (the index goes at the end of the file), so a 4K HAP export needs memory for one frame, not for the whole file.

The CLI asks the FFmpeg it uses (`ffmpeg -hide_banner -encoders`) which encoders it has. A codec whose encoder is missing stops before rendering with a message naming the encoder (for example `DXV-compatible needs the "dxv" encoder, which this FFmpeg does not have`). `--bitrate` is used only by `h264`, `hevc`, `vp9`, `av1`, `webm-alpha`, `vp8` and `mpeg2`.

To check what your machine really writes, `node scripts/check-formats.mjs --ffmpeg <an ffmpeg to read the files with>` exports a tiny clip, still and sound file in every format that is available here, through this renderer, and validates each file: it decodes, frame count, size, sound, alpha, and the picture against the PNG export of the same frame. (`scripts/check-ffmpeg-codecs.mjs` does the FFmpeg arguments only.)

Formats with alpha receive **straight** (non-premultiplied) RGBA. Formats without alpha (HAP, HAP Q, Motion JPEG, JPEG, BMP, PPM, Radiance HDR, the H.26x and VP codecs) get the picture composited over black. OpenEXR and Radiance HDR are written **linear** (the sRGB curve is removed first) and keep values above 1.0; 16-bit TIFF keeps the picture as shown. Only a graph that produces values above 1.0 gains anything over 8 bits.

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

**For VJ software (Resolume)**

```
rsmps render loop.rsmps.json --codec dxv --out ./video     # DXV-compatible, no transparency
rsmps render loop.rsmps.json --for vj --out ./video         # DXV-compatible, else ProRes-compatible 422 HQ
```

Test the file in Resolume before a show; ProRes-compatible is the safe alternative.

**PNG sequence with alpha**

```
rsmps render fx.rsmps.json --kind sequence --out ./frames        # frames/fx/fx_0000.png ...
rsmps render fx.rsmps.json --kind sequence --set Out.name="shot_{frame}" --out ./frames
```

**Sprite sheet for Godot**

```
rsmps render walk.rsmps.json --kind spritesheet --set Out.columns=8 --set Out.padding=0 --out ./godot
```

Writes `walk.png` and `walk.json` (`frameWidth`, `frameHeight`, `columns`, `rows`, `padding`, `fps`,
per-frame rects). In Godot use `Sprite2D` with `hframes = columns`, `vframes = rows` (or an
`AnimatedSprite2D` / `SpriteFrames` "Add Frames from Sprite Sheet" with the same grid); set
`Out.scale` to a whole number for crisp pixel-art enlargement and use `Nearest` texture filtering.

## Notes and limits

- Text nodes cannot rasterize fonts headlessly: they render empty (a warning is printed).
- Video input is decoded by one long-lived ffmpeg process per video, back-pressured; a backward seek
  (for example a looping video) re-spawns it with `-ss`.
- Rendering is single-GPU and sequential (`final` quality, proxy 1); there is no `--jobs`.
- Plugins are loaded with a dynamic `import()`; a `.js`/`.mjs` module exporting plain node definition
  objects needs no imports from the repo (`defineNode` is the identity function).
