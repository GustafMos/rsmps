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
src/app/          React UI
src/core/         OLD engine. Reference for porting algorithms only. Do not import it from src/engine.
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
11. Nodes never import from `src/app`, `src/io` or `src/core`. Port algorithms by rewriting them here.
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
