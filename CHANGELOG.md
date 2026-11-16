# Changelog

All notable changes to RipScorpy Media Processing Suite (formerly PixelArtify Studio) are documented here.

## [0.5.1] - 2026-11-16

### Added

- Desktop app: an update notice. Once a day (and from File > Check for updates...) it asks GitHub whether a newer release exists and shows a small dismissible notice with What's new, Get it and Skip this version. Nothing is downloaded or installed, nothing but the request itself is sent, and it can be turned off in the About dialog.

## [0.5.0] - 2026-11-16

### Added

- **Media Timeline** node: a small video editor inside the graph. Wire in any number of picture and sound sources, arrange
  them as clips on tracks (move, trim, split, fades, cross-dissolve) and get one picture and one sound output. It can set
  the length of the whole project.
- **Custom Shader** node: write a WGSL effect in the inspector, with examples, wire-able sliders and compile errors shown
  on the node.
- **Recolor** node: fill (a black logo becomes white, transparency kept), ink on paper, swap one colour, duotone.
- 3D Object: "Custom model…" in the shape list loads a .glb, .gltf or .obj; the primitives stay the default.
- Pixelate takes a mask and can keep the source size. Dither and Quantize have a Pixel size, so a masked or tracked
  region of full-resolution footage is dithered on a coarse grid in one node.
- Cache / Bake: bake a node or a selection to stored frames from the inspector, the selection toolbar, the context menu
  or Ctrl+Shift+B; baked regions are dimmed and marked stale when something upstream changes.
- Safe mode and crash recovery: after an unclean exit the app starts with rendering paused and offers to undo the last
  change or open a backup. Rolling backups per project (File > Backups), a Pause rendering switch, an error screen
  instead of a blank page, and in the desktop app a reload-in-safe-mode path when the window or GPU process dies.
- Memory popover with a real breakdown, a RAM budget and cache quality.
- CLI: `print` output kind. Touch: pinch-zoom and two-finger pan on the graph. About dialog.

### Fixed

- Any edit anywhere dropped every cached playback frame; only edits that feed the viewed node do now.
- Heavy graphs never filled the playback cache, so loops re-rendered on every pass.
- Tracking repeated detection for frames it had already analysed.
- Pixel Sort used several gigabytes of GPU memory at 4K.
- Dither on masked regions ran per source pixel (slow and too fine).

### Changed

- A version tag now publishes a source-only GitHub Release; desktop installers are built by a manually started workflow.
- README showcase uses the author's own footage and scans.

## [0.4.0] - 2026-11-15

A ground-up rewrite. Graphs and presets saved by earlier versions do not load.

### Changed

- New engine: every node is a self-contained file that receives real data on its sockets and returns real data. Node order
  is honoured everywhere, including on video. The old fixed pipeline is gone.
- Rendering runs on a single WebGPU device; WebGL2 and the CPU fallback are removed. WebGPU is required.
- Lengths are authored in unit pixels and scaled per image, so mixed-resolution batches and the playback proxy match.
- Animation loops by construction when Loop is on; nothing animates by default.
- New interface generated from node definitions: categorised add menu, inline controls on nodes, built-in colour picker,
  Palette Studio, rebindable shortcuts and per-node hotkeys, layer lists, chain insertion.

### Added

- More than 160 nodes across Generate, Color, Filter, Stylize, Pixel Art, Transform, Composite, Mask, Layers, Detect & Track,
  Time, Math, Audio Source, Audio Effects and Synth & MIDI.
- Audio and MIDI pipeline in the same graph: microphone, pitch to MIDI, synths, effects, mixing; sound can drive any
  number parameter.
- Camera node (perspective, orthographic, isometric, fisheye, panoramic, cylindrical) for 3D objects.
- Subject mask, edge-fill inpainting, layer splitting and looping parallax.
- Detect & Track nodes with regions-to-mask, overlays, trails, follow-crop and stamping.
- Print sheets with machine-readable markers, and a Scan tab that rebuilds frames from photos of the printed sheets.
- Headless CLI on the same engine, with PNG sequences and ProRes 4444 with alpha.
- Plugins are single-file node definitions, stored in the browser and restored on reload.
- Safe mode (`?safe`) to open a project without rendering.

