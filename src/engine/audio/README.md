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

## Sound to picture: the bridge

Goal: sing into the microphone and let the loudness (or pitch, or notes) move anything in the picture.

```
 stream domain (worklet / offline loop)              frame domain (per video frame)
 microphone.tap ─► audio-level kernel ─ io.signal('level', v) ─►  Host.signal(nodeId, 'level', seconds)
                                                                    │
                                          audio-level.render() ─► number output ─► (wire) ─► object-3d position
```

* A kernel publishes named scalars with `io.signal(name, value)` (latest value per block wins).
* The bridge nodes live in `src/engine/nodes/bridge/`, category `math`, and have BOTH an `audio` kernel (measure and
  publish) and a frame-domain `render` that only does `ctx.host.signal?.(ctx.nodeId, name, ctx.time.seconds) ?? 0`
  (reading `ctx.time` makes the node re-render every frame; the files import only audio code so the worklet stays clean).
* Nodes: **`audio-level`** (Sound to Numbers: `level` loudness, `peak`, `low`/`mid`/`high` bands, `pitch`),
  **`midi-value`** (MIDI to Numbers: `note`, `velocity`, `gate`, `count`, `cc`), **`midi-trigger`** (Note Pulse:
  `envelope` fired by every note-on).
* Loudness is RMS (20 ms mean-square window) followed by attack/release in ms, converted to dB and mapped from
  `floor`..`ceiling` (dB) to `from`..`to`, clamped. `pitch` is a 0..1 position between the lowest and highest note (then
  mapped to From..To), smoothed, and holds the last pitch while the voice is silent or unvoiced.
* **Tap nodes**: stream nodes with a stream input but no stream output are "analysis taps". The runner compiles and runs
  them (and everything upstream) even with no `audio-out`. `AudioEngine.hasSignals(graph, registry)` tells the host to
  start the engine for them; `hasAudio` still means "there is an audio output".
* **Live**: the worklet posts all signals ~60 Hz; `AudioEngine.signal(nodeId, name)` returns the latest value (0 if
  unknown). Wire the host's `Host.signal` to it.
* **Export**: `analyzeSignalsOffline(graph, registry, assets, { duration, fps, loop })` runs the same runner faster than
  real time and samples every signal once per video frame `f`: the value held at the END of that frame's span (sample
  `round((f+1)*sampleRate/fps)`). Kernels smooth their own measurements, so this is the smoothed value at that moment,
  not an average over the frame. `SignalTracks.value(nodeId, name, frameIndex)` looks it up. The host's `Host.signal` during
  export should return `tracks.value(nodeId, name, Math.round(seconds * fps))`.
* **Export limitation: live sources are silent offline** (record a take into a Timeline to export it, see below). A graph driven by the *microphone* or a *MIDI device*
  exports as the quiet values (zeros, or `From`), because there is no live input to analyse. To export an animation
  driven by singing: record the singing, import it as an audio file, and use `audio-file` instead of `microphone`
  (and `audio-to-midi` on the file for note-driven animation). The offline analysis of an `audio-file` is exact and
  repeatable.

### Worked example: sing to move a cube up and down

