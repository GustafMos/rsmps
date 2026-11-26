/**
 * LOOP AUDIT: every node that can animate must repeat exactly over the project length with Loop on, WITHOUT the user choosing special
 * numbers. Each row turns the node's animation on with deliberately awkward values (speeds like 0.37 or 1.3, counts and periods that do
 * not divide the frame count, a 5-colour palette at speed 2, odd hold lengths, non-integer rates) and each row runs at loop lengths of
 * 24, 37 and 96 frames. `t.loopCheck` renders frames 0..N-1 and compares the WRAP step (N-1 -> 0) with the ordinary steps.
 *
 * Not covered here (cannot auto-loop, listed in `OUT_OF_SCOPE`): nodes driven by live input (phone motion / camera, microphone, webcam,
 * URL streams) and recorded takes (they have their own loop-blend option); nodes that read footage by seconds (Media In has its own
 * loop mapping, tested in lib/media-time); Freeze (a constant time) and Cache (serves a bake).
 *
 * The inventory (`loop-audit.tsv`, in the OS temp dir) is written by the first test of this file from the registry and the node sources.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineNode } from '../define';
import { Registry } from '../define';
import { registerBuiltins } from '../nodes';
import { array3dLoop } from '../nodes/generate/array-3d.node';
import { subtitleMotionHz } from '../nodes/generate/subtitles.node';
import { retimeLoop } from '../nodes/time/retime.node';
import { PNG_DIR, sheet, writePng } from '../lib/gen-3d-testutil';
import type { Host } from '../types';
import { LOOP_SEAM_OK, harness, type Harness, type LoopCheckOptions } from '../testing';

/** A white bar travelling once across a grey ramp per loop: a source that moves, and loops by construction. */
const audioBar = defineNode({
  id: 'audit-bar',
  title: 'Audit bar',
  category: 'input',
  description: 'Test source: a bar that travels once per loop.',
  keywords: [],
  inputs: {},
  outputs: { image: { type: 'image' } },
  params: { tint: { type: 'number', default: 0, min: 0, max: 1 } },
  render(ctx) {
    const phase = ctx.time.phase;
    const image = ctx.gpu.pass({
      label: 'audit-bar',
      size: ctx.canvas,
      uniforms: { phase, tint: ctx.params.tint },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = abs(fract(uv.x - u.phase + 0.5) - 0.5);
  let bar = select(0.0, 1.0, d < 0.1);
  let bg = 0.15 + 0.25 * uv.y;
  return vec4f(max(vec3f(bar), vec3f(bg, bg * (1.0 - u.tint), bg)), 1.0);
}`,
    });
    return { image };
  },
});

type InputKind = 'size' | 'img' | 'ring' | 'mov' | 'two' | 'none';
interface Row {
  id: string;
  /** What is awkward about it. */
  note: string;
  params: Record<string, unknown>;
  input?: InputKind;
  /** Output port to measure. */
  port?: string;
  /** Loop lengths (default 24, 37, 96). */
  lengths?: number[];
  /** Also require frame N (and beyond) to equal frame 0 bit for bit. */
  exact?: boolean;
  /** 'skip' = the content cuts by design (key frames, interleaved sources, a field order): only closing of the sequence (exact) is asserted. */
  seam?: 'skip';
  /** Largest acceptable seam ratio when the step sizes themselves are random (hashed poses): default LOOP_SEAM_OK. */
  tol?: number;
  /** Needs a host that can rasterise text. */
  text?: boolean;
  /** Minimum `motion` (default: must move). */
  motion?: number;
  /** Extra inputs by name. */
  extra?: (t: Harness) => Record<string, unknown>;
}

export const LENGTHS = [24, 37, 96];
const SIZE = 32;

/** A host with a fake text rasteriser (solid blocks), as the subtitles tests use: layout, atlas and drawing are real. */
const textHost: Host = {
  assetInfo: () => null,
  assetFrame: async () => null,
  rasterizeText: (spec) => {
    const pad = Math.ceil(spec.sizePx * 0.15) + 2;
    const adv = spec.sizePx * 0.5;
    const width = Math.ceil(spec.text.length * adv) + pad * 2;
    const lineH = Math.ceil(spec.sizePx * 1.2);
    const height = lineH + pad * 2;
    const data = new Uint8ClampedArray(width * height * 4);
    const gh = Math.round(spec.sizePx * 0.6);
    const top = pad + Math.round((lineH - gh) / 2);
    for (let c = 0; c < spec.text.length; c++) {
      if (spec.text[c] === ' ') continue;
      for (let y = top; y < top + gh; y++) for (let x = pad + Math.round(c * adv + adv * 0.1); x < pad + Math.round(c * adv + adv * 0.9); x++) data.set([255, 255, 255, 255], (y * width + x) * 4);
    }
    return { data, width, height };
  },
};

const PAL5: [number, number, number][] = [[1, 0.1, 0.1], [1, 0.8, 0.1], [0.2, 0.9, 0.3], [0.1, 0.6, 1], [0.7, 0.2, 0.9]];

/** Every animated node and the awkward configuration that must still loop. */
export const ROWS: Row[] = [
  // ---- generators -------------------------------------------------------------------------------------------------
  { id: 'noise', note: 'evolution 0.37', params: { evolution: 0.37, scale: 20 }, input: 'size', exact: true },
  { id: 'noise', note: 'evolution 1.3', params: { evolution: 1.3, scale: 20 }, input: 'size', exact: true },
  { id: 'gradient', note: 'scroll 1 conical', params: { animate: 'scroll', kind: 'conical', cycles: 1, repeat: 'clamp' }, input: 'size', exact: true },
  { id: 'gradient', note: 'rotate 3 linear mirror', params: { animate: 'rotate', kind: 'linear', cycles: 3, repeat: 'mirror' }, input: 'size', exact: true },
  { id: 'gradient', note: 'scroll 2 radial repeat', params: { animate: 'scroll', kind: 'radial', cycles: 2, repeat: 'repeat' }, input: 'size', exact: true },
  { id: 'pattern', note: 'hex scroll 1 / -3', params: { kind: 'hex', cellSize: 10, lineWidth: 3, scrollX: 1, scrollY: -3, angle: 17 }, input: 'size', exact: true },
  { id: 'pattern', note: 'bricks scroll X 3 alone', params: { kind: 'bricks', cellSize: 9, lineWidth: 2, scrollX: 3, scrollY: 0 }, input: 'size', exact: true },
  { id: 'pattern', note: 'checker scroll Y 3 alone', params: { kind: 'checker', cellSize: 7, scrollX: 0, scrollY: 3 }, input: 'size', exact: true },
  { id: 'pattern', note: 'dots scroll 5 / 2', params: { kind: 'dots', cellSize: 8, lineWidth: 3, scrollX: 5, scrollY: 2 }, input: 'size', exact: true },
  { id: 'voronoi', note: 'cells motion 0.37 cycles 3', params: { mode: 'cells', scale: 12, motion: 0.37, cycles: 3 }, input: 'size', exact: true },
  { id: 'voronoi', note: 'crackle cycles 5', params: { mode: 'crackle', scale: 12, motion: 0.8, cycles: 5 }, input: 'size', exact: true },
  { id: 'particles', note: 'snow cycles 3, 137 particles', params: { preset: 'snow', cycles: 3, count: 137, particleSize: 3 }, input: 'size', exact: true },
  { id: 'particles', note: 'sparks cycles 5', params: { preset: 'sparks', cycles: 5, count: 91, particleSize: 3 }, input: 'size', exact: true },
  { id: 'particles', note: 'fireflies cycles 7', params: { preset: 'fireflies', cycles: 7, count: 60, particleSize: 3 }, input: 'size', exact: true },
  { id: 'object-3d', note: 'spin Y 1 alone', params: { shape: 'cube', spinY: 1, cameraType: 'perspective' }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'object-3d', note: 'spin X 3 + Z -2', params: { shape: 'cube', spinX: 3, spinZ: -2, cameraType: 'perspective' }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'object-3d', note: 'deform noise cycles 3 alone', params: { shape: 'sphere', dNoise: 0.2, dNoiseCycles: 3 }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'object-3d', note: 'deform explode cycles 2 alone', params: { shape: 'sphere', dExplode: 0.4, dExplodeCycles: 2 }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'object-3d', note: 'camera orbit 3', params: { shape: 'cube' }, input: 'size', lengths: [24, 37], exact: true, extra: () => ({ camera: { node: 'camera', params: { motion: 'orbit', cycles: 3 } } }) },
  { id: 'object-3d', note: 'camera sway 3', params: { shape: 'cube' }, input: 'size', lengths: [24, 37], exact: true, extra: () => ({ camera: { node: 'camera', params: { motion: 'sway', cycles: 3, motionAmount: 0.8 } } }) },
  { id: 'object-3d', note: 'hologram scan 3', params: { shape: 'sphere' }, input: 'size', lengths: [24, 37], exact: true, extra: () => ({ material: { node: 'material', params: { model: 'hologram', holoCycles: 3 } } }) },
  { id: 'sdf-3d', note: 'spin 2 alone', params: { shape1: 'sphere', shape2: 'off', size1: 0.8, spinY: 2 }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'sdf-3d', note: 'deform noise 3 alone', params: { shape1: 'sphere', shape2: 'off', size1: 0.8, dNoise: 0.25, dNoiseCycles: 3 }, input: 'size', lengths: [24, 37], exact: true },
  { id: 'image-to-3d', note: 'spin 1 / 2', params: { spinY: 1, spinZ: 2 }, input: 'img', lengths: [24, 37], exact: true },
  { id: 'array-3d', note: 'travel 3 orbit 1', params: { layout: 'grid', countX: 3, countY: 3, countZ: 5, travel: 3, orbit: 1 }, input: 'img', lengths: [24, 37], exact: true },
  { id: 'array-3d', note: 'tunnel travel 1, colour by card, 7 rings', params: { layout: 'tunnel', countX: 4, countZ: 7, radius: 1.5, travel: 1, colourBy: 'card', tintMode: 'multiply', hueStep: 40 }, input: 'img', lengths: [24, 37] },
  { id: 'array-3d', note: 'helix travel 2, card hue + brightness', params: { layout: 'helix', countZ: 9, radius: 1.5, travel: 2, colourBy: 'card', hueStep: 33, brightnessStep: 0.05 }, input: 'img', lengths: [24, 37] },
  { id: 'array-3d', note: 'grid travel 4, tint by depth', params: { layout: 'grid', countX: 3, countY: 2, countZ: 6, travel: 4, colourBy: 'depth', tintMode: 'multiply' }, input: 'img', lengths: [24, 37] },
  { id: 'subtitles', note: 'wave motion at 1.3 Hz', params: { preset: 'custom', motion: 'wave', motionSpeed: 1.3, motionAmount: 0.4, loopWithProject: true, animIn: 'none', animOut: 'none', fontSize: 14, stroke: 0 }, input: 'size', lengths: [24, 37], text: true },
  { id: 'subtitles', note: 'float motion at 0.37 Hz, speed 1.3', params: { preset: 'custom', motion: 'float', motionSpeed: 0.37, motionAmount: 0.4, speed: 1.3, animIn: 'none', animOut: 'none', fontSize: 14, stroke: 0 }, input: 'size', lengths: [24, 37], text: true },
  // ---- picture effects with their own motion -----------------------------------------------------------------------
  { id: 'displace', note: 'evolution 0.37', params: { amount: 6, scale: 16, evolution: 0.37 }, input: 'img', exact: true },
  { id: 'wave-warp', note: 'wave X 3 alone', params: { waveX: 5, waveXLength: 24, waveXCycles: 3 }, input: 'img', exact: true },
  { id: 'wave-warp', note: 'wave Y -2 alone', params: { waveY: 4, waveYLength: 30, waveYCycles: -2 }, input: 'img', exact: true },
  { id: 'wave-warp', note: 'noise evolution 1.3 alone', params: { noiseAmount: 4, noiseScale: 20, noiseEvolution: 1.3 }, input: 'img', exact: true },
  { id: 'pixel-sort', note: 'sweep 3', params: { spans: 'brightness', low: 0.2, high: 0.6, sweepCycles: 3, sweepAmount: 0.2 }, input: 'img', exact: true },
  { id: 'chroma-smear', note: 'hue cycles 3', params: { paletteMix: 1, hueCycles: 3 }, input: 'img', exact: true },
  { id: 'contour-lines', note: 'cycles -3 alone', params: { count: 4, cycles: -3 }, input: 'img', exact: true },
  { id: 'contour-lines', note: 'wobble evolution 1.3 alone', params: { count: 4, wobble: 6, wobbleEvolution: 1.3 }, input: 'img', exact: true },
  { id: 'scanlines', note: 'cycles 3', params: { spacing: 7, strength: 0.8, cycles: 3 }, input: 'img', exact: true },
  { id: 'displace-map', note: 'map scroll 3 / -2', params: { amountX: 8, amountY: 8, scrollX: 3, scrollY: -2 }, input: 'img', exact: true, extra: (t) => ({ map: t.fromFn(SIZE, SIZE, (x, y) => [(x * 29) & 255, (y * 41) & 255, 128, 255]) }) },
  { id: 'material-2d', note: 'light sweep 3', params: { sweep: 3 }, input: 'img', exact: true },
  { id: 'scroll', note: 'X 3 alone', params: { cyclesX: 3, cyclesY: 0, filter: 'linear' }, input: 'img', exact: true },
  { id: 'scroll', note: 'Y -1 alone', params: { cyclesX: 0, cyclesY: -1, filter: 'linear' }, input: 'img', exact: true },
  { id: 'kaleidoscope', note: 'spin 3 alone', params: { mode: 'kaleidoscope', segments: 5, spin: 3 }, input: 'img', exact: true },
  { id: 'kaleidoscope', note: 'mirror scroll 0.37 / 1.3 alone', params: { mode: 'mirror', scroll: [0.37, 1.3] }, input: 'img', exact: true },
  { id: 'kaleidoscope', note: 'tunnel fall 3 with twist 0.37', params: { mode: 'logpolar', segments: 5, twist: 0.37, fall: 3 }, input: 'img', exact: true },
  { id: 'kaleidoscope', note: 'tunnel fall 2 with twist 1.5 and spin 1', params: { mode: 'logpolar', segments: 4, twist: 1.25, fall: 2, spin: 1 }, input: 'img', exact: true },
  { id: 'parallax', note: 'sway-h cycles 3', params: { motion: 'sway-h', amount: 8, cycles: 3 }, input: 'two', exact: true },
  { id: 'parallax', note: 'circle cycles 3', params: { motion: 'circle', amount: 8, cycles: 3 }, input: 'two', exact: true },
  { id: 'parallax', note: 'figure-eight cycles 5', params: { motion: 'figure-eight', amount: 8, cycles: 5 }, input: 'two', exact: true },
  { id: 'depth-scan', note: 'scan wave, 1 sweep', params: { sweep: 1 }, input: 'two', exact: true },
  { id: 'depth-scan', note: 'contours flowing backwards, 6 lines', params: { style: 'contours', count: 6, sweep: -2 }, input: 'two', exact: true },
  { id: 'style-melt', note: 'held at 40 %, patches churn', params: { progress: 0.4, churn: 1 }, input: 'two', exact: true },
  { id: 'style-melt', note: 'A to B and back over the loop', params: { drive: 'pingpong', churn: 1 }, input: 'two', exact: true },
  { id: 'transition-auto', note: 'ping-pong, start 0.37', params: { mode: 'bayer-4', cell: 1, start: 0.37, duration: 0.21, pingPong: true, holdB: 0.13 }, input: 'two', exact: true },
  { id: 'custom-shader', note: 'default animated glow', params: {}, input: 'none', exact: true },
  // ---- per-frame hashes / events ----------------------------------------------------------------------------------
  { id: 'grain', note: 'hold 5', params: { amount: 0.5, hold: 5, animated: true }, input: 'img', exact: true },
  { id: 'grain', note: 'hold 7', params: { amount: 0.5, hold: 7, animated: true }, input: 'img', exact: true },
  { id: 'paper-texture', note: 'boil 5 poses hold 3 (random pose jumps vary in size)', tol: 2, params: { amount: 1, boil: 0.1, boilPoses: 5, boilHold: 3 }, input: 'img', extra: (t) => ({ texture: t.fromFn(24, 24, (x, y) => [((x * 7 + y * 13) % 255) | 0, 90, 200, 255]) }), exact: true },
  { id: 'paper-texture', note: 'boil 4 poses hold 1', params: { amount: 1, boil: 0.1, boilPoses: 4, boilHold: 1 }, input: 'img', extra: (t) => ({ texture: t.fromFn(24, 24, (x, y) => [((x * 7 + y * 13) % 255) | 0, 90, 200, 255]) }), exact: true },
  { id: 'glass', note: 'strips, hand sway and drift', params: { sway: 10, drift: 0.05 }, input: 'img', exact: true, lengths: [24, 37] },
  { id: 'glass', note: 'prism spinning on two axes', params: { shape: 'prism', sway: 0, drift: 0, spinTurn: 1, spinRoll: 2 }, input: 'img', exact: true, lengths: [24] },
  { id: 'droste', note: 'flower with spinning petals and whirl', params: { shape: 'flower', petals: 6, petalSpin: 1, twist: 0.8, zoom: 1 }, input: 'img', exact: true },
  { id: 'droste', note: 'zoom 1 with one arm', params: { zoom: 1, arms: 1 }, input: 'img', exact: true },
  { id: 'droste', note: 'zoom -2 spin 1 round', params: { zoom: -2, spin: 1, shape: 'round' }, input: 'img', exact: true },
  { id: 'hyperbolic', note: 'spin 1 and drift', params: { spin: 1, drift: 0.3 }, input: 'img', exact: true },
  { id: 'liquid-warp', note: 'marble flow 1', params: { look: 'marble', flow: 1 }, input: 'img', exact: true },
  { id: 'mandelbulb', note: 'orbit 1 and morph, quarter size', params: { orbit: 1, morph: 1, resolution: 'quarter', steps: 32 }, input: 'size', exact: true, lengths: [24] },
  { id: 'hypercube', note: '5D chaos at speed 2 with hand sway', params: { dimensions: '5', motion: 'chaos', speed: 2, sway: 10, swaySpeed: 0.7 }, input: 'size', exact: true },
  { id: 'hypercube', note: '6D custom folds, picture on the inner cube', params: { dimensions: '6', motion: 'custom', turnCycles: 1, tumbleCycles: -2, fold4: 1, fold5: 3, fold6: -1, colorBy: 'depth' }, input: 'img', exact: true },
  { id: 'hypercube', note: '4D inside out, thick lines', params: { dimensions: '4', motion: 'insideOut', thickness: 0.03 }, input: 'size', exact: true },
  { id: 'reaction-diffusion', note: 'flow 0.6', params: { flow: 0.6, rounds: 3 }, input: 'size', exact: true, lengths: [24] },
  { id: 'fractal', note: 'mandelbrot colours 1, spin 1, breathing', params: { cycle: 1, spin: 1, breathe: 1 }, input: 'size', exact: true },
  { id: 'fractal', note: 'julia morphing', params: { kind: 'julia', orbit: 0.1, cycle: 2 }, input: 'size', exact: true },
  { id: 'fractal-mirror', note: 'spin 1 and breathing', params: { spin: 1, breathe: 0.1 }, input: 'img', exact: true },
  { id: 'kaleido-regions', note: 'hexagons spin 1 counter', params: { spin: 1 }, input: 'img', exact: true },
  { id: 'film-gauge', note: 'super 8: grain, weave, dust per frame', params: { gauge: 'super8' }, input: 'img', exact: true, seam: 'skip' },
  { id: 'gate-weave', note: 'worn projector, per film frame', params: { look: 'worn' }, input: 'img', exact: true, seam: 'skip' },
  { id: 'camera-shake', note: 'handheld, no blur', params: { look: 'handheld', blur: 0 }, input: 'img', exact: true },
  { id: 'camera-shake', note: 'walking with shutter blur', params: { look: 'walking', blur: 0.5 }, input: 'img', exact: true },
  { id: 'light-leak', note: 'warm leak', params: { look: 'warm' }, input: 'img', exact: true },
  { id: 'specks', note: 'flicker 7 alone', params: { amount: 0.8, animate: true, speckFlicker: 7 }, input: 'img', exact: true },
  { id: 'specks', note: 'drift X 3 alone', params: { amount: 0.8, animate: true, speckFlicker: 0, speckDriftX: 3 }, input: 'img', exact: true },
  { id: 'specks', note: 'drift Y -1 alone', params: { amount: 0.8, animate: true, speckFlicker: 0, speckDriftY: -1 }, input: 'img', exact: true },
  { id: 'specks', note: 'rolling band 3 alone', params: { amount: 0.8, animate: true, speckFlicker: 0, speckBand: 'rolling', speckBandCycles: 3 }, input: 'img', exact: true },
  { id: 'analog-video', note: 'roll 3 alone', params: { animate: true, rollCycles: 3 }, input: 'img', exact: true },
  { id: 'analog-video', note: 'wobble 5 alone', params: { animate: true, wobble: 3, wobbleCycles: 5 }, input: 'img', exact: true },
  { id: 'analog-video', note: 'tracking band 2 alone', params: { animate: true, tracking: 0.6, trackCycles: 2 }, input: 'img', exact: true },
  { id: 'analog-video', note: 'noise + jitter + tearing (hashed per frame)', params: { animate: true, noise: 0.3, jitter: 2, tearing: 0.4, headSwitch: 0.5 }, input: 'img', exact: true },
  { id: 'analog-video', note: 'dropouts flicker 7', params: { animate: true, dropouts: 0.6, speckFlicker: 7 }, input: 'img', exact: true },
  { id: 'crt-display', note: 'noise alone', params: { outputScale: 'same', noise: 0.5 }, input: 'img', exact: true },
  { id: 'crt-display', note: 'hum 3 alone', params: { outputScale: 'same', hum: 0.8, humCycles: 3 }, input: 'img', exact: true },
  { id: 'crt-display', note: 'interlace alone', params: { outputScale: 'same', interlace: 0.8 }, input: 'img', exact: true, seam: 'skip' },
  { id: 'crt-display', note: 'persistence 3 on a moving source', params: { outputScale: 'same', persistence: 3, persistDecay: 0.6 }, input: 'mov', exact: true },
  { id: 'glitch', note: 'rate 3.7 hold 3 reroll 5', params: { rate: 3.7, burst: 0.4, hold: 3, reroll: 5, calm: 0.5, seed: 3 }, input: 'img', exact: true },
  { id: 'glitch', note: 'rate 1.3 reroll 7', params: { rate: 1.3, burst: 0.5, hold: 2, reroll: 7, calm: 0.2, seed: 9 }, input: 'img', exact: true },
  { id: 'glitch', note: 'rate 0.37 bursts, time tear + stutter (moving)', params: { rate: 0.37, burst: 0.5, hold: 2, reroll: 7, calm: 0.2, kTimeTear: 0.8, kStutter: 0.8, seed: 9 }, input: 'mov', exact: true },
  // ---- duplicating / compound sequences -----------------------------------------------------------------------------
  { id: 'infinite-zoom', note: 'palette 5, speed 2, colours attached', params: { scale: 0.45, levels: 8, speed: 2, recolor: 'fill', palette: PAL5, attached: true }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'palette 2, speed 3, tint', params: { scale: 0.45, levels: 8, speed: 3, recolor: 'multiply', palette: PAL5.slice(0, 2), attached: true }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'hue step 37 deg per level, speed 2', params: { scale: 0.45, levels: 8, speed: 2, hueStep: 37, attached: true, rotatePerLevel: 13, spiral: 0.5 }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'speed -3 rising, palette 4', params: { scale: 0.5, levels: 7, speed: -3, recolor: 'fill', palette: PAL5.slice(0, 4), attached: true }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'snap travel, palette 3, speed 4', params: { scale: 0.5, levels: 7, speed: 4, recolor: 'fill', palette: PAL5.slice(0, 3), attached: true, colorLoop: 'snap' }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'stretch palette 5, speed 2 + hue 20', params: { scale: 0.5, levels: 7, speed: 2, recolor: 'multiply', palette: PAL5, hueStep: 20, attached: true, colorLoop: 'stretch' }, input: 'ring', exact: true },
  { id: 'infinite-zoom', note: 'speed 1 with a fade and a 5-colour palette', params: { scale: 0.6, levels: 12, speed: 1, fade: 0.1, recolor: 'fill', palette: PAL5, attached: true }, input: 'ring', exact: true },
  { id: 'array', note: 'infinite scroll 1, hue 90 over 2 columns', params: { mode: 'infinite', columns: 2, rows: 1, spacing: [0, 0], scrollX: 1, hueStep: 90, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'infinite scroll 1/-2, 3x2 tint', params: { mode: 'infinite', columns: 3, rows: 2, spacing: [0, 0], scrollX: 1, scrollY: -2, tintMode: 'multiply', hueStep: 30, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'grid scroll 2 with brightness step', params: { mode: 'grid', columns: 3, rows: 3, scrollX: 2, brightnessStep: 0.1, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'grid scroll 1 alone (finite grid)', params: { mode: 'grid', columns: 4, rows: 2, scrollX: 1, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'infinite fade 0.8 with scroll X 1, 3 columns', params: { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollX: 1, fade: 0.8, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'brick offset, odd vertical scroll', params: { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollY: 1, stagger: 0.5, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'mirrored tiles, odd horizontal scroll', params: { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollX: 1, mirror: 'x', outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'jitter + scroll 1 (rounded to whole tiles)', params: { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollX: 1, jitterPos: 20, jitterRotate: 20, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'sprite sheet sequence + scroll 1', params: { mode: 'infinite', columns: 3, rows: 2, spacing: [0, 0], scrollX: 1, sheetColumns: 2, sheetRows: 2, outputSize: 'input' }, input: 'img', exact: true },
  { id: 'array', note: 'time slices of a moving source', params: { mode: 'grid', columns: 3, rows: 2, timeSlices: 5, timeStep: 7, outputSize: 'input' }, input: 'mov', exact: true },
  // ---- nodes that read other moments ----------------------------------------------------------------------------------
  { id: 'echo', note: 'count 5 spacing 0.37 s', params: { count: 5, spacing: 0.37 }, input: 'mov', exact: true },
  { id: 'feedback', note: 'memory 24 (does not divide)', params: { memory: 24, decay: 0.9, zoom: 1.03, rotate: 3 }, input: 'mov', exact: true },
  { id: 'feedback-trail', note: 'time echoes 8 spacing 3', params: { mode: 'time', echoes: 8, spacing: 3, decay: 0.8 }, input: 'mov', exact: true },
  { id: 'frame-blend', note: 'radius 3', params: { radius: 3 }, input: 'mov', exact: true },
  { id: 'rgb-delay', note: 'red -5 blue 7 frames', params: { redFrames: -5, greenFrames: 0, blueFrames: 7 }, input: 'mov', exact: true },
  { id: 'slit-scan', note: 'range 24 slices 7', params: { direction: 'columns', range: 24, slices: 7 }, input: 'mov', exact: true },
  { id: 'time-displace', note: 'range 1.3 s slices 7', params: { range: 1.3, slices: 7, direction: 'past' }, input: 'mov', exact: true, extra: (t) => ({ map: t.fromFn(SIZE, SIZE, (x) => [x * 8, x * 8, x * 8, 255]) }) },
  { id: 'time-offset', note: 'offset 0.37 s wrap', params: { offset: 0.37, wrap: true }, input: 'mov', exact: true },
  { id: 'retime', note: 'speed 1.3', params: { speed: 1.3 }, input: 'mov', exact: true },
  { id: 'retime', note: 'speed 0.37', params: { speed: 0.37 }, input: 'mov', exact: true },
  { id: 'retime', note: 'speed 2.5 stop-motion 7 fps', params: { speed: 2.5, holdFps: 7 }, input: 'mov', exact: true },
  { id: 'retime', note: 'reverse speed 1.7', params: { speed: 1.7, reverse: true }, input: 'mov', exact: true },
  { id: 'retime', note: 'ping-pong speed 1', params: { speed: 1, pingPong: true }, input: 'mov', exact: true },
  { id: 'loop', note: 'blend 0.5 s on a source that does not loop', params: { blend: 0.5 }, input: 'mov', exact: true },
  { id: 'motion-smear', note: 'refresh 24 (a key frame is a hard cut by design)', params: { refresh: 24, hold: -1, bleed: 1 }, input: 'mov', exact: true, seam: 'skip' },
  { id: 'motion-smear', note: 'refresh 5 hold 3', params: { refresh: 5, hold: 3, bleed: 1 }, input: 'mov', exact: true },
  { id: 'datamosh', note: 'hold 0.3 + 0.4, refresh 7', params: { holdStart: 0.3, holdLength: 0.4, refreshEvery: 7, maxFrames: 12 }, input: 'mov', exact: true },
  { id: 'frame-array', note: 'stack, frames flow past, orbit 1 with sway', params: { orbit: 1, sway: 6, count: 6 }, input: 'mov', exact: true },
  { id: 'frame-array', note: 'helix, flow over 37% of the loop (rounded to whole steps)', params: { layout: 'helix', arc: 540, count: 7, span: 0.37 }, input: 'mov', exact: true },
  { id: 'frame-array', note: 'grid 2x2x3, every pane plays, custom travel 2', params: { layout: 'grid', gridX: 2, gridY: 2, gridZ: 3, flow: 'custom', travel: 2, span: -0.6, now: 'middle' }, input: 'mov', exact: true },
  { id: 'frame-array', note: 'ring of still frames with a playhead, add blend', params: { layout: 'ring', count: 5, flow: 'sheet', span: 1, blend: 'add', opacity: 0.7, swingCycles: 2 }, input: 'mov', exact: true },
  { id: 'frame-array', note: 'tunnel of 8, flow, seen from inside', params: { layout: 'tunnel', count: 8, yaw: 0, tilt: 0, swing: 0, distance: 0.45, fov: 70 }, input: 'mov', exact: true },
  { id: 'frame-interleave', note: 'two sources, pattern 2 1, hold 3 (a hard cut by design)', params: { mode: 'in-step', pattern: '2 1', hold: 3, count: 2, timing: 'same-length' }, input: 'none', exact: true, seam: 'skip', extra: () => ({ sources: [{ node: 'audit-bar' }, { node: 'audit-bar', params: { tint: 1 } }] }) },
  { id: 'detect-motion', note: 'mask of a moving bar', params: { frames: 2, threshold: 0.05 }, port: 'mask', input: 'mov', exact: true },
  { id: 'optical-flow', note: 'flow of a moving bar', params: { resolution: 0.5 }, port: 'flow', input: 'mov', exact: true },
  // ---- numbers ------------------------------------------------------------------------------------------------------------
  { id: 'animate', note: 'noise wave 3', params: { wave: 'noise', cycles: 3, from: 0, to: 10 }, input: 'none', port: 'value', exact: true },
  { id: 'animate', note: 'steps 7 x 3 with offset', params: { wave: 'steps', steps: 7, cycles: 3, phase: 0.37 }, input: 'none', port: 'value', exact: true, motion: 0.1, seam: 'skip' },
  { id: 'animate', note: 'sine 5', params: { wave: 'sine', cycles: 5, phase: 0.1 }, input: 'none', port: 'value', exact: true },
  { id: 'keyframes', note: 'repeat 3 default curve', params: { repeat: 3, loop: 'project' }, input: 'none', port: 'value', exact: true },
  { id: 'keyframes-xy', note: 'closed path repeat 3', params: { repeat: 3, loop: 'project' }, input: 'none', port: 'x', exact: true },
  { id: 'keyframes-color', note: 'palette repeat 3', params: { repeat: 3, loop: 'project' }, input: 'none', port: 'color', exact: true },
];

/** Nodes that animate or read the clock but cannot or need not auto-loop here. */
export const OUT_OF_SCOPE: Record<string, string> = {
  'phone-motion': 'live sensor input (and a recorded take with its own loop blend)',
  'phone-camera': 'live phone camera',
  'ar-camera': 'live sensor input: a camera that follows the phone (and a recorded take with its own loop blend)',
  'marker-camera': 'follows a marker in the picture it is given (a live camera or a clip): its motion is the footage\'s, there is nothing to loop',
  'world-ar': 'live AR view on the phone (camera follows the phone in the room, a recorded take has its own loop blend); outside an AR session it is a still camera; its Picture output is the live camera (AR camera frame, or the back camera)',
  'camera-in': 'live webcam',
  'url-in': 'live stream',
  'audio-level': 'live audio level',
  oscilloscope: 'live audio wave',
  'midi-trigger': 'live MIDI',
  'midi-value': 'live MIDI',
  'media-in': 'reads footage; its own loop / in-out mapping (lib/media-time)',
  freeze: 'constant moment: nothing to loop',
  cache: 'serves a bake of whatever it was fed',
  'datamosh-real': 'serves a stored mosh of whatever it was fed; a decoded video stream has a first frame, so its loop seam is a key frame by nature',
  'style-transfer-ai': 'serves a stored painting of a transition from A to B; "A to B and back" loops, "A to B over the loop" jumps back to A at the wrap by design',
  'white-balance': 'analysis frozen at one frame',
  palette: 'extraction frozen at one frame',
  'media-timeline': 'an edit decides what plays; its clips wrap through ctx.pull (tested in media-timeline.test.ts)',
  time: 'outputs the clock itself (phase / frame / seconds)',
  'image-to-splats': 'static unless its input moves',
  track: 'process node (analysis of the whole clip)',
  'region-trails': 'draws the trails of tracked regions (needs a tracker upstream)',
  smooth: 'loopAware history (tested in math tests)',
  hold: 'loopAware history (tested in math tests)',
  'delay-value': 'loopAware history (tested in math tests)',
  camera: 'outputs a camera value; its motion is checked through the object-3d rows (camera orbit / sway)',
  material: 'outputs a material; its hologram scan is checked through an object-3d row',
  'sprite-sheet-in': 'plays the cells of a sheet in seconds, like Media In: it has its own Loop option',
  'beat-detect': 'numbers driven by the music: the sound decides (it is loop-aware: it reads project.loop for its wrap)',
  'splat-train': 'like splat-3d (spin is phase x whole cycles); its camera path is keyed by clip time, a recorded take',
  'batch-palette': 'a process (whole-clip palette analysis) and one frozen frame: nothing animates',
  'palette-lock': 'reads the frame only to key a memo of an analysis',
  'model-3d': 'needs a model asset: spin is phase x whole cycles (3D family, checked through object-3d / sdf-3d rows; its own test uses loopCheck)',
  'splat-3d': 'needs a splat asset: spin is phase x whole cycles (its own test uses loopCheck)',
  'depth-ai': 'owned by the AI-depth work: temporal smoothing pulls neighbouring frames (not touched here)',
  'render-scale': 'pulls at another resolution, not another time',
  'sweep-360': 'live sensor input: paints the camera into a canvas that keeps its history from frame to frame (live phone sweep; with Loop on the first frame continues from the last, so it never resets by itself)',
};

const inputsFor = (t: Harness, row: Row): Record<string, never> => {
  const still = t.fromFn(SIZE, SIZE, (x, y) => [(x * 8) & 255, (y * 8) & 255, 120 + ((x ^ y) & 1) * 80, 255]);
  const ring = t.fromFn(SIZE, SIZE, (x, y) => (Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) < 6 ? [200, (x * 8) & 255, (y * 8) & 255, 255] : [0, 0, 0, 0]));
  const still2 = t.fromFn(SIZE, SIZE, (x, y) => [(y * 8) & 255, 40, (x * 8) & 255, 255]);
  const base: Record<string, unknown> =
    row.input === 'img' ? { image: still } : row.input === 'ring' ? { image: ring } : row.input === 'mov' ? { image: { node: 'audit-bar' } } : row.input === 'two' ? (row.id === 'depth-scan' ? { image: still, depth: still2 } : row.id === 'parallax' ? { background: still, layers: [still2] } : { a: still, b: still2 }) : {};
  return { ...base, ...(row.extra ? row.extra(t) : {}) } as never;
};

/** AUDIT_LOOP_OFF=1 runs the same table with Loop OFF: the rows that fail there are the ones the loop switch (and loop snapping) is responsible for. */
const project = (frames: number): LoopCheckOptions => ({ frames, fps: 8, size: SIZE, project: process.env.AUDIT_LOOP_OFF ? { loop: false } : undefined });

describe('loop audit', () => {
  it('writes the inventory (loop-audit.tsv in the OS temp dir)', () => {
    const reg = new Registry();
    registerBuiltins(reg);
    const root = join(__dirname, '..', 'nodes');
    const files = new Map<string, string>();
    for (const cat of readdirSync(root, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      for (const f of readdirSync(join(root, cat.name))) if (f.endsWith('.node.ts')) files.set(f.replace('.node.ts', ''), readFileSync(join(root, cat.name, f), 'utf8'));
    }
    const tested = new Set(ROWS.map((r) => r.id));
    const lines = ['id\tcategory\tmotion params\ttime reads\tloop-aware pulls\tpulls other times\thash per frame\tlive\taudit'];
    let animated = 0;
    for (const d of reg.list()) {
      if (/audio|synth/.test(d.category)) continue;
      const src = files.get(d.id.replace(/^.*\//, '')) ?? '';
      const reads = [
        /time\.phase|\.phase\b/.test(src) ? 'phase' : '',
        /time\.seconds|\bseconds\b/.test(src) && /ctx\.time/.test(src) ? 'seconds' : '',
        /time\.frame|loopFrame/.test(src) ? 'frame' : '',
        /speckUniforms|deformUniforms|pullFrames|pullSliceFrames/.test(src) ? 'via lib' : '',
      ].filter(Boolean);
      if (!reads.length && !/ctx\.pull|ctx\.time/.test(src)) continue;
      animated++;
      const motion = Object.entries(d.params)
        .filter(([k, p]) => (p as { unit?: string }).unit === 'cycles' || /cycles|evolution|speed|rate|spin|scroll|drift|flicker|hold|boil|hz|travel|orbit|motion|animate|sweep|roll|fall|wobble|period|refresh|every|offset|count|spacing|echoes|memory|radius|range|slices/i.test(k))
        .map(([k]) => k)
        .join(',');
      const live = OUT_OF_SCOPE[d.id] && /live|phone|webcam|stream|MIDI|audio/.test(OUT_OF_SCOPE[d.id]) ? 'live' : '';
      lines.push(
        [
          d.id,
          d.category,
          motion,
          reads.join('+'),
          /wrapSeconds|pullFrames|pullSliceFrames|loop\b.*mod|mod\(/.test(src) ? 'yes' : '',
          /ctx\.pull|pullFrames|pullSliceFrames/.test(src) ? 'yes' : '',
          /loopFrame|hash/.test(src) ? 'yes' : '',
          live,
          tested.has(d.id) ? 'table' : OUT_OF_SCOPE[d.id] ? `out of scope: ${OUT_OF_SCOPE[d.id]}` : 'NOT COVERED',
        ].join('\t'),
      );
    }
    const dir = join(tmpdir(), 'rsmps-audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'loop-audit.tsv'), lines.join('\n') + '\n');
    expect(animated).toBeGreaterThan(40);
    const uncovered = lines.filter((l) => l.endsWith('NOT COVERED')).map((l) => l.split('\t')[0]);
    // Every node that reads the clock is in the table or explicitly out of scope (3D / track family below are covered by the rows above).
    expect(uncovered.filter((id) => !tested.has(id) && !OUT_OF_SCOPE[id]), 'nodes that read the clock but have no audit row').toEqual([]);
  });

  const cases = ROWS.flatMap((row) => (row.lengths ?? LENGTHS).map((n) => ({ row, n })));
  it.each(cases)('$row.id: $row.note, $n frames', async ({ row, n }) => {
    const t = await harness([audioBar], row.text ? textHost : undefined);
    const r = await t.loopCheck(row.id, row.params, inputsFor(t, row), { ...project(n), port: row.port, exact: !!row.exact });
    expect(r.motion, `${r.text}: it must move`).toBeGreaterThan(row.motion ?? 0.05);
    if (row.seam !== 'skip') expect(r.seam, r.text).toBeLessThan(row.tol ?? LOOP_SEAM_OK);
    if (row.exact) expect(r.exactDiff, r.text).toBe(0);
  }, 240_000);
  /** Strips to LOOK at: the last four frames of the loop, then the first four (the wrap is in the middle). */
  it('writes PNG strips of Infinite Zoom across the wrap', async () => {
    const t = await harness([audioBar]);
    const ring = t.fromFn(96, 96, (x, y) => {
      const e = Math.min(x, y, 95 - x, 95 - y);
      return e < 14 ? [235, 235, 235, 255] : e < 17 ? [30, 30, 30, 255] : [0, 0, 0, 0];
    });
    const cases: [string, Record<string, unknown>][] = [
      ['pal5-speed2-drift', { scale: 0.55, levels: 9, speed: 2, recolor: 'multiply', palette: PAL5, colorLoop: 'drift' }],
      ['pal5-speed2-snap', { scale: 0.55, levels: 9, speed: 2, recolor: 'multiply', palette: PAL5, colorLoop: 'snap' }],
      ['pal5-speed2-stretch', { scale: 0.55, levels: 9, speed: 2, recolor: 'multiply', palette: PAL5, colorLoop: 'stretch' }],
      ['pal5-speed5-aligned', { scale: 0.55, levels: 9, speed: 5, recolor: 'multiply', palette: PAL5 }],
      ['hue37-speed2-drift', { scale: 0.55, levels: 9, speed: 2, hueStep: 37 }],
      ['pal4-rising3-drift', { scale: 0.55, levels: 9, speed: -3, recolor: 'multiply', palette: PAL5.slice(0, 4) }],
    ];
    const N = 24;
    for (const [name, params] of cases) {
      const shots = [];
      for (const f of [N - 4, N - 3, N - 2, N - 1, 0, 1, 2, 3]) {
        const out = await t.run('infinite-zoom', params, { image: ring }, { seconds: f / 8, project: { fps: 8, duration: N / 8, loop: true, width: 96, height: 96 } });
        shots.push({ data: await t.gpu.read(out.image as never, true), width: 96, height: 96 });
      }
      console.log('infinite-zoom strip', writePng('loop-zoom-' + name, sheet(shots, 8)));
    }
    expect(PNG_DIR.length).toBeGreaterThan(0);
  }, 240_000);

  /** Snapping is arithmetic on uniforms: no extra pass, no new shader, whatever the numbers or the loop switch. */
  it('snapping adds no pass and compiles nothing when Loop or the numbers change', async () => {
    const t = await harness([audioBar]);
    const ring = t.fromFn(SIZE, SIZE, (x, y) => (Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) < 6 ? [200, 90, 40, 255] : [0, 0, 0, 0]));
    const img = t.fromFn(SIZE, SIZE, (x, y) => [(x * 8) & 255, (y * 8) & 255, 120, 255]);
    const cases: [string, Record<string, unknown>[], Record<string, unknown>][] = [
      ['infinite-zoom', [{ speed: 2, recolor: 'fill', palette: PAL5 }, { speed: 3, recolor: 'multiply', palette: PAL5.slice(0, 2), hueStep: 37, colorLoop: 'stretch' }], { image: ring }],
      ['array', [{ mode: 'infinite', columns: 3, rows: 3, scrollX: 1, hueStep: 30 }, { mode: 'grid', columns: 4, rows: 2, scrollX: 2, scrollY: 1, stagger: 0.5, mirror: 'x', brightnessStep: 0.05 }], { image: img }],
      ['array-3d', [{ layout: 'tunnel', countZ: 7, travel: 1, colourBy: 'card', hueStep: 40 }, { layout: 'tunnel', countZ: 9, travel: 4, colourBy: 'card', hueStep: 10 }], { image: img }],
      ['kaleidoscope', [{ mode: 'logpolar', twist: 0.37, fall: 3 }, { mode: 'mirror', scroll: [0.37, 1.3] }], { image: img }],
      ['retime', [{ speed: 1.3 }, { speed: 2.5, holdFps: 7 }], { image: { node: 'audit-bar' } }],
    ];
    for (const [id, variants, inputs] of cases) {
      await t.run(id, variants[0], inputs as never, { seconds: 0.2, project: { loop: true, fps: 8, duration: 3, width: SIZE, height: SIZE } });
      const before = t.gpu.stats().objects;
      let runs = 0;
      for (const loop of [true, false, true]) {
        for (const v of variants) {
          await t.run(id, v, inputs as never, { seconds: 0.4 + runs * 0.125, project: { loop, fps: 8, duration: 3, width: SIZE, height: SIZE } });
          runs++;
        }
      }
      const after = t.gpu.stats().objects;
      expect(after.pipelinesCreated - before.pipelinesCreated, `${id}: pipelines compiled`).toBe(0);
    }
  }, 240_000);

  it('the pure snapping functions of the nodes', () => {
    const clock = { loop: true, frames: 37, fps: 8 };
    expect(retimeLoop({ speed: 1.3, pingPong: false, repeat: true, holdFps: 0 }, clock)).toMatchObject({ speed: 1, notes: ['speed 1.3 → 1 to loop'] });
    expect(retimeLoop({ speed: 0.37, pingPong: false, repeat: true, holdFps: 0 }, clock).speed).toBe(1);
    expect(retimeLoop({ speed: -0.2, pingPong: false, repeat: true, holdFps: 0 }, clock).speed).toBe(-1);
    expect(retimeLoop({ speed: 1, pingPong: true, repeat: true, holdFps: 0 }, clock).speed).toBe(2);
    expect(retimeLoop({ speed: 0, pingPong: false, repeat: true, holdFps: 0 }, clock).speed).toBe(0);
    expect(retimeLoop({ speed: 1.3, pingPong: false, repeat: false, holdFps: 0 }, clock).speed).toBe(1.3); // holding the last frame is not a loop
    expect(retimeLoop({ speed: 1.3, pingPong: false, repeat: true, holdFps: 0 }, { ...clock, loop: false }).speed).toBe(1.3);
    const hold = retimeLoop({ speed: 1, pingPong: false, repeat: true, holdFps: 7 }, clock).holdFps;
    expect(hold * (37 / 8)).toBeCloseTo(Math.round(hold * (37 / 8)), 9); // a whole number of held frames per loop
    expect(subtitleMotionHz({ motion: 'wave', motionSpeed: 1.3, speed: 1 }, clock) * (37 / 8)).toBeCloseTo(6, 9);
    expect(subtitleMotionHz({ motion: 'wave', motionSpeed: 1.3, speed: 1 }, { ...clock, loop: false })).toBe(1.3);
    expect(subtitleMotionHz({ motion: 'jitter', motionSpeed: 1.3, speed: 1 }, clock)).toBe(1.3);
    expect(array3dLoop({ layout: 'tunnel', travel: 1, countZ: 7, sheetColumns: 2, sheetRows: 1 }, true).travel).toBe(7); // sheet cells cannot blend: whole rings
    expect(array3dLoop({ layout: 'tunnel', travel: 1, countZ: 7, sheetColumns: 1, sheetRows: 1 }, true)).toMatchObject({ travel: 1, blend: true });
    expect(array3dLoop({ layout: 'tunnel', travel: 1, countZ: 7, sheetColumns: 1, sheetRows: 1 }, false)).toMatchObject({ travel: 1, blend: false });
  });
});
