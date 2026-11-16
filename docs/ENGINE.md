# RSMPS engine v2 — how to build on it

Read this before touching `src/engine`. It is short on purpose.

## The idea

A graph is a set of **nodes** joined by **wires**. A node is a pure function:

```
outputs = render(params, values on its input sockets, frame context)
```

A node knows nothing else. It cannot see the graph, other nodes, the UI, files or the DOM.
Everything it may use arrives through `ctx`. Data really flows through wires: an effect placed
after another effect processes that effect's result. There is no hidden global pipeline.

```
src/engine/
  types.ts        the contract (sockets, params, ctx, graph document)   KERNEL
  define.ts       defineNode(), Registry, connection rules              KERNEL
  engine.ts       lazy cached evaluator                                 KERNEL
  graph.ts        pure graph-editing helpers                            KERNEL
  gpu/gpu.ts      one device, texture pool, pass() helper               KERNEL
  gpu/prelude.ts  WGSL helpers available in every shader                KERNEL
  testing.ts      test harness (real GPU, headless)                     KERNEL
  nodes/<category>/<id>.node.ts     one file per node, auto-registered
  nodes/<category>/<id>.test.ts     its test
  lib/            shared helpers used by several nodes
  audio/          stream-domain engine (audio + MIDI)
src/io/           files, decode, playback, export (implements Host)
src/ui/           React UI, generated from node definitions
src/cli/          headless renderer
```

**Do not edit KERNEL files** unless your task says so. If the kernel is missing something, work
around it and say so in your report.

## Adding a node = adding one file

Create `src/engine/nodes/<category>/<id>.node.ts` with a default export. Nothing else to register:
the add-menu entry, search, inspector controls, sockets, node colour and docs come from the definition.

