# Audio and MIDI engine (stream domain)

Audio nodes live in the same graph and use the same `defineNode` as image nodes, with categories
`audio-source`, `audio-fx`, `synth` (and `output` for `audio-out`) and socket types `audio` / `midi`.
They run in a "stream domain": instead of `render` a node provides `audio`, a pure block-DSP **kernel**.

```
Graph document ──► AudioGraphRunner (plain TS, no browser APIs)
                      │  compiles: nodes upstream of an audio-out, topologically ordered
                      │  process(): one 128-sample block at a time
        ┌─────────────┴──────────────┐
  worklet.ts (AudioWorkletProcessor)   offline.ts / tests (a plain loop)
  live: mic, Web MIDI, transport       live sources are silent
```

The same kernels and the same runner produce the sound you hear and the sound that is exported.
Format everywhere: stereo float32 at the context sample rate, 128-sample blocks.

## Files

| File | What |
| --- | --- |
| `api.ts` | Public interface used by `src/io` (`AudioEngine`, `createAudioEngine`, `renderAudioOffline`). |
| `index.ts` | Exports `createAudioEngine` and `renderAudioOffline`. |
| `types.ts` | The kernel contract (`AudioKernel`, `AudioIO`, `MidiEvent`, ...). **Read this first.** |
| `runner.ts` | `AudioGraphRunner`: compile, summing of wires, bypass, state keeping, fades, meters, NaN containment. |
| `engine.ts` | Main-thread host: AudioContext, microphone, Web MIDI, assets, transport, meters. Not testable headlessly. |
| `worklet.ts` | AudioWorklet entry. Bundled by Vite through `import ... from './worklet.ts?worker&url'`. |
| `nodes.ts` | Imports every audio node (only audio folders) for the worklet and tests. |
| `offline.ts` | `renderAudioOffline`. |
| `dsp.ts`, `limiter.ts`, `pitch.ts`, `scales.ts`, `pcm.ts`, `params.ts` | Shared helpers: biquads, delay line, polyBLEP, limiter, McLeod pitch, scales, resampling, param resolution. |
| `testing.ts` | Headless test helpers: signal generators, `runKernel`, `makeGraph`, `renderGraph`. |
| `protocol.ts` | Messages between `engine.ts` and `worklet.ts`. |

Node files: `src/engine/nodes/audio-source/`, `audio-fx/`, `synth/`.

## Adding an audio node: one file

Create `src/engine/nodes/<audio-source|audio-fx|synth>/<id>.node.ts` and a test next to it. It is picked up
automatically by the main registry (`nodes/index.ts`) and by the worklet (`audio/nodes.ts`).

```ts
import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

export default defineNode({
  id: 'my-gain',
  title: 'My Gain',                       // plain English, no jargon
  category: 'audio-fx',
  description: 'Makes a sound louder or quieter.',
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: { gain: { type: 'number', default: 0, min: -60, max: 24, unit: 'db', label: 'Volume' } },
  summary: (p) => `${p.gain} dB`,
  audio: defineAudio({
    create: () => ({ g: 1 }),                       // ALL state here
    process(st, io) {
      const src = io.in.audio;                      // null when nothing is wired
      if (!src) return;                             // outputs are pre-zeroed: silence
      const target = dbToLin(io.params.gain);
      const g0 = st.g;
      for (let i = 0; i < io.frames; i++) {
        const g = g0 + ((target - g0) * (i + 1)) / io.frames;   // per-block linear ramp: no zipper noise
        io.out.audio[0][i] = src[0][i] * g;
        io.out.audio[1][i] = src[1][i] * g;
      }
      st.g = target;
    },
  }),
});
```

### The kernel contract

* `create({ sampleRate, blockSize, nodeId })` returns the state object. Allocate **everything** here: delay lines,
  voices, tables. Use `ctx.nodeId` to seed random generators (`makeRng(nodeId)`).