1. Add **Microphone** (turn on nothing else; leave "Hear myself" off) and **Sound to Numbers**.
2. Wire `Microphone.Silent tap` into `Sound to Numbers.Sound`.
3. Set Sound to Numbers: Quietest -50 dB, Loudest -10 dB, From `-1`, To `1` (the cube's vertical range), Rise 15 ms,
   Fall 200 ms.
4. Wire `Sound to Numbers.Loudness` into the 3D object's Position Y.
5. Press play and sing: the cube follows your volume. Wire `Pitch` into another setting (rotation, colour) to
   steer it with the pitch of your voice.
6. To export, record the take, add an **Audio File** with the recording and wire it into `Sound to Numbers` instead of
   the microphone.

For notes: Microphone.tap, Audio to MIDI, then `MIDI to Numbers` (`Note` for height, `Key down` for visibility) or
`Note Pulse` for a bounce on every note.

## Devices, microphones and the playable keyboard

* **Device dropdowns**: `microphone.device` and `midi-device.device` are `type: 'device'` params (value = device id,
  `''` = system default microphone / all MIDI devices). The UI fills the dropdown with
  `AudioEngine.listDevices('audio-input' | 'midi-input')` and refreshes it on `onDevicesChanged`. Microphone names are
  hidden by browsers until permission is granted, so before that the list has generic labels ("Microphone 1"); the engine
  announces a change as soon as a microphone is opened so labels fill in. Both calls never throw.
* **Several microphones**: the worklet has 4 inputs (`MAX_MICS`). The engine gives each microphone node its own
  MediaStream (exact `deviceId`, falling back to the default device with a console warning if it is gone), connects its source
  to worklet input *i* and tells the runner `{ nodeId: i }` ('micSlots'). The stream is reopened when the device or the
  browser-processing options change, and closed when the node is removed. Echo cancellation, noise suppression and auto gain
  are OFF by default (they ruin singing and pitch tracking); three bool params switch them on.
* **MIDI devices** are matched by `MidiEvent.device` = Web MIDI input id (`deviceName` carries the name, so old projects
  that stored part of a name still work).
* **Keyboard node** (`midi-keyboard`, `playable: true`): while selected, the UI turns computer keys into notes using
  `keyboard-map.ts` and calls `sendNote(nodeId, note, velocity, on)`. Layout (Ableton/GarageBand): A W S E D F T G Y H U J
  K O L P ; ' = C C# D D# E F F# G G# A A# B C C# D D# E F; digits 1-9 set `baseOctave` (5 is the normal range, the A
  key plays middle C = MIDI 60 at octave 5, `octave * 12` in general); Z / X octave down/up; C / V velocity down/up
  (`velocity` param, "key strength"). `sustain` (e.g. UI maps Shift to it) holds released notes; `latch` makes each key a
  toggle. The kernel only applies strength, `transpose`, sustain and latch: the UI sends absolute notes.
  `synth`, `pluck` and `drum` are deliberately NOT playable: they take MIDI from a Keyboard node (one clean path).

## Recording and the Timeline

The **Timeline** node (`audio-timeline`, "Timeline") is an Ableton-style arranger in one node: several audio and MIDI
tracks, clips you can offset, loop, fade and layer, and recording of new takes straight into it.

**Data.** The node's `clips` param is a `TimelineData` (exact JSON shape and every editing helper are in
`src/engine/audio/timeline.ts`: `addTrack`, `addAudioClip`, `addMidiClip`, `moveClip`, `trimClipStart/End`, `splitClip`,
`duplicateClip`, `mergeClips`, `quantizeClip`, `transposeClip`, `makeClipLoopCleanly`, `applyTake`, `audioClipToMidi`,
`normalizeTimeline` ...). The UI must edit it only through those helpers.

**Playback.** Clip starts are sample accurate. Overlapping clips sum (audio) or merge (MIDI). `loop` repeats the source
region and stays phase-locked to the clip start, hence to the project loop. Seek, pause and loop wrap send note-offs for
hanging notes. `wrap` lets a clip that passes the loop end continue from the loop start. Outputs: `audio` (all audio
tracks), `midi` (all MIDI tracks), `soloAudio` / `soloMidi` (only the track named in `outputTrack`; for separate
instruments the simplest route is several Timeline nodes, or one Timeline plus `outputTrack`). Track `gain`/`pan` apply to
audio tracks; `mute`/`solo` to both kinds. Export plays clips identically (same runner), so a recorded take exports.

**Wiring recipe**

```
Microphone.tap      ─► Timeline.recordAudio          (audio take)
MIDI Keyboard       ─► Timeline.recordMidi           (MIDI take; MIDI Device and Audio to MIDI work too)
Timeline.midi       ─► Synth (or any instrument)  ─► Mixer ─┐
Timeline.audio      ─────────────────────────────────► Mixer ─► Audio Out
```