```ts
import { defineNode } from '../../define';

export default defineNode({
  id: 'vignette',                       // kebab-case, never rename once shipped
  title: 'Vignette',
  category: 'stylize',                  // see CATEGORIES in types.ts
  description: 'Darkens the corners.',
  keywords: ['corner', 'lens'],
  inputs: { image: { type: 'image', required: true } },
  outputs: { image: { type: 'image' } },
  maskable: true,                       // kernel adds Mask input + Mix slider and applies them
  params: {
    amount: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    radius: { type: 'number', default: 300, min: 0, max: 2000, unit: 'px' },
  },
  render(ctx) {
    const image = ctx.gpu.pass({
      size: ctx.in.image,               // same size and unit as the input
      textures: { src: ctx.in.image },
      uniforms: { amount: ctx.params.amount, radius: ctx.params.radius },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
        let c = textureSampleLevel(src, smpNearest, uv, 0.0);
        let d = distance(px, u.size * 0.5);
        return c * (1.0 - u.amount * smoothstep(u.radius, u.radius * 2.0, d));
      }`,
    });
    return { image };
  },
});
```

Exemplars to copy from (read the one closest to your node first):

| Pattern | File |
| --- | --- |
| one-pass filter | `nodes/color/color-adjust.node.ts` |
| multi-pass filter with a length | `nodes/filter/blur.node.ts` |
| animated generator that loops | `nodes/generate/noise.node.ts` |
| two images of different sizes | `nodes/composite/merge.node.ts` |
| source reading assets, batch aware | `nodes/input/media-in.node.ts` |
| sink | `nodes/output/image-out.node.ts` |

## Rules (each one exists because breaking it causes a real bug)

1. **Images are GPU textures**: RGBA8, sRGB-encoded, **premultiplied** alpha, row 0 at the top.
   In a shader, `unpremul()` before colour maths and `premul()` before returning.
   Sample with `textureSampleLevel(tex, smp | smpNearest, uv, 0.0)` (never `textureSample`).
2. **Masks** are the same storage with coverage in `.r`. Return them with `ctx.gpu.passMask`.
3. **Lengths use `unit: 'px'`** and arrive in `ctx.params` already converted to texels of the node's
   first image input (or the canvas). Never multiply by resolution yourself. Never declare a length
   without `unit: 'px'`. Positions and sizes relative to the frame use `unit: 'norm'` (0..1).
   This is what makes a batch of 480p and 4K files, and the low-res playback proxy, look identical.
4. **Output `unit`**: pass the input image as `size` and it is copied. If you change resolution,
   scale it: `unit: src.unit * (newWidth / src.width)`. A node that defines a new pixel grid
   (Pixelate) sets `unit: 1`, so downstream lengths become art pixels.
5. **Animation must loop by construction.** Drive motion only from `ctx.time.phase` (0..1 over the
   project duration) with whole-number `cycles` params: `sin(phase * TAU * cycles)`,
   `fract(phase * cycles)`, `loopNoise(p, phase, speed)`. Never animate from `ctx.time.seconds`
   or `frame` (only source/time nodes that read footage may use seconds). Read `ctx.time` only when
   actually animating: reading it makes the node re-render every frame.
6. **Do not implement masking or mix.** Set `maskable: true`.
7. **No CPU pixel loops** unless there is no GPU formulation; then set `cpu: true`, use
   `ctx.gpu.read` / `ctx.gpu.upload`, and keep it to analysis on small images where possible.
   Error-prone-but-possible GPU work (compute shaders via `ctx.gpu.device`) is welcome.
8. **Optional inputs can be null**; `required: true` inputs never are (the kernel skips the node).
   Optional textures in `pass()` may be passed as `null`; guard the WGSL that uses them with a
   JS template condition.
9. **No state.** No module-level variables that change, no caches of your own: the kernel caches
   results by params + inputs. Same inputs must give the same output (use `seed` params + hashes,
   never `Math.random()`).
10. **Every number/color/palette param is also an input socket** automatically. Do not add separate
    inputs for values that are params.
11. Nodes never import from `src/ui`, `src/io` or `src/cli`.
12. Share code through `src/engine/lib/` or by exporting a helper from the node that owns it
    (e.g. `gaussianBlur` in `blur.node.ts`). Do not copy shaders between files.

## Testing (required for every node)

`<id>.test.ts` next to the node, using the harness. Tests run on the real GPU: `npx vitest run src/engine/nodes/<category>`.

```ts
import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('vignette darkens corners, not the centre', async () => {
  const t = await harness();
  const out = await t.run('vignette', { amount: 1, radius: 10 }, { image: t.solid(64, 64, [200, 200, 200, 255]) });
  const px = await t.pixels(out.image as never);
  expect(px.at(32, 32)[0]).toBe(200);
  expect(px.at(0, 0)[0]).toBeLessThan(120);
});
```

Each node needs at least: (a) it does what it says on a small synthetic image (assert pixels),
(b) alpha/transparent input survives where relevant, (c) for anything with a length: same result at
2× resolution with `unit` 2 (see `kernel.test.ts`), (d) for anything animated: `t.loopCheck` gives
`seam === 0` and `motion > 0`. Shader compile errors surface as test failures, so a passing test
also proves the WGSL is valid.

## Time, batch, proxy

- `ctx.time`: `phase`, `frame`, `seconds`, `fps`, `duration`, `loop`.
- `ctx.pull(input, { seconds })` re-evaluates an input at another time (echo, retime, loop cross-fade).
- Batch: the graph runs once per item. `media-in` picks its asset by `ctx.item.index`. Nodes never
  see lists of images.
- Proxy: during playback the engine may run at reduced resolution. Nodes need do nothing: sources
  decode smaller, `unit` shrinks, lengths follow.

## Audio and MIDI (stream domain)

Audio nodes use the same `defineNode`, the same graph, categories `audio-source`, `audio-fx`,
`synth`, and sockets `audio` / `midi`. Instead of `render` they provide `audio`: a pure DSP kernel
that processes blocks of samples. The whole audio graph runs inside one AudioWorklet in real time
and in a plain loop for export and tests, from the same code. See `src/engine/audio/README.md`.

## Plugins

A plugin is a single ES module with no imports whose default export is a node definition (or an
array of them) — the same object `defineNode` takes, with an id like `myname/glitch`. It is loaded
at runtime, validated by `Registry.register`, stored in the browser, and from then on is
indistinguishable from a built-in node. See `docs/PLUGINS.md`.

## Rules added after the first build-out (each from a real bug)

13. **Scaling or repositioning an image inside another: use `sampleCrisp(tex, uv, texelsPerPixel)`** from the
    prelude, never plain linear sampling. Enlarged pixel art must stay sharp (a pixelated layer in Stack came out blurred).
14. **Nothing animates by default.** Spin, evolution, scroll and similar params default to 0; a freshly added node
    is still until the user asks for motion (two cubes "both spinning" was a default spin of 1). Particles are the exception.
15. **Set `softMax` on every number param whose cost grows with its value** (resolutions, counts, radii, iterations).
    The UI stops sliders there and asks before applying a larger typed value. `max` stays the hard limit.
16. **Never do unbounded work in one GPU submit.** Sequential compute passes must be split into bounded submits and
    refuse or fall back above a pixel budget; check output sizes against `device.limits.maxTextureDimension2D` and a
    memory budget and throw a readable `Error` (it is shown on the node). A 9.7 s error-diffusion pass froze the app.
17. **Analysis that should run once uses a `lazy` input** and `ctx.pull(input, { seconds })` at a fixed time
    (palette extraction). Per-frame CPU analysis must be an explicit opt-in param.
18. **A node must produce a sensible result with only its obvious inputs wired.** Make secondary inputs optional with
    a built-in fallback (Dither without a palette wire output nothing).
19. **WGSL reserved words as uniform or texture names fail silently** (e.g. `target`, `size` is reserved by the kernel).
    Use descriptive names and assert pixels in the test.
20. **Wire order of a `multi` input is meaningful** (first = bottom layer); never sort inputs.
21. New socket types beyond the originals: `regions` (tracked boxes), `camera`; param type `device`; node flags
    `playable`, `maskable`. Stream nodes can publish numbers to the picture side with `io.signal` (see audio/README.md).

## GPU memory (rules added by the memory pass)

Measured before the pass: one Pixel Sort on a 4K image held **5.9 GB** of textures for a moment (78 passes of a 67 MB
texture, all alive until the node's render returned), and the app created ~7,000 buffers, ~15,000 views and ~6,600
bind groups in a 3-minute session. Firefox frees the memory behind a dropped wrapper only when it garbage-collects it,
so those peaks and that churn show up there as gigabytes that the memory governor never saw.

22. **Multi-pass loops recycle.** `const prev = rec; rec = gpu.pass(... rec ...); gpu.recycle(prev);` Temporaries that
    a loop produced are handed back with `gpu.recycle(image)` as soon as the next pass has consumed them; otherwise
    every iteration stays alive until `render` returns. `gpu.stats().worstScope` names the node that held the most.
23. **Never create GPU objects yourself.** No `device.createBuffer/createTexture` in `src` outside `gpu/gpu.ts` (a test
    enforces it). Use `gpu.scratch(size, usage, label, { clear })` + `gpu.releaseScratch` for per-render buffers (pooled,
    byte-capped, reusable without any fence because queue operations are ordered), `gpu.scratchTexture` for attachments,
    `gpu.createBuffer/destroyBuffer` for long-lived buffers (vertex/index data: keep a small LRU and destroy on eviction),
    `gpu.view(texture)` instead of `texture.createView()`, `gpu.computePipeline(label, wgsl)` instead of a module-level
    cache. Everything is counted in `gpu.stats()` / `Io.memory()` by category.
24. **Numbers go in uniforms, never in WGSL text.** Every distinct shader string is a pipeline that is never freed.
    `src/engine/__tests__/pipeline-bounds.test.ts` renders every node with moved sliders and fails on a new shader.
    The pipeline cache is an LRU with a cap anyway.
25. **A pass allocates nothing.** Uniforms are written into a pooled buffer, views are cached per texture, bind groups
    are cached by (pipeline, uniform buffer, texture identities) and dropped when a texture dies. After warm-up an
    animated chain creates no buffer, texture, view or pipeline (`src/engine/gpu/memory.test.ts`).
26. **GPU work is throttled**: an evaluation waits (`gpu.throttle`) while more than two frames of work are queued, so an
    export loop cannot queue unbounded work.
27. **RAM tier.** The engine can demote an expensive static result (render time above a threshold that adapts to the
    measured restore cost) to an injected `ColdStore` instead of recomputing it after eviction (`Engine.setColdStore`).
    The store must be lossless. `Engine.coldStats()` reports demoted / promoted and render time saved vs restore time.

### Cache / Bake node

`cache` (category time) passes its input through until the user bakes it (`Io.bake.bake`). Baked, it serves a stored
sequence and its `lazy` input is never evaluated. `ctx.inputSignature('image')` is the structural signature of everything
upstream (no evaluation, independent of proxy and frame); the node compares it with the one stored at bake time and reports
`stale`. The hidden `baked*` params are written by the UI from `BakeResult.params`.
Baking is a **process** (see "Process mode" under Pending rules): the node's `process.run` is the bake job, `Io.bake` is a thin layer over `Io.processes`, and the `baked*` params are the node's result handle.
`groupOutputWires(graph, nodeIds)` / `groupOutputs(...)` in `graph.ts` list the wires that leave a set of nodes: that is
where cache nodes go to bake a whole group.

### Cache keys, eviction and the player's frame cache

- A node result is keyed by node type + resolved params + the keys of its inputs + unit/canvas size/quality, plus the INTEGER frame when
  the node read the clock (`ctx.time`) and the item when it read the item. Never seconds (float noise), object identity or wall-clock time.
  Keys and structural signatures are built with `stableStringify` (sorted keys): deep-equal params in a different key order give the same key.
  `src/engine/__tests__/caching.test.ts` asserts, per scenario, exactly which nodes render (`renderedNodes` / `RenderTally` in testing.ts).
- Time-keyed entries are limited per node (`TIMED_KEEP`, widened for nodes that are `pull`ed over a span). Entries of `cpu: true` nodes that have
  a non-picture output (detect, track: regions, numbers) additionally leave a weightless "lite" record keyed by structure + frame
  (`liteKeyOf`), so a consumer that only reads such an output (Track looking back over 100+ frames) finds the earlier detections without
  evaluating the node's inputs or repeating a GPU readback. A consumer reading the node's picture or mask output is not served by it.
- Eviction (between evaluations only): lowest value per byte goes first, where value = render time (x 0.25 for time-keyed entries) / (1 + age).
  An expensive static result outlives cheap or per-frame ones; what the previous evaluation used is not a candidate unless the hard budget
  demands it; RAM spill (`demote`) is tried before an expensive entry is dropped.
- The player's RAM frame cache is keyed by `renderHash`: project settings + the viewed node and everything UPSTREAM of it (+ the active
  Output). Editing another branch keeps the finished frames. While playing, up to 4 frames wait to be packed, so even a heavy graph fills the
  cache during its first pass and the second pass is served from it with zero node renders.

### The art-grid rule

28. **Art grids.** `ImageValue.cell` (optional, >= 1, may be fractional) says "this image is a crisp (nearest) upscale of an art
    grid; one art pixel covers `cell` texels". Absent or 1 = a normal image. It is set by Pixelate (when it keeps the source size:
    `Keep source size`, or any Mask / Mix < 1) and by the kernel's `applyMask`, which crisp-upscales a maskable node's smaller output
    to the input size before blending and stamps `cell = inputHeight / outputHeight`. Per-pixel pixel-art nodes (Dither, Quantize,
    Palette Swap, Mosaic) must work on the grid when `cell > 1`: wrap the effect in `withArtGrid(gpu, image, pixelSizeTexels, (art, grid) => ...)`
    from `lib/art-grid.ts`. It point-samples the input at cell centres down to `round(size / cell)`, runs your function on that
    small image, crisp-upscales the result back to the input size and keeps `cell`. Convert any length you use with `grid.toArt(texels)`.
    Never read `image.cell` yourself, never allocate the grid image yourself, and return an image of exactly the art size. Dither and
    Quantize also take the shared `PIXEL_SIZE_PARAM` (`pixelSize`, 0 = follow the image): > 0 forces a grid of that many unit pixels,
    so full-resolution footage + a tracked mask gives chunky, fast dither in one node. The mask blend still runs at full input
    resolution, so mask edges stay as authored. Nodes that do not preserve the grid (blur, warp...) simply do not copy `cell`.

## Editing nodes (Media Timeline)

29. **Evaluate only what is shown.** A node that picks among several picture sources (an editor, a switcher) declares the input
    `multi` AND `lazy` and fetches each source it needs with `ctx.pull('clips', { seconds, wire })`. `wire` is the position of the
    wire among that input's wires (wire order, as for layer inputs). Sources it does not pull are never evaluated: there is a test that
    counts renders (`nodes/time/media-timeline.test.ts`). The input is `lazy`, so the node itself reads the clock and renders per frame.
30. **A node can set the project length** with `projectLength?(params) => seconds | null` on its definition. Only
    `effectiveDuration(graph, registry)` / `withEffectiveDuration` in `graph.ts` reads it: the editor store applies it to
    `project.duration` on every commit and load (so player, exporter and UI all see one number), and the CLI applies it before its
    `--duration` override. Do not compute the length anywhere else. The result is a whole number of frames, at least one frame.
31. **Per-wire audio**: a kernel with `perWire: true` also gets `io.inWires[name]`, one block per wire in wire order (`io.in` is still
    the sum). Use it to gate, fade or route wires individually; do not use it to mix (the host already sums).
32. **Edits are pure data with pure helpers** (`lib/media-edit.ts`): which clips are active, local time, fades, moves, trims and splits
    are plain functions shared by the node, its audio kernel, the editor UI and the tests. `lib/media-edit-graph.ts` keeps the clip
    sources in step with the wires (new wire = new clip at the end; removed or reordered wire = clips follow their source); the editor
    store calls it on every commit. A node that has both `render` and `audio` must also be listed in the glob of `audio/nodes.ts`
    (the audio worklet only imports what is listed there).

## Pending rules (to be numbered)

- **`ctx.pull(input, { proxy })` evaluates an input at another resolution.** `proxy` is ABSOLUTE (a factor of the full frame, the same number as `EvalRequest.proxy`; clamped to 0.05..1),
  not relative to `ctx.proxy`; it can be combined with `seconds`. The engine makes a sub-scope of the same evaluation with that proxy: canvas size (`proxySize` in `lib/proxy-size.ts`, the ONE
  rounding rule shared with the player's `scaleSize`), unit, source decoding and the structural-signature memo follow it; the node memo is per proxy and shared by every pull at that factor in the
  evaluation. Cache keys already contain the canvas size and unit, so a result made at factor X is found again by anyone who asks for X (a plain evaluation at that proxy, another Render Scale
  node) and a static upstream stays cached across frames. `ctx.canvasAt(proxy)` gives the canvas (width, height, unit) at a factor. Render Scale (`transform/render-scale`) is the user of it:
  it pulls its lazy input at `want` and enlarges the result to what the input would have been at `ctx.proxy` (same size by the canvas ratio, unit by the unit ratio). Composition rule:
  `scale` is absolute; `want = match ? min(scale, ctx.proxy) : scale`. So at export / paused (`ctx.proxy` 1) the look is exactly `scale`; during a coarser playback proxy "follow the preview" never goes finer
  than the scope (cheaper, a faithful approximation); nested Render Scale nodes do not multiply, the coarsest wins (an inner one that has nothing coarser to do passes the picture through with zero passes);
  `want == ctx.proxy` (100 %, or already that coarse) is a pass-through of the same texture. Known limit: the output size is predicted by the canvas ratio, so an upstream whose size does not follow the proxy
  (Pixelate's small art grid, a fixed-size source) is enlarged by that ratio rather than to its true full size; `mix` < 1 pulls the true picture too and then uses its exact size. The result of a pull
  at another proxy is a normal retained value (valid during `render`).
- **Playback preview = the whole graph at a proxy, enlarged by the viewer.** The player evaluates the graph with `EvalRequest.proxy` (levels 100 / 75 / 50 / 35 / 25 %), draws the small texture into a canvas of that size
  and the browser enlarges the canvas (CSS `image-rendering: auto` = bilinear below 100 % zoom, `pixelated` = nearest at 100 % and above). `Player.renderFullFrame()` ("Full res" in the viewer, Shift+R) renders the current frame once with
  proxy 1 (or the Output's pixel grid) and quality `'final'` and keeps it until the frame, graph or view changes or playback starts. The viewer's "Keep this look" adds a Render Scale node at the preview's factor, so the export matches.

- **Temporal recursion = bounded fold + `ctx.previous()`.** A node that feeds its own output back (video feedback, datamosh) is still stateless:
  define the result as a pure fold over a bounded window of input frames that depends only on the frame number, and set `usesPrevious: true`.
  `ctx.previous()` then returns this node's own first image output for frame - 1 when the engine still holds it (same node, params, upstream
  structure, size, quality, item), else null. Use it only where the fold satisfies `out[f] = step(in[f], out[f-1])` exactly, so cache and fold give
  identical pixels (test it: play forward on one engine, compare with a cold engine per frame). Make the window restart on frame-number boundaries
  (`start(f) = (floor(f / K) - 1) * K`), not sliding, or the identity breaks. Do not combine with `maskable` (the cached result is already mixed), and
  skip `previous()` when any param socket varies with time (`ctx.inputVaries(param)`). Index: `Engine.selfIndex`, bounded to 512 entries.
- **`ctx.inputVaries(input)`** says whether an input changes with time (`false` = a still: same picture every frame). Use it to skip pulls and
  not read `ctx.time` at all for static inputs, which keeps the node's own result static and cached. Valid after evaluation (normal inputs) or
  after the first `pull` (lazy inputs).
- **Slices in one pass.** The GPU layer has no texture arrays: bind up to 8 slices per pass (`lib/time-slices.ts`, `SLICE_GROUP`) and accumulate in
  rgba16float, so N slices cost ceil(N / 8) passes, and pull each distinct frame once.
- **Optical flow encoding** (`lib/optical-flow.ts`): rg = motion from the previous to the current frame as a fraction of image width / height per frame
  (right / down positive), b = luma of the current frame at flow resolution (reused through `ctx.previous()`), a = 1; rgba16float at the flow grid.

- **Many copies are one pass, one draw.** Duplicating nodes (Array, Scatter, Infinite Zoom, Kaleidoscope) inverse-map each output pixel into the few copies that can
  reach it (the cell it falls in plus a small neighbourhood, composited back to front) instead of drawing every copy. The neighbourhood size and every other number are uniforms,
  never WGSL text, so cost does not grow with the copy count and dragging a slider compiles nothing. Where exact inversion is impossible the node says so (Array with per-copy
  steps is exact up to 25 copies per axis, local beyond). Shared maths lives in `lib/copy-wgsl.ts`.
- **A loop test must look across the wrap.** The clock wraps (`phase` of the last frame + 1 is 0), so `t.loopCheck` returns `seam = 0` for anything. Use `seamRatio`
  from `lib/copy-testutil.ts`: it renders every frame of a short loop and compares the step across the wrap with the ordinary steps.
- **Whole levels / cells / spacings per loop.** Infinite Zoom (levels), Array (cells), 3D Array (spacings) take integer `cycles` params. A per-copy colour that travels with the copy
  only loops when its period divides the travel; offer a "colour follows the depth on screen" option so the loop can never break.
- **A node that draws geometry itself** (3D Array) creates its pipeline once per device (WeakMap, like `model-render.ts`), draws with `instance_index` and no instance buffer, uses
  the pooled scratch buffers / textures, caches its bind group per (uniform buffer, texture), and refuses counts above a stated cap with a readable error.
- **Per-copy time offset** needs no lazy input: `ctx.pull('image', { seconds })` works on a normal required input (as in Frame Echo). Bind a fixed number of slices (8) and pull each
  distinct moment once, never per copy.
- **Batch items are not visible to a node** (rule: nodes never see lists of images), so "each copy shows a different item" is done with a sprite sheet (columns x rows) in the
  input picture, not with the batch.

- **Colour grading is linear-light and gamut-aware, from one maths file.** `lib/color-math.ts` holds every constant and formula of the grading nodes (white
  balance, saturation, lift/gamma/gain/CDL, exposure, curves, colour spaces, `.cube` LUTs, the qualifier) as plain TypeScript, `lib/color-wgsl.ts` generates the
  matching WGSL (`COLOR_WGSL`, functions prefixed `cg_`) from the same constants, and the tests compare the GPU result with the TypeScript reference. A colour
  node says in its hint which space it works in. Saturation changes never clip: chroma is reduced toward the grey of the same lightness (`cg_gamutLC`). Curve and LUT data go
  through `gpu.dataTexture` (cached by content) and the tables are memoised by content in `color-math.ts`, so dragging a slider that is not a curve uploads nothing.
- **Analysis frozen at a chosen frame** (White Balance "Automatic") pulls the input at a fixed time, reads a tiny downsample back once, and memoises the estimate by
  (node id, `ctx.inputSignature`, frame, method, batch item): a pure memo of a pure function, so the cast never flickers and playback does not stall on a readback.
- **A new asset kind is three small edits**: the `accept` / `kind` unions in `types.ts` (`lut` was added for `.cube` files), `detectKind` + `probe` in `io/library.ts`, and
  `fileMatches` / `ACCEPT_*` / `isSourceFor` in the UI. The node reads the bytes with `host.assetBytes` and memoises the parse in a `WeakMap` keyed by the returned buffer.
- **Compute-based scopes** (`nodes/color/scope.node.ts`): decimate with one `gpu.pass`, count with an atomic compute pass into a pooled cleared scratch buffer, draw with a
  second compute pass into an `alloc`ed storage texture; both passes share one command encoder. The two bind groups are created per render (not cached): acceptable for a
  node that only renders when asked to be looked at.
- **Specks (dropouts, dust, scratches)** live in `lib/specks.ts`: `SPECK_PARAMS` (the "Dropouts / specks" group), `speckUniforms(params, { amount, unit, time })` and the WGSL `SPECKS_WGSL` (`spField` + `spApply`). Analog Video draws them inside its tape pass, the Specks node in one pass of its own. They are laid on scan lines of 2 unit pixels (resolution independent), hashed from (seed, flicker epoch, line, slot) so they loop by whole frame indices, and every setting is a uniform (no recompiles). Reuse it for any new "particles on the picture" effect instead of writing another hash-and-rectangle loop.
- **Boil / loop-friendly jitter**: a node that moves something by a hash of the frame (Paper / Texture Overlay) takes its pose from `frame mod poses` and reduces `poses` to a divisor of the project length (`lib/boil.ts` `wholeCyclePoses`), so the pattern repeats a whole number of times per loop and the seam is exact. Read the clock only when the effect is on (`boil > 0`), so a still texture stays cached.
- **Optional reference image input** (Remove Printed Guide `original`): sample it with the same `uv` (it may be another size); when it is not wired, bind the main image to the second texture slot and branch on a `hasOrig` uniform, so one shader serves both cases (no recompiles, rule 24).

- **The 3D family** (3D Object, Image to 3D, SDF 3D; `lib/gen-3d.ts`, `gen-deform.ts`, `gen-sdf2d.ts`, `gen-material.ts`). Raymarched members generate ONE shader per STRUCTURE
  (which shapes, which Deform features, which pictures are wired, which Material model) and push every number through uniforms, so a slider never compiles anything (a feature
  that is off is not in the shader at all; the first non-zero value switches it on once). They share the camera input, the lights, cel shading and spin conventions of 3D Object,
  a bounding-volume early-out before the march, a step cap, edge anti-aliasing from the closest approach of near-miss rays (no 4x supersampling unless `quality: high`) and a `draft`
  quality that marches at half resolution.
- **`optionalOutputs` + `ctx.wants(output)`** (kernel seam, 6 lines in `engine.ts`): an output that costs extra work (the 3D nodes' `depth`) is only produced when a wire leaves it or
  it is the evaluated port. The set of wanted optional outputs is part of the cache key, so wiring one later re-renders the node once; unwired it costs nothing.
- **Depth encoding** (the `depth` output of the 3D nodes): `rgba16float`, r = g = b = distance from the camera position to the surface along the viewing ray, in scene units
  (linear; the default camera sits about 4.5 away, objects are about 2 wide), a = 1 where a surface was hit and 0 elsewhere (rgb = 0), not premultiplied, not anti-aliased, one ray
  per pixel. Custom 3D models are rasterised and produce no depth output.
- **Deform group** (`DEFORM_PARAMS`, `dNoise`... `dLowFi`): shared by 3D Object (primitives: a change of the distance function; custom models: the vertex shader), Image to 3D and
  SDF 3D. There is deliberately no standalone Displace 3D node: nodes pass pictures and cameras, not meshes, so there is nothing for it to deform. Amounts are scene units;
  animated parts take whole `cycles`. Raymarched members shorten the march step by `deformStepScale`, because a deformed distance is no longer exact.
- **A value type that carries pictures (`material`)**: `MaterialValue` is plain numbers plus optional `ImageValue`s. The kernel identifies it in cache keys by the key of the node
  that made it (never by stringifying it) and keeps its pictures alive (`retain`/`release`) for as long as that node's cache entry lives, exactly like an image output.
- **Small signed distance fields of a picture on the GPU** (`lib/gen-sdf2d.ts`): jump flooding on a grid of at most 512 cells (about 2 + log2(grid) tiny passes, recycled as they go),
  r = signed distance in grid cells (negative inside). A blocky variant reads the occupancy grid for exact staircase edges (pixel art), a smooth variant blurs the lattice out of
  the zero contour. Made per render of the node that needs it; static pictures hit the node cache.
- **A lazy multi input hides its wire count from the node.** A node that picks one wire per frame (Frame Interleave) cannot see how many wires it has, so the editor keeps a hidden `count` param in step with the wires (and fills a hidden length from the first wired Media In) in `lib/interleave-graph.ts`, called from `reconcileMediaEdits`. A node built programmatically (tests, CLI graphs) must set `count` itself. The frame maths is one pure function (`lib/interleave.ts`) that the node, its summary and the tests share; the hand-written 12-frame tables in its test are also the spec in RECIPES.md.

- **Phone sensors are a bridge channel, not a new mechanism.** `Host.signal('phone.<session>', channel, seconds)` (the same `Host.signal` as audio bridges; the router answers `phone.*` ids from the live
  motion store, directly and never from the per-frame history, and answers 0 during an export; the channel `export` is 1 there and `live` is 1 only while packets arrive). Nodes that read it declare
  `liveTick` (so the player re-renders them) and a recorded take as a JSON param (`lib/motion-take.ts`), read as a pure function of `ctx.time.seconds`: a node with a live source must fall back to its
  take in an export and throw a plain message when there is none. Smoothing is asked of the bridge by channel name (`yaw@0.35`), never kept in the node.
- **Rotation order of 3D Object is Rz * Ry * Rx** (`rotationZYX`). Anything that wants to drive `rotX / rotY / rotZ` from an orientation uses `objectRotation(q)` in `lib/motion-math.ts`, which is tested against that matrix.

- **Process mode** (`NodeDef.process`; kernel: `engine/process.ts`, scheduler and store: `io/processes.ts`). A node may declare a long job that runs OUTSIDE the per-frame render path (a bake, a whole-clip analysis, a model).
  Until it is done the node shows a stand-in; once done it serves what the job stored. Bake (Cache / Bake) and Track ("Analyse clip") are the two built-in users.
  ```ts
  process: {
    title: 'Analyse clip',
    standIn: 'bypass' | 'preview' | 'last' | 'placeholder',   // what shows until the result is done
    required?: 'always' | 'once-run' | 'never',               // does an export need it? default 'always'
    auto?: boolean,                                           // start by itself when stale (default false: the user presses Process)
    gpu?: boolean,                                            // GPU-heavy: one such job at a time (default true); false = CPU only
    signature(params, inputSignatures): string,               // identity of what the result depends on (leave display params out)
    run(job: ProcessCtx): Promise<{ meta?: Record<string, unknown> } | void>,
    estimate?(params, project): { frames?, bytes?, note? },
    handle?: { read, write, clear },                          // where the result handle lives in params (default: the reserved param `__process`)
  }
  ```
  - **`run` gets a `ProcessCtx`**: resolved `params`, `options` of this run, `fps / frames / duration / loop / canvas / item`, `host`, `gpu` (`device`, `read`), `signal`,
    `progress(fraction, note?, detail?)` (UI only), `yield()` (call it between units of work: it lets the UI breathe and waits while the user plays back or drags),
    `pull(input, { frame | seconds, wire, proxy, quality })` (evaluates what is wired to an input at any time and size; call `release()` on what it returns) and `encodeImage`.
    Results are written with `store.sequence / blob / json / array` and are only STAGED: they become visible, atomically, when `run` resolves. A cancelled or failed job changes nothing and the previous result stays.
    The store is the one the bakes always used (hidden assets owned by `bake:<project>:<node>`, persisted in IndexedDB); the scheduler turns the staged items into the `ProcessResult` handle
    (`signature`, `items` = ids + sizes, `meta`, `bytes`, `createdAt`, `seconds`) and the UI writes it into the node's params, so it is saved with the project, survives reloads, and exports and the CLI see it.
  - **`render` gets `ctx.process`** (only on nodes that declare `process`): `state` (`none | queued | running | done | stale | failed | missing`), `result`, `servable`, `frame(name, i)`, `bytes / json / array(name)`
    and `standIn()`. `bypass` = the first picture input passed through (a lazy input is pulled); `placeholder` = a striped, canvas-sized "processing" card with the title and (when the host can rasterise text) a percentage;
    `preview` = the node's own cheap approximation (render decides from `state`); `last` = the previous result is also served while stale or re-running (`servable`). `standIn()` is the fallback for all of them.
    Make every input a process node reads from only through the store `lazy`, so a node that serves its result does not evaluate what feeds it (Track and Cache do exactly that).
  - **Cache key**: the process state and the identity of the stored result (`state | signature | createdAt`) are part of the node's key, NEVER the progress. Finishing a job therefore re-renders exactly this node and what is downstream,
    and a running job costs the graph nothing. The placeholder's percentage is the one exception, quantised to 10 steps, so a placeholder node re-renders at most 11 times per job.
    A node without `process` pays nothing: the engine does one field check per node.
  - **Staleness**: the stored signature differs from `signature(params, inputSignatures)` now -> `stale`. The result is kept, the badge says so, `standIn` rules apply, nothing restarts by itself (unless `auto`).
    An upstream process finishing writes its handle into its params, which changes everything downstream's structural signature: a downstream process is then stale too (it depends on that result), as it should be.
    `missing` = the handle exists but its stored data is gone (cleared storage, another machine): the stand-in shows and the panel says so.
  - **Export rule**: an export must never silently contain a stand-in. `pendingProcesses(graph, registry, status, outputs)` lists the processes upstream of the outputs that are not done and that `required` asks for
    (`'never'`: the stand-in is exactly what the node computes, Cache / Bake; `'once-run'`: only once a result is referenced, then losing or outdating it must not fall back, Track). A process that is done and reads only lazy inputs hides what is before it.
    The app exporter stops with a `ProcessPendingError` (the list) unless the request says `runProcesses: true`, in which case it runs them first and reports each result through `onProcessResult`; the editor asks the user first.
    The CLI fails with the list unless `--process` is given (it then runs them in memory for that render only; processes that store picture sequences cannot run headlessly).
  - **Scheduler** (`ProcessScheduler`, pure): FIFO; ONE GPU-heavy job at a time (`setConcurrency`), CPU jobs (`gpu: false`) run beside it (2); one job per node. Jobs belong to a project + node. They HOLD at their next `yield()`
    while the player plays, the user drags, rendering is paused (safe mode) or another project is open (a project switch clears the engine cache and trims the GPU, so a job running on would thrash it): the job keeps its place and
    resumes by itself, a held job gives its slot to a runnable one. Nothing half-done is persisted and there are no checkpoints: a job restarts from zero. Cancel, retry and dismiss are scheduler operations; failures keep their message.
  - **Writing a process**: keep `signature` cheap and free of display params; put the heavy loop in `run` with a `yield()` per unit; stage results, do not write anywhere else; have `render` serve `ctx.process` and fall back to `standIn()`.
    A test needs the harness plus `MemoryProcessLibrary` and `ProcessRuntime` (see `io/process-mode.test.ts`, a 12-frame job served from the store with zero upstream renders).

- **Gaussian splats** (`lib/splat-*.ts`; nodes Gaussian Splat `splat-3d` and Picture to Splats `image-to-splats`). `SplatCloud` (`lib/splat-cloud.ts`) is structure-of-arrays f32 in the FILE's own frame: positions, linear scales,
  unit quaternion (w, x, y, z = `rot_0..3`), base colour (display-referred, `0.28209479177387814 * f_dc + 0.5`, not clamped), opacity (sigmoid), optional spherical-harmonics DEGREE 1 (`sh1`, 9 floats per splat; higher degrees in a file are read past
  and discarded), exact bounds and robust "core" bounds (1..99 percentile box, 99th-percentile radius) that ignore floaters and drive the node's fit and framing. Parsers are pure functions of bytes (`lib/splat-ply.ts`: standard 3DGS binary `.ply`,
  antimatter15's 32-byte `.splat`; compressed, ASCII, big-endian, SPZ/gzip and non-splat PLYs are refused with a readable `SplatError`) and the node memoises the parse per `ArrayBuffer` like 3D models.
- **A splat asset is a standard 3DGS `.ply` (hand-off for reconstruction).** Asset kind `splat` (`accept: 'splat'`, extensions `.ply`, `.splat`) was added the usual three ways (types.ts unions, `detectKind` / `probe` in `io/library.ts`, `fileMatches` /
  `ACCEPT_*` / `isSourceFor` in the UI). A later process that trains or reconstructs a cloud (from video) builds a `SplatCloud`, writes it with `writeSplatPly(cloud, '+y')` (properties x y z nx ny nz f_dc_* f_rest_0..8 opacity scale_* rot_*, binary little endian,
  `comment up +y` so the node's automatic orientation needs no guess) into the asset library, and Gaussian Splat picks it up through its `file` param; nothing else in the engine changes. Write in the tool's frame (y up) or say so in the `comment up` line.
- **Splat order is the cost; sort only when the view changes.** Sorted mode orders centres back to front by depth along the view direction with a 16-bit counting sort on the CPU (`sortBackToFront`; about 2 / 13 / 25 ms for 100k / 500k / 1M splats; ties keep index order,
  so it is a pure function). The sort is keyed by the cloud id and the SNAPPED view in file space (`sortView`: position grid radius/512, direction grid 1/1024): every camera inside one cell gives the identical order, so the cache cannot change what a render
  produces, and sliders (size, opacity, crop, colour) never sort. The order lives in a per-cloud GPU buffer remembered by its key; `Splat blending: Automatic` sorts for export and still preview and uses order-independent weighted blending (draft, no sort) only while playing
  at a reduced proxy. No Web Worker: the engine has none, headless / export need the order synchronously, and the sort is a few milliseconds. `splatDebug` (lib/splat-render.ts) counts sorts, uploads, pipelines and depth passes for tests.
- **Splat cloud buffers follow the model-3d recipe**: an LRU of at most 3 clouds / 640 MB in storage buffers made with `gpu.createBuffer(..., 'splat-buffer')` (64 bytes per splat + order + SH), destroyed on eviction and when the device was replaced; one pipeline per
  structure (source x sorted/draft x with/without depth) per device, every number in a 26-slot uniform array (rule 24); bind groups cached per (uniform buffer, buffers/textures); render targets are pooled `scratchTexture`s (rgba16float) composited by `gpu.pass`.
- **Splat camera and projection.** Perspective and orthographic are exact (EWA: 2D covariance = J W Sigma W^T J^T plus a 0.3 px low pass, optional Mip-Splatting opacity compensation, eigen axes, quad to K sigma with K = min(3.3, sqrt(2 ln(255 alpha))), maxPix clamp, frustum and
  tiny-splat culling in the vertex shader). Fisheye, panoramic and cylindrical cameras are drawn with a perspective lens (5..120 degrees). The formulas are written out in `lib/splat-math.ts` and tested against projecting samples of the Gaussian and against rendered pixels.
- **Picture to Splats makes the cloud in the vertex shader** (instance index -> grid cell -> unprojection through the capture camera -> covariance from the neighbouring depths, flat along the surface normal), with no readback and no sort: the draw ORDER is an
  occlusion-compatible traversal of the grid (McMillan, `pictureOrder`: rows outer, columns inner, each from the outside towards the epipole, the new camera's centre projected into the picture, direction reversed when the camera is behind the picture plane). Exact for a single-layer
  depth picture, so video frames and 3D-node renders work at full speed with premultiplied over-blending and no depth buffer. Depth encodings: brightness (near white / near black, between Near and Far distances) or the 3D family's Depth output (`rgba16float`, r = distance
  along the capture ray in scene units, a = hit mask; wire the SAME 3D Camera into Capture camera). Without a Depth input the depth is a labelled guess (flat card, brightness, centre bulge).

- **Depth conventions live in `lib/depth.ts`.** Picture depth (a depth map): r = g = b = d in 0..1, WHITE = NEAR, alpha 1; read by Picture to Splats (default "White = near"), Depth Slice, Lens Blur (focus depth on the same scale) and Image to 3D relief, written by Depth from Picture (`depth-estimate`, rgba16float). Scene depth (the 3D family's `depth` output, previous rule): distance in scene units + hit alpha. `pictureToScene` / `sceneToPicture` and the WGSL `DEPTH_WGSL` convert with a near and a far distance (picture 1 = near units, picture 0 = far units); the Depth Convert node (`depth-convert`) exposes them. A new depth producer or consumer uses these, it does not invent a third convention.
- **Depth from Picture = fixed-range cues, one frozen measurement.** Every cue maps a FIXED range to 0..1 (nothing is normalised by the frame's min / max), so video cannot flicker. The only per-picture analyses are memoised pure functions keyed by (node id, `inputSignature`, moment, settings), like automatic white balance: the subject colour models (`lib/mask-subject-gpu.ts`: `analyseSubject` reads one 128 px thumbnail, `subjectScore` is pure GPU and is the same code Subject Mask runs) and, with *Stabilize*, the depth range. A still picture is analysed once and cached by the engine; a moving one is analysed at *Analyze at* and scored on the GPU every frame, with no readback in the per-frame path (a test counts `gpu.read` calls).
- **Edge-aware work at reduced size.** The depth is computed at a quarter / half / full of the picture (`quality`), smoothed with a separable cross-bilateral filter guided by the work-size picture compared in a square-root (perceptual) space so dark edges count, and enlarged with a 3x3 joint-bilateral upsample against the full-size picture. Feature averages (`blurDown`) are made at a reduced size in rgba16float (an rgba8 intermediate would quantise small ratios). A node whose inputs share a name with a param (here `subject`) must rename the input: the registry refuses a name that is both.