* `process(state, io)` is called once per block with `io.frames <= 128` valid samples.
  * `io.in[name]`: `[L, R]` or `null`. Several wires into one input are **summed by the host** (that is what makes
    layering work). Inputs are **read-only**: they may be another node's output buffer.
  * `io.midiIn[name]`: events for this block, sorted by `offset`, all wires merged. Read-only, treat events as immutable.
  * `io.out[name]`: `[L, R]` pre-zeroed; write or add into it. Sinks (category `output`) also get `out.master`.
  * `io.midiOut[name]`: push events with `offset` inside the block. Cleared by the host every block.
  * `io.params`: resolved (defaults, clamping, valid enums). `io.sampleRate`, `io.time` (`seconds`, `sample`, `playing`,
    `loop`, `duration`, `bpm`), `io.assets.get(id)` (decoded PCM at the context rate), `io.live` (`mic`, `deviceMidi`,
    `uiMidi`).
* **Bypass is handled by the runner**: audio passes from the first audio input to each audio output, MIDI passes
  through, sources go silent. Do not implement it in the kernel.

### Rules

1. **No allocation in `process()`**: no `new`, array/object literals, closures, `.map`, `.subarray()`, spread. (MIDI event
   objects pushed to `midiOut` are the only accepted exception.) Allocate in `create`.
2. **Keep all state in the state object**; module-level variables must be constants. The runner keeps your state across
   param-only graph edits (matched by node id and type) and re-creates it when the type changes.
3. **No `Math.random()`**: use `makeRng(ctx.nodeId)` / `rand01(rng)` so renders and exports are reproducible.
4. **Handle null inputs** (return, leaving silence) and `required: true` is only a UI hint in the stream domain.
5. **Smooth parameter changes**: ramp gains and mixes linearly across the block; move filter coefficients at control
   rate or in sub-blocks; delay-time changes should glide.
6. **Stay finite**: no NaN/Infinity (the runner resets a kernel that produces them and counts it in `faultCount`).
   Use `fz()` on feedback paths and prefer float32 buffers (they flush denormals to zero).
7. **No imports besides `defineNode`, `audio/*` helpers and types**: the worklet bundle must not pull in image code,
   the DOM or WebGPU.
8. Every number param needs a plain-English `label`; give the node a `summary` line.
9. Write `<id>.test.ts` with `runKernel` and assert on real numbers (levels in dB, frequencies, sample positions).

## Layering

Wire any number of sources into one input: `audio-out` and `mixer` declare `multi: true` so the editor allows it,
and the runner sums the wires before the kernel sees them. A Volume & Pan node per layer balances them.

## Microphone to MIDI to synth

`microphone` has two outputs: `audio` (audible only when "Hear myself" is on, avoids feedback) and `tap` (always live).
Wire `tap` to `audio-to-midi`, its `midi` to a `synth` (optionally through `midi-transpose` / `chord` / `arpeggiator`),
and the synth to `audio-out`. `audio-to-midi` is a monophonic McLeod pitch tracker (NSDF on a window sized from the
lowest note, 10 ms hop) with a level gate, clarity threshold (Sensitivity), note confirmation and hysteresis
(Steadiness), optional scale snap and optional pitch-bend output.

## Not in v1

* **Plugins cannot add audio nodes.** The worklet only knows the built-in nodes (functions cannot be sent to it).
* **Number sockets are not wired in the stream domain**: params use the stored value. (Frame-domain number nodes cannot
  be read deterministically from the worklet.)
* **`audio-level` (audio drives visuals)** is future work for the same reason: the frame domain cannot read the live
  worklet deterministically. A deterministic route would be an offline analysis pass (per-frame level of the rendered
  audio) cached as an asset-like value.
* Sample-accurate transport inside the worklet is block-based; the main thread re-sends the transport on play, pause,
  seek and loop wrap.
* Topology rebuilds fade in over 10 ms (no fade-out of the old graph).
* MIDI file / clip playback node is not implemented.

## Testing

```
npx vitest run src/engine/audio src/engine/nodes/audio-source src/engine/nodes/audio-fx src/engine/nodes/synth
```

Everything runs headlessly (no Web Audio, no GPU). Performance tests print the real-time factor; they use the best of
several runs so a busy machine does not fail them spuriously.
