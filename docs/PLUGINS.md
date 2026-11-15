# Plugins

A plugin adds nodes to RSMPS without rebuilding the app. Once installed it is stored in the browser
and behaves exactly like a built-in node: add menu, search, inspector, saving in project files.

> **Security warning.** A plugin is JavaScript that runs inside the app page with **full page
> privileges**: it can read your imported media, your saved projects and anything else the page can
> reach, and it can make network requests. Only install plugin files you wrote yourself or trust
> completely. The app cannot sandbox them.

## What a plugin file looks like

- One plain ES module file (`.js` or `.mjs`).
- **No `import` statements.** Everything a node needs arrives through `ctx` in `render()`.
- The default export is a node definition object, or an array of them. It is the same object that
  `defineNode()` takes (see `docs/ENGINE.md`): `id`, `title`, `category`, `description`, `inputs`,
  `outputs`, `params`, `render(ctx)`, optional `summary`, `maskable`, `keywords`.
- The `id` must be **namespaced** with a slash: `myname/effect` (lowercase, digits, dashes). Built-in
  ids have no slash, so plugins can never replace them. An id already used by another plugin is rejected.
- The same rules as built-in nodes apply (`docs/ENGINE.md`): premultiplied RGBA8 textures,
  `unit: 'px'` for lengths, animate only from `ctx.time.phase` with whole cycles, no hidden state,
  no `Math.random()` (derive noise from a seed param and hashes), `maskable: true` instead of writing
  your own mask/mix.

If the file fails to load (syntax error, invalid definition, taken id), nothing is registered and the
Plugins panel shows the error next to the file.

## Complete example

`public/plugins/example-glitch.js` in this repository (served at `plugins/example-glitch.js`):

```js
export default {
  id: 'example/glitch',
  title: 'Glitch Bands',
  category: 'filter',
  description: 'Shifts horizontal bands of the image sideways, like a broken video signal.',
  keywords: ['glitch', 'shift', 'datamosh', 'vhs'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    amount: { type: 'number', default: 24, min: 0, max: 400, step: 1, unit: 'px', label: 'Shift' },
    bands: { type: 'number', default: 12, min: 2, max: 120, step: 1, integer: true, label: 'Bands' },
  },
  summary: (p) => `${p.bands} bands`,
  render(ctx) {
    const image = ctx.gpu.pass({
      label: 'example-glitch',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { amount: ctx.params.amount, bands: ctx.params.bands },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let band = floor(uv.y * u.bands);
  let r = hash21(vec2f(band, 7.0)) * 2.0 - 1.0;
  let shift = select(0.0, r * u.amount / u.size.x, hash21(vec2f(band, 3.0)) > 0.5);
  return textureSampleLevel(src, smpNearest, vec2f(fract(uv.x + shift), uv.y), 0.0);
}`,
    });
    return { image };
  },
};
```

Things to notice: `amount` is a length (`unit: 'px'`), so `ctx.params.amount` is already in texels of
the input; the shader receives parameters as `u.<name>` and the output size as `u.size`; helpers such
as `hash21`, `unpremul`, `premul` come from the shader prelude (`src/engine/gpu/prelude.ts`).

## Installing, updating, removing

Install with the Plugins panel (choose the `.js` file). Installing a file with the same name
replaces the previous version. Removing a plugin unregisters its nodes; graphs that still use them
keep the nodes, which show an "Unknown node type (missing plugin?)" error until the plugin is
installed again. Installed plugins are re-registered automatically at every start-up.
