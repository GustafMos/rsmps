# Contributing to RSMPS

Thanks for helping improve the tool. This project is MIT-licensed and aims to be a practical, local-first suite for game artists.

## Development

```bash
npm install
npm run dev        # the app (Vite)
npm run check      # typecheck + all tests
npm run build      # production web build
npm run build:cli  # headless CLI bundle
```

- Node 20+ and a GPU that WebGPU can use (tests run on the real GPU, headlessly).
- **Read [docs/ENGINE.md](docs/ENGINE.md) first.** It is short and it is the contract.

## Adding a node

Add one file, `src/engine/nodes/<category>/<id>.node.ts`, and its test next to it. There is nothing else to register:
menus, search, inspector controls and sockets come from the definition. Follow the rules in `docs/ENGINE.md`; each one
exists because breaking it caused a real bug.

Audio nodes: see `src/engine/audio/README.md`. Plugins: see `docs/PLUGINS.md`.

## Ground rules

- **Nodes are pure.** No state, no knowledge of the graph, files or UI.
- **Resolution independence.** Lengths use `unit: 'px'`; never scale by resolution yourself.
- **Loops by construction.** Animate from `ctx.time.phase` with whole cycles. Nothing animates by default.
- **GPU first.** No CPU pixel loops unless there is no GPU formulation.
- **No per-node UI code.** The interface is generated from definitions; add editors by parameter type, never by node id.
- **No hidden network calls.** Everything must work offline.
- **Crediting.** Any algorithm, palette or asset added must be credited with a link and license in `CREDITS.md`.

## Reporting bugs

Please include the graph file (File → Save), source dimensions and type, browser/OS/GPU, steps to reproduce, and
expected vs actual results.