### Fixed

- The last group of dither algorithms (pattern, palette-blend, Riemersma), blue noise and Shiau–Fan were incorrect and
  have been rebuilt.

### Removed

- The old engine (`src/core`), interface (`src/app`) and CLI.

## [0.2.1] - 2026-11-13

### Fixed

- Self-contained Animate/Timeline graphs no longer ask for a Media input when
  rendering animation. The Output inspector now shows **Render animation** and
  renders the composited node tree directly; the video-input button is hidden
  when no video source exists. The video button also delegates to the animation
  renderer if a self-contained animation is present.
- Animation export estimate and output frame count now follow the Animate or
  Timeline fps.

## [0.2.0] - 2026-11-13

### Added

- **Background node** — solid colour, linear/radial gradients, checkerboard,
  stripes, grid, dots and noise. Connect media to place the pattern behind it,
  or use it as a standalone generated image.
- **3D object node** — cube, sphere, cylinder, cone, torus and pyramid rendered
  with an orthographic camera, z-buffer and Lambert shading. Rotate, move,
  scale, zoom and light the object; composite it over media or a background.
- **Animate node** — formula-driven continuous motion with a Motion output.
  Drive 3D objects and backgrounds with `t`, `frame`, `lt`, trig, interpolation
  and clamping functions. Includes duration/fps/loop controls and horizontal or
  two-axis wrap modes, plus a viewer timeline with play/pause and scrubbing.
- **Timeline node** — stretches still media across a chosen duration and frame
  rate so animated effects, grain and overlays can play over an image.
- **Retime node** — stop-motion sampling down to a lower frame rate, and a
  block-matching optical-flow mode that interpolates new frames for smoother
  output. Applied during video/spritesheet export; stop motion also previews
  with a quantised video clock.
- **Animated film grain and noise displacement** — enable **Animate** on either
  effect in the Pre-process or Post-process inspector.
- **Timeline animation export** — the Output inspector can render Animate or
  Timeline graphs to video, spritesheet or both.
- **Node groups** — Ctrl/Cmd-click nodes, then group them. Groups can collapse
  to a single box with combined input/output dots, be duplicated as a whole
  (including internal wires and input assets), or be ungrouped.
- **GPU layer compositing** — the final Compose layers blend now runs through a
  WebGL2 ping-pong compositor with automatic CPU fallback.
- **GPU edge maps** — Sobel/chroma gradients and non-maximum suppression now run
  on the GPU inside the sampler.
- **Preset CPU warnings** — the preset browser shows an amber `!` and the exact
  CPU-heavy stages used by a preset.
- **Direct-canvas playback** — video and animation playback paint straight to
  the preview canvas without PNG encoding or a React render per frame.
- GPU layers badge and improved CPU warning text for layer inpainting and
  detail high-pass layers.

### Changed

- Processing before a generator is now baked before the generated pixels are
  added. A 3D object added near the end of a graph is no longer re-pixelated,
  dithered or post-processed by nodes that came before it; only downstream
  nodes affect it.
- Adding an Output node now makes it the active preview.
- Small-art working supersampling was reduced to 2×.
- Version bumped to 0.2.0.

### Fixed

- Playback freeze caused by `requestAnimationFrame` throttling when the page
  lacked focus.
- Duplicate React keys in the asset rail after applying presets.
- Stale preview image encoding during playback.
- Frame-rate and duration handling for stop-motion and interpolation exports.

## [0.1.0] - 2026-11-11

- Initial public release: node graph, edge-aware pixelation, palettes, dithering,
  preprocessing/postprocessing, layers and inpainting, magic mask tracking, GPU
  sampler/dither/resize/effects, presets, batch/video/spritesheet/A4 export,
  CLI and documentation.