**Recording API** (`AudioEngine`): `armRecording(nodeId, { track, kind })`, `startRecording()`, `stopRecording(): Promise<RecordedTake | null>`,
`recordingState()` (`phase`: idle / armed / count-in / recording, `seconds`, `countIn` seconds left, `level`, `error`).
Capture runs inside the worklet (sample accurate, lossless float32) and the whole take is posted when you stop
(not streamed in chunks: simpler and equally lossless; the worklet holds it in memory, bounded by the node's `maxLength`,
default 10 minutes, ending with a clear `error` message). Input latency (`baseLatency + outputLatency` plus the node's
`latencyOffsetMs`) is removed so overdubs line up with what was heard. Capture only advances while the transport plays.
**Count-in**: set `countIn` bars; `phase` is 'count-in' (clicks, if `metronome` is on) and the host should start the
transport when it becomes 'recording'. The metronome click is added to the Timeline's `audio` output only while counting in
or recording, so it is never in an export. `monitor` passes the record inputs through while armed.
**Loop recording**: when the transport loops while recording, the take has `passes` split exactly at the loop point.
`applyTake(timeline, take, { mode, assetIds })` puts it on the timeline: `overdub` (MIDI: all passes merged into one
looping clip as long as the loop; audio: each pass its own clip, stacked), `takes` (each pass a clip, all muted but the
last) or `replace` (like takes, and clips already there over that time range are removed). The caller stores each
`pcm` (`take.pcm`, or `passes[k].pcm`, which are views: copy them) as assets and passes the ids in order.

**Export and the microphone.** A live microphone or MIDI device is silent in an export. Record the take into a Timeline
and export that: the recorded clips play back exactly, including the sound-to-picture bridge (`audio-level` fed by the Timeline).

## Instruments (MIDI in, audio out)

All take MIDI from a Keyboard, MIDI Device, Arpeggiator, Audio to MIDI or a Timeline's `midi` output. A `preset` enum picks
a patch (a bundle of parameters); choose "Custom" to use the individual settings instead. Not playable from the computer
keyboard themselves: put a Keyboard node in front.

| Node id | Title | Presets | Notes |
| --- | --- | --- | --- |
| `synth` | Synth | (settings only) | Two-oscillator subtractive poly synth, polyBLEP, unison, filter envelope |
| `pluck` | Plucked String | | Karplus-Strong |
| `drum` | Drum Kit | | Simple kick, snare, hats on GM notes |
| `chip-synth` | Chiptune | NES lead, Game Boy pulse, C64-ish arpeggio, Triangle bass, Noise hi-hat, Noise snare | Pulse 12.5/25/50/75 %, stepped triangle, LFSR noise (long/short), 16-step volume, arpeggio, pulse-width sweep, vibrato, pitch slide, bit crush |
| `fm-synth` | FM Synth | Electric piano, Bell, FM bass, Brass, Glass pad | 4 operators, 6 algorithms, feedback, per-operator ratio/level/ADSR |
| `organ` | Organ | Jazz, Rock, Church, Ballad | 9 drawbars, key percussion, key click, rotary speaker |
| `strings-pad` | Strings & Pad | Warm pad, String machine, Choir-ish | Up to 7 detuned band-limited saws per note, filter, ensemble chorus, vowel formants |
| `bass` | Bass | Acid, Sub, Reese | Mono, saw/square/sub, 24 dB filter envelope, slide on overlapping notes, accent, drive |
| `sampler` | Sampler | | Plays an `assets` sound (a file or a recorded take) pitched by note, trim, loop, ADSR, one-shot, **slice mode** across keys |
| `drum-machine` | Drum Machine | | Kick, snare, clap, closed/open hat, tom, rim, cowbell with Tune/Decay/Level each, GM note map, **built-in step sequencer** |

**Drum machine sequencer.** `pattern` (json) is edited only through `src/engine/audio/drum-pattern.ts` (`emptyPattern`,
`defaultPattern`, `toggleStep`, `setStep`, `setSteps` 16/32, `setSwing`, `rotateVoice`, `fillEvery`, `euclidean`,
`randomizeVoice`, `clearVoice`, `normalizePattern` ...). Sixteenth-note steps; "Timing: tempo" uses the node's BPM,
"fit the pattern to the project length" stretches it over the project duration so it loops exactly. The sequencer runs
while the transport plays. A piano model is not included: the Sampler plays recorded or imported piano sounds.

## Not in v1

* **Plugins cannot add audio nodes.** The worklet only knows the built-in nodes (functions cannot be sent to it).
* **Number sockets are not wired in the stream domain**: params use the stored value. (Frame-domain number nodes cannot
  be read deterministically from the worklet.)
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
