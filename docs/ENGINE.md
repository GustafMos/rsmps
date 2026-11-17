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
the add-menu entry, search, inspector controls, sockets, node color and docs come from the definition.

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
   In a shader, `unpremul()` before color math and `premul()` before returning.
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
   actually animating: reading it makes the node re-render every frame. With Loop on the user must never have to "do the math":
   a rate that is not a whole number of cycles, a period that does not divide the loop, a sequence that does not come round
   (palette length, hue step) is closed FOR them. See "Loop snapping" under Pending rules and `lib/loop-snap.ts`.
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
2× resolution with `unit` 2 (see `kernel.test.ts`), (d) for anything animated: `t.loopCheck` renders every frame of a loop and compares the step across the wrap (last frame to first) with the ordinary steps: `seam <= LOOP_SEAM_OK` and `motion > 0` (an `exact` option also reports `exactDiff`, 0 = periodic bit for bit), with values that are awkward (a rate of 0.37, a period that does not divide the length, a 5-color palette at speed 2), and add the node to the table in `__tests__/loop-audit.test.ts`. Shader compile errors surface as test failures, so a passing test
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
    from `lib/art-grid.ts`. It point-samples the input at cell centers down to `round(size / cell)`, runs your function on that
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
  identical pixels (test it: play forward on one engine, compare with a cold engine per frame). A window must not slide, and it must not RESTART
  with a cold fold during playback (that is a periodic stutter: up to 2K + 1 passes once per K frames): keep TWO staggered windows instead (Feedback:
  epochs of K frames; A = the fold from the start of the PREVIOUS epoch, the output, B = the fold from the start of the current epoch; at an epoch start
  A continues from B's state and B starts over), so forward playback is a constant 2 passes per frame and a cold evaluation reproduces it bit for bit
  (it folds A and B from their own starts, sharing every pulled frame). The second window travels in a hidden image the render returns under the reserved
  name `carry` (not in `outputs`, never shown or wired; kept with the cache entry) and is read back with `ctx.previous({ carry: true })`.
  `ctx.previous({ wrap: true })` makes frame 0 of a looping project see the LAST frame (default: frame 0 has none, other nodes rely on that); a node whose epoch
  schedule is periodic in the loop length (the last epoch takes the remainder, `epochs = floor(N / K)`) then continues across the seam with no cold fold, and frame N is frame 0.
  Do not combine with `maskable` (the cached result is already mixed), and
  skip `previous()` when any param socket (or a wired Warp picture) varies with time (`ctx.inputVaries(param)`). Index: `Engine.selfIndex`, bounded to 512 entries.
- **`ctx.inputVaries(input)`** says whether an input changes with time (`false` = a still: same picture every frame). Use it to skip pulls and
  not read `ctx.time` at all for static inputs, which keeps the node's own result static and cached. Valid after evaluation (normal inputs) or
  after the first `pull` (lazy inputs).
- **Slices in one pass.** The GPU layer has no texture arrays: bind up to 8 slices per pass (`lib/time-slices.ts`, `SLICE_GROUP`) and accumulate in
  rgba16float, so N slices cost ceil(N / 8) passes, and pull each distinct frame once.
- **Optical flow encoding** (`lib/optical-flow.ts`): rg = motion from the previous to the current frame as a fraction of image width / height per frame
  (right / down positive), b = luma of the current frame at flow resolution (reused through `ctx.previous()`), a = 1; rgba16float at the flow grid.

- **Many copies are one pass, one draw.** Duplicating nodes (Array, Scatter, Infinite Zoom, Kaleidoscope) inverse-map each output pixel into the few copies that can
  reach it (the cell it falls in plus a small neighborhood, composited back to front) instead of drawing every copy. The neighborhood size and every other number are uniforms,
  never WGSL text, so cost does not grow with the copy count and dragging a slider compiles nothing. Where exact inversion is impossible the node says so (Array with per-copy
  steps is exact up to 25 copies per axis, local beyond). Shared math lives in `lib/copy-wgsl.ts`.
- **A loop test must look across the wrap.** The clock wraps (`phase` of the last frame + 1 is 0), so comparing frame 0 with "frame N" compares a frame with itself and proves
  nothing (the old `loopCheck` did exactly that, so many "loops seamlessly" tests were vacuous). `t.loopCheck(type, params, inputs, opts)` in `testing.ts` is now THE loop test
  (`seamRatio` in `lib/copy-testutil.ts` is the same call with the older argument order). It renders frames 0..N-1 of a loop of N frames with Loop on and returns
  `wrap` (frame N-1 -> 0), the ordinary steps (`typical` = median, `max`, `mean`, `steps`), `seam = wrap / max(largest ordinary step, floor)` (a loop is `seam <= LOOP_SEAM_OK`),
  `motion` (largest difference between frame 0 and any other frame: a still picture must not pass), `worst` (the worst frame pair, `from -> to`, flagged when it is the wrap) and a
  one-line `text` for assertion messages. Pictures, numbers and vectors are measured (`port` picks the output). `exact: true` also evaluates frame N and beyond and reports
  `exactDiff` (0 = periodic bit for bit). Inputs may be `{ node: 'id', params }` (a registered node, e.g. a moving test source) as well as still pictures. A node that cuts by
  design (key frames, interleaved sources, a field order) is asserted with `exact` only. `__tests__/loop-audit.test.ts` is the table of every animated node with awkward values
  at 24, 37 and 96 frames, and writes the inventory `loop-audit.tsv` to the OS temp dir; `AUDIT_LOOP_OFF=1` runs the same table with Loop off to show what snapping fixes.
  `__tests__/loop-off.test.ts` holds checksums recorded before the snapping work: with Loop off the same params give the same pixels.
- **Whole levels / cells / spacings per loop.** Infinite Zoom (levels), Array (cells), 3D Array (spacings) take integer `cycles` params. A per-copy color that travels with the copy
  only loops when its period divides the travel: with Loop on this is now closed for the user (see "Loop snapping"); "color follows the depth on screen" still always loops.

- **Loop snapping** (`lib/loop-snap.ts`; pure, unit-tested; every node uses it instead of ad-hoc rounding). One-click looping: with the project's Loop switch on, an animated node repeats
  exactly over the project length whatever numbers the user typed. With Loop off every function returns its input and nothing changes (there is a checksum test). The rules:
  1. **Rates per loop**: rounded to the nearest whole number of cycles (half away from zero), never to 0 unless the user's value is 0 (0 < |v| < 1 goes to +-1): `wholeCycles(rate, loop)`.
     A socket can feed a fraction into an integer param; `wholeCycles` makes that safe. **Rates per second** (Subtitles motion Hz, Retime stop-motion fps): `cyclesPerLoop(rate, loopSeconds)` /
     `hzForLoop`, the nearest whole number of cycles that fits the loop, same minimum.
  2. **Periods in frames** ("every N frames", hold, key frame, boil poses): `epochOf(frame, frames, period)` shortens the LAST epoch so the sequence restarts exactly at frame 0, or
     `snapPeriod(frames, period)` takes the nearest divisor of the frame count. A hash per frame uses the frame index modulo the loop (`loopFrame`, `loopFrameOf`). A cycle of poses is
     `cyclePose(epoch, epochs, poses)`: any pose count closes over any length (a prime loop length no longer collapses the boil to one pose).
  3. **Compound things close TOGETHER.** A spatial or temporal cycle with a discrete sequence riding on it (palette length x levels travelled, hue step x travel, copy color steps x scroll,
     brick offset x scroll, mirror flips x scroll) must have the combined state at frame N equal frame 0. In order of preference: (a) `closeSequence` rounds the travel to a multiple of the
     sequence (within +-50% of what was asked), (b) the sequence DRIFTS by the remainder over the loop (`closingDrift`, `closingTurns`: a color index `k + drift * phase`), (c) the sequence is
     STRETCHED so its period divides the travel (`stretchedStep`, `stretchedTurns`). Things that are picked, not blended (jitter, sprite sheet cells, time slices) cannot drift: the scroll is
     rounded to whole tiles with `snapMultiple`. Per node: **Infinite Zoom** has `colorLoop`: Drift (default; `zoomLoop`), Snap travel, Stretch palette, for the palette AND the hue step;
     the layer range also follows the travel (a rising travel and the deep end of a falling one are drawn) so any whole travel closes. **Array**: color steps ride on a copy index that moves
     toward the index of the cell the copy ends the loop in; a finite scrolled Grid wraps inside its own box; an odd vertical scroll with a brick offset slides alternate rows sideways; an odd
     horizontal scroll with mirroring turns the copies over (`arrayLoop`). **3D Array**: the card color index moves toward the slot index (`array3dLoop`). **Kaleidoscope** log-polar: Spiral twist
     x Fall gets a slow extra turn that makes it a whole number of arms; a fractional mirror Scroll is rounded (`kaleidoscopeLoop`). **Retime**: speed is a whole number (even for ping-pong),
     stop-motion fps a whole number of held frames per loop (`retimeLoop`). **Subtitles**: wave / float Hz (`subtitleMotionHz`). **Particles**: a layer's grid drifts by whole cells per loop, so the random properties of a particle are hashed from its cell MODULO that drift (`driftKey`: the lattice Z^2 / <n> is Z x Z_g), otherwise the end of the loop is a different scatter from the start (found by the new loop test; Loop off hashes the cell itself as before).
  4. **Nodes that pull other times** (Echo, Feedback, Frame Blend, Slit Scan, Time Displace, Motion Smear, Time Offset, Loop, Retime, Rgb Delay, Feedback Trail, Datamosh, Array time slices) wrap the
     pulled time modulo the loop when Loop is on (`wrapSeconds`, `pullFrames`, `pullSliceFrames`). Phase-driven noise is periodic by construction (`loopNoise` walks a circle, speed is only its radius).
  5. **Discontinuous by design** (Frame Interleave, Motion Smear key frames, Digital Glitch events, Media Timeline edits, interlace field order): the SEQUENCE still closes (frames are wrapped
     before the pattern is read, epochs restart at frame 0) even though the content cuts; an odd loop length cannot alternate fields perfectly and shows one held field at the seam.
  6. **Visibility.** When snapping changes what the user typed the node's `summary(params, wired, clock)` says so briefly ("speed 2 → 3 to loop", "colors drift 1/loop to close"). `clock` is
     `{ loop, frames, fps }` (`LoopClockInfo`), passed by the node view; a caller without it gets the plain summary. The notes come from the same pure function the render uses.
  7. **Cost.** Snapping is arithmetic on uniforms: no pass, no texture, no new shader per value (test: pipelines created stay 0 while Loop and numbers change).
  Not auto-looped, listed in the audit test: live input (phone motion / camera, webcam, URL streams, audio / MIDI bridges) and recorded takes (they have their own loop blend), footage readers
  (Media In, Sprite Sheet In: their own Loop option), analysis frozen at one frame, a Cache serving a bake, Custom Shader (the user's WGSL).
- **A node that draws geometry itself** (3D Array) creates its pipeline once per device (WeakMap, like `model-render.ts`), draws with `instance_index` and no instance buffer, uses
  the pooled scratch buffers / textures, caches its bind group per (uniform buffer, texture), and refuses counts above a stated cap with a readable error.
- **Per-copy time offset** needs no lazy input: `ctx.pull('image', { seconds })` works on a normal required input (as in Frame Echo). Bind a fixed number of slices (8) and pull each
  distinct moment once, never per copy.
- **Batch items are not visible to a node** (rule: nodes never see lists of images), so "each copy shows a different item" is done with a sprite sheet (columns x rows) in the
  input picture, not with the batch.

- **Color grading is linear-light and gamut-aware, from one math file.** `lib/color-math.ts` holds every constant and formula of the grading nodes (white
  balance, saturation, lift/gamma/gain/CDL, exposure, curves, color spaces, `.cube` LUTs, the qualifier) as plain TypeScript, `lib/color-wgsl.ts` generates the
  matching WGSL (`COLOR_WGSL`, functions prefixed `cg_`) from the same constants, and the tests compare the GPU result with the TypeScript reference. A color
  node says in its hint which space it works in. Saturation changes never clip: chroma is reduced toward the gray of the same lightness (`cg_gamutLC`). Curve and LUT data go
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
  per pixel. Custom 3D models are rasterized and produce no depth output.
- **Deform group** (`DEFORM_PARAMS`, `dNoise`... `dLowFi`): shared by 3D Object (primitives: a change of the distance function; custom models: the vertex shader), Image to 3D and
  SDF 3D. There is deliberately no standalone Displace 3D node: nodes pass pictures and cameras, not meshes, so there is nothing for it to deform. Amounts are scene units;
  animated parts take whole `cycles`. Raymarched members shorten the march step by `deformStepScale`, because a deformed distance is no longer exact.
- **A value type that carries pictures (`material`)**: `MaterialValue` is plain numbers plus optional `ImageValue`s. The kernel identifies it in cache keys by the key of the node
- **One BRDF, many users (`lib/gen-material.ts`).** `matShade` is generated once per material STRUCTURE and called by every user: the raymarched nodes (`materialWgsl`), the rasterized ones (custom models in `model-render.ts`, 3D Array cards: `materialRasterWgsl` / `materialRasterData` / `materialRasterLayout` / `materialRasterGroup`, one pipeline pair per structure, every number in a 12-vec4 uniform buffer) and flat pictures (Material 2D: `materialWgsl(m, { lightArgs: true })`, so a second light is one more call, not a second shader). Rasterised users add `{ mesh: true }` for the model's own UVs (`gMeshUv`, tangent frame from screen derivatives). A new user supplies its own surface normal, view ray and object-space position; it never copies the lighting. The height fields of flat pictures (bevel from a jump-flood distance field, brightness, a height picture, a wired normal map) live in `lib/gen-surface2d.ts` and are shared by Material 2D and Normal Map; normal maps are OpenGL (green up) everywhere unless a node says otherwise.
  that made it (never by stringifying it) and keeps its pictures alive (`retain`/`release`) for as long as that node's cache entry lives, exactly like an image output.
- **Small signed distance fields of a picture on the GPU** (`lib/gen-sdf2d.ts`): jump flooding on a grid of at most 512 cells (about 2 + log2(grid) tiny passes, recycled as they go),
  r = signed distance in grid cells (negative inside). A blocky variant reads the occupancy grid for exact staircase edges (pixel art), a smooth variant blurs the lattice out of
  the zero contour. Made per render of the node that needs it; static pictures hit the node cache.
- **A lazy multi input hides its wire count from the node.** A node that picks one wire per frame (Frame Interleave) cannot see how many wires it has, so the editor keeps a hidden `count` param in step with the wires (and fills a hidden length from the first wired Media In) in `lib/interleave-graph.ts`, called from `reconcileMediaEdits`. A node built programmatically (tests, CLI graphs) must set `count` itself. The frame math is one pure function (`lib/interleave.ts`) that the node, its summary and the tests share; the hand-written 12-frame tables in its test are also the spec in RECIPES.md.

- **Phone sensors are a bridge channel, not a new mechanism.** `Host.signal('phone.<session>', channel, seconds)` (the same `Host.signal` as audio bridges; the router answers `phone.*` ids from the live
  motion store, directly and never from the per-frame history, and answers 0 during an export; the channel `export` is 1 there and `live` is 1 only while packets arrive). Nodes that read it declare
  `liveTick` (so the player re-renders them) and a recorded take as a JSON param (`lib/motion-take.ts`), read as a pure function of `ctx.time.seconds`: a node with a live source must fall back to its
  take in an export and throw a plain message when there is none. Smoothing is asked of the bridge by channel name (`yaw@0.35`), never kept in the node.
- **Rotation order of 3D Object is Rz * Ry * Rx** (`rotationZYX`). Anything that wants to drive `rotX / rotY / rotZ` from an orientation uses `objectRotation(q)` in `lib/motion-math.ts`, which is tested against that matrix.

- **Process mode** (`NodeDef.process`; kernel: `engine/process.ts`, scheduler and store: `io/processes.ts`). A node may declare a long job that runs OUTSIDE the per-frame render path (a bake, a whole-clip analysis, a model).
  Until it is done the node shows a stand-in; once done it serves what the job stored. Bake (Cache / Bake) and Track ("Analyze clip") are the two built-in users.
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
    Results are written with `store.sequence / blob / json / array` and are only STAGED: they become visible, atomically, when `run` resolves. A canceled or failed job changes nothing and the previous result stays.
    The store is the one the bakes always used (hidden assets owned by `bake:<project>:<node>`, persisted in IndexedDB); the scheduler turns the staged items into the `ProcessResult` handle
    (`signature`, `items` = ids + sizes, `meta`, `bytes`, `createdAt`, `seconds`) and the UI writes it into the node's params, so it is saved with the project, survives reloads, and exports and the CLI see it.
  - **`render` gets `ctx.process`** (only on nodes that declare `process`): `state` (`none | queued | running | done | stale | failed | missing`), `result`, `servable`, `frame(name, i)`, `bytes / json / array(name)`
    and `standIn()`. `bypass` = the first picture input passed through (a lazy input is pulled); `placeholder` = a striped, canvas-sized "processing" card with the title and (when the host can rasterize text) a percentage;
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
  unit quaternion (w, x, y, z = `rot_0..3`), base color (display-referred, `0.28209479177387814 * f_dc + 0.5`, not clamped), opacity (sigmoid), optional spherical-harmonics DEGREE 1 (`sh1`, 9 floats per splat; higher degrees in a file are read past
  and discarded), exact bounds and robust "core" bounds (1..99 percentile box, 99th-percentile radius) that ignore floaters and drive the node's fit and framing. Parsers are pure functions of bytes (`lib/splat-ply.ts`: standard 3DGS binary `.ply`,
  antimatter15's 32-byte `.splat`; compressed, ASCII, big-endian, SPZ/gzip and non-splat PLYs are refused with a readable `SplatError`) and the node memoises the parse per `ArrayBuffer` like 3D models.
- **A splat asset is a standard 3DGS `.ply` (hand-off for reconstruction).** Asset kind `splat` (`accept: 'splat'`, extensions `.ply`, `.splat`) was added the usual three ways (types.ts unions, `detectKind` / `probe` in `io/library.ts`, `fileMatches` /
  `ACCEPT_*` / `isSourceFor` in the UI). A later process that trains or reconstructs a cloud (from video) builds a `SplatCloud`, writes it with `writeSplatPly(cloud, '+y')` (properties x y z nx ny nz f_dc_* f_rest_0..8 opacity scale_* rot_*, binary little endian,
  `comment up +y` so the node's automatic orientation needs no guess) into the asset library, and Gaussian Splat picks it up through its `file` param; nothing else in the engine changes. Write in the tool's frame (y up) or say so in the `comment up` line.
- **Splat order is the cost; sort only when the view changes.** Sorted mode orders centers back to front by depth along the view direction with a 16-bit counting sort on the CPU (`sortBackToFront`; about 2 / 13 / 25 ms for 100k / 500k / 1M splats; ties keep index order,
  so it is a pure function). The sort is keyed by the cloud id and the SNAPPED view in file space (`sortView`: position grid radius/512, direction grid 1/1024): every camera inside one cell gives the identical order, so the cache cannot change what a render
  produces, and sliders (size, opacity, crop, color) never sort. The order lives in a per-cloud GPU buffer remembered by its key; `Splat blending: Automatic` sorts for export and still preview and uses order-independent weighted blending (draft, no sort) only while playing
  at a reduced proxy. No Web Worker: the engine has none, headless / export need the order synchronously, and the sort is a few milliseconds. `splatDebug` (lib/splat-render.ts) counts sorts, uploads, pipelines and depth passes for tests.
- **Splat cloud buffers follow the model-3d recipe**: an LRU of at most 3 clouds / 640 MB in storage buffers made with `gpu.createBuffer(..., 'splat-buffer')` (64 bytes per splat + order + SH), destroyed on eviction and when the device was replaced; one pipeline per
  structure (source x sorted/draft x with/without depth) per device, every number in a 26-slot uniform array (rule 24); bind groups cached per (uniform buffer, buffers/textures); render targets are pooled `scratchTexture`s (rgba16float) composited by `gpu.pass`.
- **Splat camera and projection.** Perspective and orthographic are exact (EWA: 2D covariance = J W Sigma W^T J^T plus a 0.3 px low pass, optional Mip-Splatting opacity compensation, eigen axes, quad to K sigma with K = min(3.3, sqrt(2 ln(255 alpha))), maxPix clamp, frustum and
  tiny-splat culling in the vertex shader). Fisheye, panoramic and cylindrical cameras are drawn with a perspective lens (5..120 degrees). The formulas are written out in `lib/splat-math.ts` and tested against projecting samples of the Gaussian and against rendered pixels.
- **Picture to Splats makes the cloud in the vertex shader** (instance index -> grid cell -> unprojection through the capture camera -> covariance from the neighboring depths, flat along the surface normal), with no readback and no sort: the draw ORDER is an
  occlusion-compatible traversal of the grid (McMillan, `pictureOrder`: rows outer, columns inner, each from the outside toward the epipole, the new camera's center projected into the picture, direction reversed when the camera is behind the picture plane). Exact for a single-layer
  depth picture, so video frames and 3D-node renders work at full speed with premultiplied over-blending and no depth buffer. Depth encodings: brightness (near white / near black, between Near and Far distances) or the 3D family's Depth output (`rgba16float`, r = distance
  along the capture ray in scene units, a = hit mask; wire the SAME 3D Camera into Capture camera). Without a Depth input the depth is a labeled guess (flat card, brightness, center bulge).

- **Depth conventions live in `lib/depth.ts`.** Picture depth (a depth map): r = g = b = d in 0..1, WHITE = NEAR, alpha 1; read by Picture to Splats (default "White = near"), Depth Slice, Lens Blur (focus depth on the same scale) and Image to 3D relief, written by Depth from Picture (`depth-estimate`, rgba16float). Scene depth (the 3D family's `depth` output, previous rule): distance in scene units + hit alpha. `pictureToScene` / `sceneToPicture` and the WGSL `DEPTH_WGSL` convert with a near and a far distance (picture 1 = near units, picture 0 = far units); the Depth Convert node (`depth-convert`) exposes them. A new depth producer or consumer uses these, it does not invent a third convention.
- **AI Depth = a process node with an optional model, one seam, 16 bit.** `depth-ai` (src/engine/nodes/layers) is a process node (stand-in `preview` = the shared Depth from Picture estimate in `lib/depth-heuristic.ts`, `required: 'once-run'`, never `auto`). The engine has no model and no network: the job asks `getDepthAiService()` (`lib/depth-ai-bridge.ts`), which the app installs at start (`src/io/depth-ai.ts`: one onnxruntime-web session, WebGPU with a CPU fallback, serialised, released when idle or on device loss) and the command line and tests do not (a test injects a fake). The model file lives in `src/io/models.ts` (catalog `src/io/model-catalogue.ts`: pinned URL, size, SHA-256, license; IndexedDB; downloaded only by a user's button). The runtime files are copied to `ort/` by `vite-plugins/ort-files.ts` and imported by URL on first use, so they cost nothing until then. The model's output is relative, so the job aligns each frame to the previous one by robust least squares on the unchanged pixels and maps the clip with one range (`lib/depth-ai-math.ts`); the result is ONE `u16` array (`store.array`: 16 bit, because the sequence store encodes 8-bit pictures) at the model's output size, enlarged on the GPU when shown. Display params (levels, invert) are outside the process signature.
- **Depth from Picture = fixed-range cues, one frozen measurement.** Every cue maps a FIXED range to 0..1 (nothing is normalized by the frame's min / max), so video cannot flicker. The only per-picture analyses are memoised pure functions keyed by (node id, `inputSignature`, moment, settings), like automatic white balance: the subject color models (`lib/mask-subject-gpu.ts`: `analyseSubject` reads one 128 px thumbnail, `subjectScore` is pure GPU and is the same code Subject Mask runs) and, with *Stabilize*, the depth range. A still picture is analyzed once and cached by the engine; a moving one is analyzed at *Analyze at* and scored on the GPU every frame, with no readback in the per-frame path (a test counts `gpu.read` calls).
- **Edge-aware work at reduced size.** The depth is computed at a quarter / half / full of the picture (`quality`), smoothed with a separable cross-bilateral filter guided by the work-size picture compared in a square-root (perceptual) space so dark edges count, and enlarged with a 3x3 joint-bilateral upsample against the full-size picture. Feature averages (`blurDown`) are made at a reduced size in rgba16float (an rgba8 intermediate would quantise small ratios). A node whose inputs share a name with a param (here `subject`) must rename the input: the registry refuses a name that is both.

- **Game assets (sprite sheets, tiles, shared palettes).** Sprite Sheet In is a footage-like source: it slices a sheet once (the analysis is memoised by sheet identity and slicing settings, never per frame; wired sheets are keyed by `ctx.inputSignature`) and reads the clock only when it has more than one cell to play (`as: items` reads the batch item instead and stays static). Pure slicing, ordering, timeline and metadata reading live in `lib/sprite-sheet.ts`; sheet assembly (layout, trim, shelf packing, extrude, power of two, pages, bleed) in `io/spritesheet-pack.ts`, the metadata writers in `io/spritesheet-meta.ts`, the "For" presets in `io/spritesheet-presets.ts`, the Output params in `io/spritesheet-params.ts` (read by the app exporter and the CLI alike), and the straight-alpha PNG writer (the canvas path is premultiplied and loses the color under alpha 0) in `io/png-encode.ts`. A RENDER cannot read other batch items, but a process job can: `ProcessCtx.pull(input, { item })` evaluates the wired chain for any item, so a palette over a whole set is a process job (`batch-palette`: its own file list, sampled clip frames, and / or "Every batch item" = the wired chain for every item, effects included; at most 1200 pictures). A render-time `ctx.pull({ item })` is deliberately NOT offered: the node cache key would have to contain every item. `batchCount` is the largest of every `assets` list and every `NodeDef.batchSize(params)` (pure, params only, null = none): Sprite Sheet In "Batch items" sets the batch size itself (grid columns x rows or the metadata's frames, after the Animation / Frames / Order selection, times the number of sheet files; item = sheet x cells + cell). Grids by cell size and gap detection need the picture, which a params-only function cannot read: the visible number `Items per sheet` carries the count there (0 = unknown, the batch then comes from the file lists, the `Count` output says how many cells were found). `itemDependent` also counts a node whose `batchSize` is above 1. Pixel look nodes (Pixel Outline, Pixel Cleanup, Sprite Shadow, Palette Lock, Make Seamless) wrap their work in `withArtGrid` and use integer texel math (`textureLoad`), so results are exact and cell-aligned. Number outputs that need a readback (Palette Lock `offPalette`, `colors`) are `optionalOutputs` read from a point-sampled copy of at most 128 pixels, or exactly in report mode, and only when wired. Autotile tables and the WGSL that composes a tile from five pieces are in `lib/autotile.ts` (Autotile and Tileset Map share them).

- **Group nodes (macros) are flattened, never evaluated** (`engine/group.ts`). A group is a node of type `group` whose params hold a sub-graph (`GroupData`: `kind` 'group' | 'repeat',
  `nodes`, `edges`, `inputs` / `outputs` (`GroupPort`: id, name, socket type), `exposed`, title / color / icon / description). Inner wires reach the group's ports through two pseudo nodes:
  a wire FROM `@in` port X is "what arrives on input X", a wire TO `@out` port Y is "what output Y gives". Keeping them as ordinary wires keeps the order of `multi` inputs exact.
  `flattenGraph(graph, { opaque, counts })` (pure, memoised per document object and options) turns the document into a plain graph: inner ids become PATHS (`groupId/innerId`; nested
  `outer/inner/node`), exposed values are written into the inner params, a wire into an exposed socket is re-targeted to the inner param, a bypassed group passes its first input of each
  output's type through. `Engine.evaluate` flattens a document that has a group at its top level (one check per top-level node otherwise, no allocation) and resolves `EvalRequest.node`
  through it, so a group id evaluates the group's first (or the requested) output and a path id evaluates an inner node. Consequences, all tested in `__tests__/groups.test.ts`: a group boundary
  adds no node, no pass, no copy and no cache miss (same renders as the flat graph; cache keys never contain node ids); `EvalResult.timings` and `errors` use flat ids (paths), and an error
  inside is ALSO reported on the group and every group around it (`Inside: ...`); `ctx.nodeId` is the node's LOCAL id (the last path segment), so grouping never changes a seed and so a look
  (two copies of one group share seeds); masks, the art grid, lazy inputs and `ctx.pull` options work unchanged because they work on the flat graph. Nesting is capped at `GROUP_MAX_DEPTH` (8);
  deeper groups are kept as one node that says why, and a wiring loop between groups (only possible in a damaged file) is reported, not followed. Everything that takes a node id in the engine
  and the process layer (`processStatus`, `processSignature`, `signatureOf`, `ProcessRuntime.run`, `withProcessResult`) accepts a path. A group's ports and params come from its own params:
  use `defOf(registry, node)` instead of `registry.get(node.type)` wherever a node's sockets matter (the registered `group` definition is only a placeholder). Exposed params carry a JSON
  snapshot of the inner param's definition, so a group's definition needs no registry and a saved group describes itself. Audio and MIDI nodes cannot go in a group (the stream graph is
  compiled from the top level; `groupProblem` refuses them, and Output nodes, with a message).
- **Repeat groups** (`kind: 'repeat'`) are unrolled by the flattening: pass i of N gets ids `repeatId/~i/innerId`. The carried input (`GroupPort.loop`, else the first image input) of pass i > 0
  is the first image output of pass i - 1 (`mode: 'chain'`, out = f(f(f(x)))); in `mode: 'accumulate'` every pass gets the ORIGINAL input and the passes are merged in order by real Merge
  nodes (`repeatId/~acc<i>`, blend = the group's `blend`, opacity = `opacity`, a wired opacity reaches every Merge), first pass at the bottom. An `iteration` node inside gets its pass written
  into its hidden `iter` param (outputs index, fraction 0..1, count), so every pass has its own cache entries and an edit that leaves early passes unchanged re-renders only the later ones;
  static inputs stay cached. Cost is exactly N x the inside (no hidden passes). `count` (default 4, softMax 16, hard cap `REPEAT_MAX` 64) may be wired: the engine evaluates the count source
  first, then unrolls that many passes (a wired value above the cap is clamped and reported on the group); an animated count unrolls per frame (the flattening is memoised per count). The plain
  path `repeatId/innerId` resolves to the last pass (viewer, errors). Known limit: a process node downstream of a Repeat whose count is wired compares its signature against the unexpanded
  Repeat node (it is stable, but not the same string as with a fixed count).
- **Bake a group (cache region).** A group's process (`groupDefOf(...).process`, title Bake, stand-in `bypass`, `required: 'never'`) renders every frame of its OUTPUTS live
  (`ProcessCtx.pullOutput`, which evaluates the node's own output with its result handle cleared) and stores pictures and masks as sequences (`out:<port>`, lossless) and numbers / colors as one
  JSON array. Its signature is `Engine.groupSignature`: the structure of what feeds each output in the fully expanded document (inner nodes and params, exposed values, outer inputs, project,
  frame size), so any change inside or before it makes it stale and baking another group before it does not. Done (and made for this frame size and batch item), the group is kept as ONE node
  by the flattening (`opaque`) and serves the store: nothing inside or before it is evaluated. Stale, missing or not baked, it is evaluated live; it never re-bakes by itself. A group inside a
  Repeat pass is never served from a bake. "Bake selection" (Ctrl+Shift+B) groups the selection and bakes the group; a selected group or Cache / Bake node is baked as it is, and Cache / Bake
  nodes keep working exactly as before.
- **A copy never shares a stored result.** Duplicate, paste, a saved node and an imported file strip the result handle of the node and of everything inside it (`withoutProcessResults`): the
  stored data is owned by the original node (`bake:<project>:<node id or path>`). Stored data no node references any more is removed when a project is LOADED
  (`processes.prune(id, graph, { unreferenced: true })`), never right after a delete, so undo can bring a node back with its result.
- **Saved group nodes are data only** (`io/node-presets.ts`, `io.nodePresets`): a `.rsmps-node.json` file is `{ schema: 'rsmps/node', version: 1, name, category, keywords, description, group }`,
  at most 2 MB, every node type inside must exist, nesting within the cap; nothing in it is run as code. Adding one makes an editable copy, never a live link.

- **External programs are a Host service, never engine code** (Splat from Video; `Host.splatTrain`, `SplatTrainHost` in types.ts). A process that needs a program on the user's
  computer asks the host for a narrow, typed service (here: `status()` and `train({ settings, frameCount, frame(i), signal, onProgress })`); the desktop app implements it over
  `/__rsmps/splat-train` (client `io/splat-train.ts`, main-process module `desktop/addons/splat-train.mjs`), the web build and the CLI leave it undefined and the node says so
  (`requires: ['desktop']`, the new `'desktop'` capability). Settings are fixed choices; the main process builds every argument array itself, never runs a shell, keeps every path
  inside the job folder, kills the whole process tree on cancel and deletes the work folder when the result was read. The add-ons the service needs are found through the add-on
  manager only (pinned, hash-checked, user-installed or user-located); a node never downloads anything.
- **Reconstructed scenes are stored in the tool's frame.** COLMAP's world is right-handed with no gravity; this tool's world is y-up and the mirror convention (`cameraBasis`:
  right x up = forward). `lib/colmap.ts` maps one onto the other with M = Ry(heading) F Q (Q: estimated up -> +y, from the cameras' right axes; F = diag(1, 1, -1); det M = -1),
  moves the splats with it (`transformCloud`: covariances through M R with one axis flipped, degree-1 SH as a direction) and writes them with `comment up +y`. The solved cameras
  become a camera path in the same frame (`PathKey`: position + the proper rotation [right, up, forward]); a node's Camera output carries them through the node's own object
  transform (`cameraThroughXform` in `lib/splat-scene.ts`), so wiring it back into the node's Camera input shows the original shot. Tested against COLMAP's recorded solve of a
  scene with known cameras (`colmap.test.ts`: no mirror, up within 0.5 degrees, axes within 0.5 degrees).
- **An `assets` param with `batch: false`** is one set used by the node (Splat from Video's photos), not one file per batch item: `batchCount` and `itemDependent` skip it.
- **Splat look defaults follow standard trainers.** "Fade tiny splats" (Mip-Splatting opacity compensation) is OFF by default in Gaussian Splat and Splat from Video: Brush and the
  original 3DGS train without it, and turning it on for their files cost 2.6 dB PSNR on held-out views. Trainers are run with spherical harmonics degree 1 because the renderer
  draws degree 1 only (degree 3 trained and then cut to 1 measured 0.7 dB worse).
- **Per-node structural fast path.** `Engine.staticNodes` (per document OBJECT, a WeakMap) remembers, after every error-free evaluation, which node results were static (no clock, no process state)
  by (node, item, quality, canvas, proxy, lite) -> cache key. A static node found there whose entry is still cached is returned without walking, hashing or looking up anything upstream of it,
  so an animated frame costs O(time-varying nodes + their direct static inputs) instead of O(every upstream node) (500 nodes, 20 animated: 7.2 -> about 4 ms per frame, most of the rest is the animated passes).
  Not used with process nodes in the document, for nodes with optional outputs, or for results that are not cached (bypass, empty); `clear()` and `forgetAll()` (assets changed, device lost) drop it with the cache;
  an edit is a new document object and starts empty. Test: `__tests__/static-walk.test.ts`.
- **Process panels work on full path ids** (`ui/store/processes.ts`): `runProcess / cancelProcess / clearProcess` take the id the scheduler and the engine use (`group/inner`); a component holding a node of the SHOWN level converts it with
  `ed.fullId(levelId)`. `processSelection` maps the shown level's selection to paths and orders them on the flattened document; results are written with `withProcessResult` (one undo step), auto processes and the
  stash for other projects look nodes up by path, and job labels read "Group name › Node" (`processLabel`).
