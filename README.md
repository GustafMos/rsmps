# RipScorpy Media Processing Suite (RSMPS)

[![CI](https://github.com/GustafMos/rsmps/actions/workflows/ci.yml/badge.svg)](https://github.com/GustafMos/rsmps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4cc9f0.svg)](LICENSE)

**A GPU node graph for making game assets in batches: images, video, animation and sound.**

RSMPS started as PixelArtify Studio, a pixel-art converter made for the game *Filmmaker Survivor*. It is now a general media
processing suite built like Blender's shader nodes or DaVinci Fusion: small nodes that receive data on their inputs and pass
results along their wires.

> MIT licensed · local-first · no account · no upload · your media stays on your machine.

**Live demo:** <https://gustafmos.github.io/rsmps/> · **Changelog:** [CHANGELOG.md](CHANGELOG.md)

---

## What it does

- **Real node graph.** Every node is a pure function of its inputs and settings. An effect placed after another processes
  that effect's result; there is no hidden fixed pipeline.
- **Batch by design.** Put many files in a Media In node and the graph runs once per file. Lengths are authored in unit
  pixels and scaled to each file, so a 480p and a 4K source get the same look.
- **GPU everywhere.** One WebGPU device; images stay on the GPU from decode to display. Results are cached per node and only
  nodes that read the clock re-render per frame.
- **One-click looping.** Turn on Loop and every built-in animator repeats exactly over the project duration. `Make Loop`
  cross-fades any footage into a seamless loop.
- **Pixel art.** Edge-aware pixelation, palettes (built-in, custom, extracted), 27 dither algorithms, palette swap, crisp upscale.
- **Masks, cut-outs and parallax.** Keys, subject mask, paint mask, inpainting that fills a cut-out from its edges, layer
  splitting and a looping parallax camera.
- **Detect & Track.** Blob, colour and motion detectors, a tracker, and `Regions to Mask` so any effect can be limited to
  tracked areas; HUD overlays, trails, follow-crop and sprite stamping.
- **3D generators with cameras.** Primitive objects with perspective, orthographic, isometric, fisheye, 360° panoramic and
  cylindrical cameras; each object can have its own.
- **Audio and MIDI in the same graph.** Microphone, audio files, pitch-to-MIDI, synths, compressor, EQ, delay, reverb and
  more, mixed by wiring. Sound can drive pictures: loudness, pitch and notes become numbers for any parameter.
- **Print and scan back.** Export animation frames as printable sheets with registration marks, draw on them, photograph
  them, and get the frames back aligned as an image sequence.
- **Plugins.** A plugin is one JavaScript file exporting a node definition; it appears in the menus like a built-in.

Node families (one file per node under `src/engine/nodes/`): Input, Output, Generate, Color, Filter, Stylize, Pixel Art,
Transform, Composite, Mask, Layers, Detect & Track, Time, Math & Utility, Audio Source, Audio Effects, Synth & MIDI.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. A browser with WebGPU is required (current Chrome, Edge, Firefox or Safari).

If a setting ever makes rendering hang, open `http://localhost:5173/?safe`: the project loads without rendering so you can
fix it, then remove `?safe`.

### Working in the graph

- **Shift+Space** or **Shift+A**: search and add a node. With a node selected, the new node is inserted into its chain.
- Drop a wire from one output onto another output to create a Merge with the held one on top.
- Click a colour to open the built-in picker; **Palettes** opens Palette Studio (harmony wheel, ramps, extract from image).
- Shortcuts are listed under **?** and can be rebound; any node type can be given its own hotkey.

## Command line

Batch rendering without a browser, including formats browsers cannot encode (ProRes 4444 with alpha):

```bash
npm run cli -- render my-graph.rsmps.json sprites/ --out out/
```

See [docs/CLI.md](docs/CLI.md).

## Documentation

| | |
| --- | --- |
| [docs/ENGINE.md](docs/ENGINE.md) | How the engine works and how to add a node (start here to contribute) |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Writing and installing plugins |
| [docs/CLI.md](docs/CLI.md) | Command-line rendering |
| [docs/PRINT_AND_SCAN.md](docs/PRINT_AND_SCAN.md) | Printing frame sheets and scanning them back |
| [src/engine/audio/README.md](src/engine/audio/README.md) | Audio and MIDI nodes, and driving pictures with sound |

## Layout

```text
src/engine/   the engine: node contract, evaluator, GPU helpers, all nodes, audio
src/io/       media library, playback, export, plugins, project files, print/scan
src/ui/       the React interface (generated from node definitions)
src/cli/      headless renderer
```

## Tests

```bash
npm run check   # typecheck + all tests
```

Node tests run on the real GPU through headless WebGPU, so a passing test also proves the shader compiles.

## Known limitations

- WebGPU only; there is no fallback for browsers without it.
- The microphone and MIDI devices are live-only. For export, record the take and use it as an audio file.
- ProRes is available from the command line only.
- Subject extraction and the tracker are classical methods, not neural networks: expect touch-ups when subject and
  background share colours, and occasional id swaps when tracked objects cross.
- Error-diffusion dithers fall back to an ordered pattern on very large images.

## Credits

RSMPS stands on the shoulders of open-source work. See [CREDITS.md](CREDITS.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full links and licenses.

Special thanks to:

- **Yogthos** — [pixel-mosaic](https://github.com/yogthos/pixel-mosaic) (MIT), the edge-aware pixelation inspiration.
- **Robert Kist** — [Ditherista](https://github.com/robertkist/ditherista) and [libdither](https://github.com/robertkist/libdither), the dithering catalog inspiration.
- **Vanilagy** — [Mediabunny](https://mediabunny.dev) (MPL-2.0), browser media I/O.
- **Björn Ottosson** — [OKLab](https://bottosson.github.io/posts/oklab/) (MIT).
- **MaxK1920** — [stardetect](https://github.com/MaxK1920/stardetect), the inspiration for the Detect & Track nodes (no code is shared; RSMPS uses its own classical detectors).
- The pixel-art community behind the PICO-8, Sweetie 16, Endesga 32, DawnBringer 16 and Game Boy palettes.

This project is not affiliated with Adobe. Adobe Color inspired Palette Studio.

---

## Support my cats

If you want to support me and my projects, help me fund tasty anti-allergenic food for my two cats, **Carla-Mittersteig von Starhemberg** and **Rosa-Luxemburg von Starhemberg**. <3 Thank you!

**Ko-fi:** <https://ko-fi.com/ripscorpy> · [FUNDING.md](FUNDING.md)

---

## License

MIT. See [LICENSE](LICENSE). Third-party dependencies retain their licenses; Mediabunny is MPL-2.0 and is used unmodified as a dependency.
