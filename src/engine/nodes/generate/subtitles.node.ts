import { defineNode } from '../../define';
import { upscaleArtGrid } from '../../lib/art-grid';
import { cyclesPerLoop, snapNote } from '../../lib/loop-snap';
import { MAX_INSTANCES, PAGE_CUES, drawSprites, ensurePipe, getAtlas, newSprite, type Atlas, type FrameHeader, type Sprite } from '../../lib/subtitle-gpu';
import {
  animate,
  activeWordAt,
  IDENTITY,
  layoutWords,
  motion,
  placeBlock,
  planUnits,
  safeRect,
  transitionProgress,
  typedFraction,
  unitIndexAt,
  type AnimKind,
  type AnimState,
  type Dir,
  type Ease,
  type Motion,
  type Position,
  type SafeArea,
  type SubMode,
} from '../../lib/subtitle-layout';
import { buildTrack, cueIndexAt, parseCueText, parseSubtitles, splitWords, wordTimings, type Cue, type SubTrack, type SubWord } from '../../lib/subtitles';
import type { ColorValue } from '../../types';

/**
 * Loop snapping: a wave or float motion is in cycles per SECOND of subtitle time, which would leave a jump at the loop seam. With Loop on the
 * rate becomes the nearest whole number of cycles over the loop's subtitle time (project length x Speed), at least one. Pure.
 */
export function subtitleMotionHz(p: { motion: string; motionSpeed: number; speed: number }, clock?: { loop: boolean; frames: number; fps: number }): number {
  if (!clock?.loop || !(p.motionSpeed > 0) || (p.motion !== 'wave' && p.motion !== 'float')) return p.motionSpeed;
  const span = (clock.frames / clock.fps) * Math.max(1e-6, p.speed);
  return cyclesPerLoop(p.motionSpeed, span) / span;
}

const ANIM_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'slide', label: 'Slide' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'blur', label: 'Blur in' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'shake', label: 'Shake' },
  { value: 'wave', label: 'Wave' },
  { value: 'jitter', label: 'Jitter' },
  { value: 'flicker', label: 'Flicker' },
] as const;

const YELLOW: ColorValue = [1, 0.85, 0.1, 1];
const BLACK: ColorValue = [0, 0, 0, 1];
const WHITE: ColorValue = [1, 1, 1, 1];

/** Length params (authored in unit pixels). A preset's value for these is converted like the kernel converts a slider. */
const LENGTHS = ['fontSize', 'stroke', 'shadowBlur', 'shadowX', 'shadowY', 'boxPadding', 'boxRadius', 'wordSpacing', 'pixelSize'];

/**
 * Look presets. A preset overrides the controls it lists; choose Custom to use every control as set. Lengths are in unit pixels
 * (1080 px short side), so the same preset suits any resolution.
 */
const PRESETS: Record<string, Record<string, number | string | boolean | ColorValue>> = {
  classic: { mode: 'lines', maxLines: 2, fontSize: 58, weight: 600, uppercase: false, color: WHITE, stroke: 4, strokeColor: BLACK, shadowColor: [0, 0, 0, 0.55], shadowBlur: 6, shadowX: 0, shadowY: 3, boxMode: 'none', animIn: 'fade', animOut: 'fade', duration: 0.15, stagger: 0, highlightActive: false, motion: 'none', pulse: 0, fillStyle: 'solid', position: 'bottom', pixelSize: 0, oneBit: false, pixelOutline: false },
  bold: { mode: 'chunks', wordsPerChunk: 3, maxLines: 2, fontSize: 96, weight: 900, uppercase: true, color: WHITE, stroke: 12, strokeColor: BLACK, shadowColor: [0, 0, 0, 0.6], shadowBlur: 0, shadowX: 0, shadowY: 8, boxMode: 'none', animIn: 'pop', animOut: 'none', duration: 0.18, stagger: 0, highlightActive: true, highlightColor: YELLOW, motion: 'none', pulse: 0.1, fillStyle: 'solid', position: 'lower', pixelSize: 0, oneBit: false, pixelOutline: false },
  karaoke: { mode: 'karaoke', maxLines: 2, fontSize: 70, weight: 800, uppercase: false, color: WHITE, stroke: 8, strokeColor: BLACK, shadowColor: [0, 0, 0, 0.5], shadowBlur: 8, shadowX: 0, shadowY: 4, boxMode: 'none', animIn: 'fade', animOut: 'fade', duration: 0.2, highlightActive: true, highlightColor: YELLOW, motion: 'none', pulse: 0.08, fillStyle: 'solid', position: 'lower', pixelSize: 0, oneBit: false, pixelOutline: false },
  typewriter: { mode: 'typewriter', maxLines: 3, fontSize: 52, weight: 700, font: 'monospace', uppercase: false, color: [0.85, 1, 0.85, 1], stroke: 0, shadowColor: [0, 0, 0, 0], boxMode: 'block', boxColor: [0, 0, 0, 0.72], boxPadding: 22, boxRadius: 8, animIn: 'none', animOut: 'fade', duration: 0.2, highlightActive: false, motion: 'none', pulse: 0, fillStyle: 'solid', position: 'bottom', pixelSize: 0, oneBit: false, pixelOutline: false },
  pixel8: { mode: 'chunks', wordsPerChunk: 3, maxLines: 2, fontSize: 112, weight: 700, font: 'monospace', uppercase: true, color: WHITE, stroke: 0, strokeColor: BLACK, shadowColor: [0, 0, 0, 0], boxMode: 'none', animIn: 'slide', slideDir: 'up', animOut: 'none', duration: 0.15, highlightActive: true, highlightColor: [1, 0.9, 0.2, 1], motion: 'none', pulse: 0, fillStyle: 'solid', position: 'lower', pixelSize: 4, pixelSnap: true, oneBit: true, pixelOutline: true },
  pixelDither: { mode: 'chunks', wordsPerChunk: 2, maxLines: 2, fontSize: 128, weight: 800, font: 'monospace', uppercase: true, color: [1, 0.95, 0.5, 1], gradientColor: [0.9, 0.2, 0.35, 1], gradientAngle: 90, stroke: 0, strokeColor: [0.1, 0.02, 0.15, 1], shadowColor: [0, 0, 0, 0], boxMode: 'none', animIn: 'slide', slideDir: 'up', animOut: 'none', duration: 0.15, highlightActive: false, motion: 'none', pulse: 0, fillStyle: 'dither', position: 'lower', pixelSize: 4, pixelSnap: true, oneBit: true, pixelOutline: true },
  boxed: { mode: 'karaoke', maxLines: 2, fontSize: 72, weight: 800, uppercase: false, color: WHITE, stroke: 0, shadowColor: [0, 0, 0, 0.45], shadowBlur: 10, shadowX: 0, shadowY: 4, boxMode: 'word', boxColor: YELLOW, boxPadding: 14, boxRadius: 16, animIn: 'fade', animOut: 'fade', duration: 0.15, highlightActive: true, highlightColor: [0.05, 0.05, 0.05, 1], motion: 'none', pulse: 0.05, fillStyle: 'solid', position: 'lower', pixelSize: 0, oneBit: false, pixelOutline: false },
  bigword: { mode: 'word', maxLines: 1, fontSize: 190, weight: 900, uppercase: true, color: WHITE, stroke: 16, strokeColor: BLACK, shadowColor: [0, 0, 0, 0.5], shadowBlur: 0, shadowX: 0, shadowY: 10, boxMode: 'none', animIn: 'pop', animOut: 'none', duration: 0.16, stagger: 0, highlightActive: false, motion: 'none', pulse: 0, fillStyle: 'solid', position: 'center', pixelSize: 0, oneBit: false, pixelOutline: false },
  wave: { mode: 'karaoke', maxLines: 2, fontSize: 78, weight: 800, uppercase: false, color: WHITE, stroke: 6, strokeColor: [0.15, 0.05, 0.3, 1], shadowColor: [0.2, 0, 0.4, 0.5], shadowBlur: 14, shadowX: 0, shadowY: 0, boxMode: 'none', animIn: 'blur', animOut: 'fade', duration: 0.3, highlightActive: true, highlightColor: [1, 0.45, 0.8, 1], motion: 'wave', motionAmount: 0.1, motionSpeed: 0.7, pulse: 0, fillStyle: 'solid', position: 'center', pixelSize: 0, oneBit: false, pixelOutline: false },
};

/* ------------------------------------------------------------------------ */
/* Parsing, memoised by content                                              */
/* ------------------------------------------------------------------------ */

const parsedFiles = new WeakMap<ArrayBuffer, SubTrack>();
const parsedText = new Map<string, SubTrack>();

function decodeBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const smooth01 = (x: number) => Math.min(1, Math.max(0, x));

export default defineNode({
  id: 'subtitles',
  title: 'Subtitles',
  category: 'generate',
  description:
    'Turns an .srt / .vtt file (or lines you type) into a styled caption overlay on a transparent image: TikTok-style word pops, karaoke, typewriter, pixel-art and dithered lettering. Put it over the video with Merge, or run it through Pixelate, Dither, CRT, Recolor or a Custom Shader first. Needs the app to rasterize fonts (empty in headless runs).',
  keywords: ['srt', 'vtt', 'captions', 'subtitle', 'subtitles', 'lyrics', 'karaoke', 'tiktok', 'reels', 'shorts', 'text', 'caption', 'closed captions', 'words'],
  inputs: {
    image: { type: 'image', label: 'Fill (picture in the letters)' },
    palette: { type: 'palette', label: 'Word colors' },
  },
  outputs: {
    image: { type: 'image', label: 'Image' },
    mask: { type: 'mask', label: 'Text mask' },
    active: { type: 'number', label: 'Cue showing (0/1)' },
    cueProgress: { type: 'number', label: 'Cue progress' },
    wordIndex: { type: 'number', label: 'Word index' },
  },
  optionalOutputs: ['mask'],
  params: {
    file: { type: 'assets', default: [], accept: 'subtitles', group: 'Source', label: 'File', hint: 'A SubRip or WebVTT file. With several files, each batch item uses its own. With none, the lines below are used.' },
    text: {
      type: 'string',
      multiline: true,
      default: 'Captions that keep people watching\nWords pop in time with the voice\nStyle them any way you like',
      group: 'Source',
      label: 'Text',
      hint: 'One caption per line. Prefix a line with [1.5-3.0] (seconds, or m:ss.s) to time it. With no times at all the lines share the project length equally. Write \\n for a line break inside a caption.',
    },
    offset: { type: 'number', default: 0, min: -3600, max: 3600, softMax: 120, step: 0.05, unit: 's', group: 'Source', label: 'Offset', hint: 'Delay the subtitles by this many seconds (negative = earlier).' },
    speed: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.001, group: 'Source', label: 'Speed', hint: 'Subtitle time runs this many times faster than the project (use it when the clip was retimed).' },
    loopWithProject: { type: 'bool', default: false, group: 'Source', label: 'Loop', hint: 'The (offset) timeline wraps at the project length, so captions pushed past the end come back at the start: a seamless loop.' },
    preset: {
      type: 'enum',
      default: 'bold',
      group: 'Look',
      label: 'Look',
      hint: 'A preset overrides the controls it lists (layout, style, animation, pixel look). Choose Custom to use every control as set.',
      options: [
        { value: 'custom', label: 'Custom' },
        { value: 'classic', label: 'Classic' },
        { value: 'bold', label: 'Bold caption' },
        { value: 'karaoke', label: 'Karaoke highlight' },
        { value: 'typewriter', label: 'Typewriter' },
        { value: 'pixel8', label: 'Pixel 8-bit' },
        { value: 'pixelDither', label: 'Pixel dithered' },
        { value: 'boxed', label: 'Boxed word' },
        { value: 'bigword', label: 'Big single word' },
        { value: 'wave', label: 'Lyric wave' },
      ],
    },
    mode: {
      type: 'enum',
      default: 'lines',
      group: 'Layout',
      label: 'Show as',
      options: [
        { value: 'lines', label: 'Lines' },
        { value: 'chunks', label: 'Chunks' },
        { value: 'word', label: 'One word at a time' },
        { value: 'karaoke', label: 'Karaoke' },
        { value: 'typewriter', label: 'Typewriter' },
        { value: 'build', label: 'Build up' },
      ],
    },
    wordsPerChunk: { type: 'number', default: 3, min: 1, max: 12, step: 1, integer: true, group: 'Layout', label: 'Words per chunk', visibleIf: (p) => p.mode === 'chunks' },
    position: {
      type: 'enum',
      default: 'bottom',
      group: 'Layout',
      label: 'Position',
      options: [
        { value: 'bottom', label: 'Bottom' },
        { value: 'lower', label: 'Lower third' },
        { value: 'center', label: 'Center' },
        { value: 'top', label: 'Top' },
        { value: 'free', label: 'Free' },
      ],
    },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', group: 'Layout', label: 'Free X', hint: 'Center of the caption block.', visibleIf: (p) => p.position === 'free' },
    y: { type: 'number', default: 0.8, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', group: 'Layout', label: 'Free Y', visibleIf: (p) => p.position === 'free' },
    safeArea: {
      type: 'enum',
      default: 'none',
      group: 'Layout',
      label: 'Safe area',
      hint: 'Keeps captions clear of the app interface. APPROXIMATE guides from the platforms\' published templates (they change the layout now and then): a starting point, not a promise. Only applies to portrait frames.',
      options: [
        { value: 'none', label: 'None' },
        { value: 'tiktok', label: 'TikTok' },
        { value: 'reels', label: 'Reels' },
        { value: 'shorts', label: 'Shorts' },
      ],
    },
    margin: { type: 'number', default: 0.04, min: 0, max: 0.4, step: 0.005, unit: 'norm', group: 'Layout', label: 'Margin', hint: 'Extra space from the edges (and the safe area), as a fraction of the frame\'s short side.' },
    maxWidth: { type: 'number', default: 0.9, min: 0.1, max: 1, step: 0.01, unit: 'norm', group: 'Layout', label: 'Max width', hint: 'Widest a line may be, as a fraction of the space inside the margins.' },
    maxLines: { type: 'number', default: 2, min: 1, max: 8, step: 1, integer: true, group: 'Layout', label: 'Max lines', hint: 'More lines than this shrinks the text to fit (never below 40%).' },
    balance: { type: 'bool', default: true, group: 'Layout', label: 'Balance lines', hint: 'Break long captions into lines of similar length.' },
    align: {
      type: 'enum',
      default: 'center',
      group: 'Layout',
      label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    uppercase: { type: 'bool', default: false, group: 'Layout', label: 'UPPERCASE' },
    followCuePosition: { type: 'bool', default: true, group: 'Layout', label: 'File positions', hint: '{\\an8} (top) and similar tags, or a VTT "line:" setting, move that caption to the top / center.' },
    lineHeight: { type: 'number', default: 1.15, min: 0.6, max: 2.5, step: 0.05, group: 'Layout', label: 'Line height' },
    wordSpacing: { type: 'number', default: 0, min: -50, max: 200, softMax: 60, step: 0.5, unit: 'px', group: 'Layout', label: 'Extra word spacing' },

    font: { type: 'string', kind: 'font', default: 'sans-serif', group: 'Style', label: 'Font', hint: 'Pick a font, or type the name of any font installed on this computer. A pixel font stays crisp with Pixel size above 0.' },
    fontSize: { type: 'number', default: 64, min: 4, max: 800, softMax: 400, step: 1, unit: 'px', group: 'Style', label: 'Size' },
    weight: { type: 'number', default: 800, min: 100, max: 900, step: 100, integer: true, group: 'Style', label: 'Weight', hint: '400 = regular, 700 = bold, 900 = black.' },
    italic: { type: 'bool', default: false, group: 'Style', label: 'Italic' },
    color: { type: 'color', default: WHITE, group: 'Style', label: 'Color' },
    fillStyle: {
      type: 'enum',
      default: 'solid',
      group: 'Style',
      label: 'Fill',
      hint: 'A picture wired to Fill always wins. Dither = an ordered dither between the two colors, on the pixel grid.',
      options: [
        { value: 'solid', label: 'Solid' },
        { value: 'gradient', label: 'Gradient' },
        { value: 'dither', label: 'Dithered gradient' },
      ],
    },
    gradientColor: { type: 'color', default: [1, 0.45, 0.2, 1], group: 'Style', label: 'Second color', visibleIf: (p) => p.fillStyle !== 'solid' },
    gradientAngle: { type: 'number', default: 90, min: -180, max: 180, step: 1, unit: 'deg', group: 'Style', label: 'Gradient angle', hint: '0 = left to right, 90 = top to bottom.', visibleIf: (p) => p.fillStyle !== 'solid' },
    highlightActive: { type: 'bool', default: false, group: 'Style', label: 'Highlight word', hint: 'Karaoke always does.' },
    highlightColor: { type: 'color', default: YELLOW, group: 'Style', label: 'Highlight color' },
    stroke: { type: 'number', default: 6, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', group: 'Outline & shadow', label: 'Stroke width', hint: 'Drawn outside the letters. At most about a quarter of the text size.' },
    strokeColor: { type: 'color', default: BLACK, group: 'Outline & shadow', label: 'Stroke color' },
    shadowColor: { type: 'color', default: [0, 0, 0, 0], group: 'Outline & shadow', label: 'Shadow color', hint: 'The alpha is the strength: 0 = no shadow.' },
    shadowX: { type: 'number', default: 0, min: -100, max: 100, softMax: 40, step: 0.5, unit: 'px', group: 'Outline & shadow', label: 'Shadow X' },
    shadowY: { type: 'number', default: 4, min: -100, max: 100, softMax: 40, step: 0.5, unit: 'px', group: 'Outline & shadow', label: 'Shadow Y' },
    shadowBlur: { type: 'number', default: 6, min: 0, max: 60, softMax: 30, step: 0.5, unit: 'px', group: 'Outline & shadow', label: 'Shadow blur' },
    boxMode: {
      type: 'enum',
      default: 'none',
      group: 'Background box',
      label: 'Box behind',
      options: [
        { value: 'none', label: 'None' },
        { value: 'block', label: 'The whole caption' },
        { value: 'line', label: 'Line pill' },
        { value: 'word', label: 'The spoken word' },
      ],
    },
    boxColor: { type: 'color', default: [0, 0, 0, 0.65], group: 'Background box', label: 'Box color', visibleIf: (p) => p.boxMode !== 'none' },
    boxPadding: { type: 'number', default: 18, min: 0, max: 200, softMax: 80, step: 0.5, unit: 'px', group: 'Background box', label: 'Padding', visibleIf: (p) => p.boxMode !== 'none' },
    boxRadius: { type: 'number', default: 14, min: 0, max: 200, softMax: 80, step: 0.5, unit: 'px', group: 'Background box', label: 'Corner radius', visibleIf: (p) => p.boxMode !== 'none' },

    animIn: { type: 'enum', default: 'fade', group: 'Animation', label: 'In', options: ANIM_OPTIONS },
    animOut: { type: 'enum', default: 'fade', group: 'Animation', label: 'Out', options: ANIM_OPTIONS },
    duration: { type: 'number', default: 0.15, min: 0, max: 2, step: 0.01, unit: 's', group: 'Animation', label: 'Duration', hint: 'Length of the in and out transitions (squeezed when a caption is shorter).' },
    stagger: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, unit: 's', group: 'Animation', label: 'Stagger per word', hint: 'Each word starts this much later than the one before.' },
    letterStagger: { type: 'number', default: 0, min: 0, max: 3, step: 0.05, group: 'Animation', label: 'Stagger per letter', hint: 'Fade / wipe ripple across the letters of each word (0 = the word moves as one).' },
    easing: {
      type: 'enum',
      default: 'out',
      group: 'Animation',
      label: 'Easing',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'smooth', label: 'Smooth' },
        { value: 'out', label: 'Ease out' },
        { value: 'back', label: 'Overshoot' },
        { value: 'bounce', label: 'Bounce' },
        { value: 'elastic', label: 'Elastic' },
      ],
    },
    slideDir: {
      type: 'enum',
      default: 'up',
      group: 'Animation',
      label: 'Slide direction',
      options: [
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
    },
    motion: {
      type: 'enum',
      default: 'none',
      group: 'Animation',
      label: 'While shown',
      options: [
        { value: 'none', label: 'Still' },
        { value: 'wave', label: 'Wave' },
        { value: 'float', label: 'Float' },
        { value: 'jitter', label: 'Jitter' },
        { value: 'shake', label: 'Shake' },
        { value: 'flicker', label: 'Flicker' },
      ],
    },
    motionAmount: { type: 'number', default: 0.1, min: 0, max: 0.6, step: 0.005, group: 'Animation', label: 'Motion amount', hint: 'Fraction of the text size.', visibleIf: (p) => p.motion !== 'none' },
    motionSpeed: { type: 'number', default: 1, min: 0, max: 8, step: 0.05, unit: 'hz', group: 'Animation', label: 'Motion speed', hint: 'Cycles per second of subtitle time (not whole loop cycles).', visibleIf: (p) => p.motion === 'wave' || p.motion === 'float' },
    pulse: { type: 'number', default: 0, min: 0, max: 0.6, step: 0.01, group: 'Animation', label: 'Spoken-word pulse', hint: 'The spoken word swells by this much while it is said.' },

    pixelSize: { type: 'number', default: 0, min: 0, max: 64, softMax: 16, step: 1, integer: true, unit: 'px', group: 'Pixel look', label: 'Pixel size', hint: '0 = off. Above 0 the lettering is drawn on a grid of this many unit pixels per art pixel and enlarged crisply; the output carries the pixel grid, so a Dither or Quantize after it works on the same grid.' },
    pixelSnap: { type: 'bool', default: true, group: 'Pixel look', label: 'Snap to the grid', hint: 'Whole-pixel positions, so pixel fonts stay crisp.', visibleIf: (p) => (p.pixelSize as number) > 0 },
    oneBit: { type: 'bool', default: false, group: 'Pixel look', label: '1-bit edges', hint: 'No anti-aliasing: every pixel is on or off.' },
    threshold: { type: 'number', default: 0.5, min: 0.05, max: 0.95, step: 0.01, group: 'Pixel look', label: 'Threshold', visibleIf: (p) => p.oneBit === true },
    pixelOutline: { type: 'bool', default: false, group: 'Pixel look', label: '1 px outline', hint: 'Uses a one art-pixel outline (the stroke color) instead of the stroke width.', visibleIf: (p) => (p.pixelSize as number) > 0 },
  },
  summary: (p, _wired, clock) => {
    const base = p.preset !== 'custom' ? String(p.preset) : `${p.mode}${p.pixelSize > 0 ? ' · pixel' : ''}`;
    const note = snapNote('motion Hz', p.motionSpeed, Math.round(subtitleMotionHz(p, clock) * 100) / 100);
    return note && p.motion !== 'none' ? `${base} · ${note}` : base;
  },
  async render(ctx) {
    const p = { ...ctx.params } as Record<string, unknown> & typeof ctx.params;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const unit = ctx.canvas.unit;
    // 'px' params arrive in texels of the first image input (the optional Fill) or the canvas; the output is canvas sized.
    const refUnit = ctx.in.image?.unit ?? unit;
    const lenScale = unit / refUnit;
    if (p.preset !== 'custom') {
      for (const [k, v] of Object.entries(PRESETS[p.preset] ?? {})) p[k] = typeof v === 'number' && LENGTHS.includes(k) ? v * refUnit : v;
    }
    const cellRaw = p.pixelSize * lenScale;
    const cell = cellRaw >= 1.01 ? cellRaw : 1;
    const rw = cell > 1 ? Math.max(1, Math.round(W / cell)) : W;
    const rh = cell > 1 ? Math.max(1, Math.round(H / cell)) : H;
    const rUnit = unit / cell;
    const len = (v: number) => (v * lenScale) / cell;
    const finish = (art: ReturnType<typeof ctx.gpu.alloc>) => {
      const image = cell > 1 ? upscaleArtGrid(ctx.gpu, art, { width: W, height: H, unit }, cell) : art;
      if (image !== art) ctx.gpu.recycle(art);
      const out: Record<string, unknown> = { image };
      if (ctx.wants('mask')) {
        out.mask = ctx.gpu.passMask({
          label: 'subtitles-mask',
          size: image,
          textures: { src: image },
          wgsl: /* wgsl */ `fn fx(uv: vec2f, px: vec2f) -> vec4f { let a = textureSampleLevel(src, smpNearest, uv, 0.0).a; return vec4f(a, a, a, 1.0); }`,
        });
      }
      return out;
    };

    // ---- the track (memoised by content) ----
    let track: SubTrack | null = null;
    const files = p.file as string[];
    if (files.length) {
      const id = files[files.length > 1 ? ctx.item.index % files.length : 0];
      if (!ctx.host.assetBytes) throw new Error('This app build cannot read subtitle files (the host has no assetBytes).');
      const bytes = await ctx.host.assetBytes(id);
      if (!bytes) throw new Error('The subtitle file is missing. Choose it again in the node.');
      track = parsedFiles.get(bytes) ?? null;
      if (!track) {
        track = buildTrack(parseSubtitles(decodeBytes(bytes)).cues);
        parsedFiles.set(bytes, track);
      }
    }
    const noCues = (): Record<string, unknown> => {
      const art = ctx.gpu.alloc(rw, rh, rUnit);
      drawEmpty(ctx.gpu, art);
      return { ...finish(art), active: 0, cueProgress: 0, wordIndex: -1 };
    };
    if (!ctx.host.rasterizeText) return noCues(); // headless: nothing to rasterise with
    if (!track && !String(p.text).trim()) return noCues();

    const seconds = ctx.time.seconds; // from here the node is per-frame
    const duration = Math.max(1e-3, ctx.time.duration);
    const motionHz = subtitleMotionHz(p, { loop: ctx.time.loop, frames: Math.max(1, Math.round(duration * ctx.time.fps)), fps: ctx.time.fps });
    if (!track) {
      const key = `${duration}|${p.text}`;
      track = parsedText.get(key) ?? null;
      if (!track) {
        track = buildTrack(parseCueText(String(p.text), duration));
        if (parsedText.size >= 8) parsedText.delete(parsedText.keys().next().value as string);
        parsedText.set(key, track);
      }
    }
    if (!track.cues.length) return noCues();

    const local = seconds - p.offset;
    const st = (p.loopWithProject ? ((local % duration) + duration) % duration : local) * p.speed;
    const ci = cueIndexAt(track, st);
    if (ci < 0) return noCues();
    const cue = track.cues[ci];

    // ---- atlas for this page of the file ----
    const sizePx = Math.max(1, len(p.fontSize));
    const upper = p.uppercase as boolean;
    const tf = (w: string) => (upper ? w.toUpperCase() : w);
    const page = Math.floor(ci / PAGE_CUES);
    const style = { font: p.font || 'sans-serif', sizePx, weight: p.weight, italic: p.italic };
    const atlasKey = `${track.key}|${style.font}|${Math.round(sizePx * 64)}|${style.weight}|${style.italic ? 'i' : 'r'}|${upper ? 'U' : 'n'}|${page}`;
    const atlas = getAtlas(
      ctx.gpu,
      ctx.host,
      atlasKey,
      () => {
        const set = new Set<string>();
        const last = Math.min(track!.cues.length, (page + 1) * PAGE_CUES);
        for (let i = page * PAGE_CUES; i < last; i++) for (const w of wordTimings(track!.cues[i])) set.add(tf(w.text));
        return [...set];
      },
      style,
    );
    const words = wordTimings(cue);
    const activeIdx = activeWordAt(words, 0, st);
    const numbers = { active: 1, cueProgress: Math.min(1, Math.max(0, (st - cue.start) / Math.max(1e-6, cue.end - cue.start))), wordIndex: activeIdx };
    if (!atlas) return { ...noCues(), ...numbers };

    await ensurePipe(ctx.gpu);

    // ---- which unit, laid out ----
    const mode = p.mode as SubMode;
    const units = planUnits(words, cue.start, cue.end, mode, p.wordsPerChunk);
    const ui = Math.max(0, unitIndexAt(units, st));
    const unit0 = units[ui];
    const widths = unit0.words.map((w) => atlas.cells.get(tf(w.text))?.adv ?? sizePx * 0.5 * w.text.length);
    const wordSpacing = len(p.wordSpacing);
    const area = safeRect(rw, rh, p.safeArea as SafeArea, p.margin * Math.min(rw, rh));
    let keep: number[] | null = null;
    if (mode === 'lines' || mode === 'karaoke' || mode === 'typewriter' || mode === 'build') {
      keep = [];
      let n = 0;
      for (const l of cue.lines) {
        keep.push(n);
        n += splitWords(l).length;
      }
      if (n !== words.length) keep = null;
    }
    const lay = layoutWords(widths, {
      space: atlas.space + wordSpacing,
      maxW: Math.max(1, (area.r - area.l) * p.maxWidth),
      maxLines: p.maxLines,
      lineH: sizePx * p.lineHeight,
      align: p.align as 'left' | 'center' | 'right',
      balanced: p.balance,
      keepBreaks: keep,
    });
    let position = p.position as Position;
    if (p.followCuePosition && cue.valign) position = cue.valign === 'top' ? 'top' : cue.valign === 'middle' ? 'center' : position;
    const snap = cell > 1 && p.pixelSnap;
    const org = placeBlock(lay.w, lay.h, area, position, { x: p.x, y: p.y, width: rw, height: rh });
    if (snap) {
      org.x = Math.round(org.x);
      org.y = Math.round(org.y);
    }

    // ---- per-word look ----
    const sprites = SPRITES;
    let n = 0;
    const dIn = p.duration;
    const inKind = p.animIn as AnimKind;
    const outKind = p.animOut as AnimKind;
    const ease = p.easing as Ease;
    const dir = p.slideDir as Dir;
    const stagger = p.stagger;
    const pulse = p.pulse;
    const highlight = mode === 'karaoke' || p.highlightActive;
    const palette = ctx.in.palette?.colors ?? null;
    const colors: ColorValue = p.color;
    const hl: ColorValue = p.highlightColor;
    const strokeColor: ColorValue = p.strokeColor;
    const shadowColor: ColorValue = p.shadowColor;
    const hasFillPic = !!ctx.in.image;
    const strokeBase = p.pixelOutline && cell > 1 ? 1 : len(p.stroke);
    const shBlur = len(p.shadowBlur);
    const shX = len(p.shadowX);
    const shY = len(p.shadowY);
    const margin = atlas.margin;
    const waveK = (2 * Math.PI) / Math.max(1, sizePx * 2.2);
    const blockCx = org.x + lay.w / 2;
    const blockCy = org.y + lay.h / 2;

    interface W {
      i: number;
      text: string;
      cx: number;
      cy: number;
      k: number;
      alpha: number;
      wipe: number;
      blur: number;
      wave: number;
      letter: number;
      color: ColorValue;
      override: boolean;
      left: number;
      width: number;
    }
    const drawn: W[] = [];
    const nW = unit0.words.length;
    let unitAlpha = 1;
    for (let i = 0; i < nW; i++) {
      const w = unit0.words[i] as SubWord;
      const gi = unit0.first + i;
      const placed = lay.words[i];
      const cellInfo = atlas.cells.get(tf(w.text));
      if (!cellInfo || !placed) continue;
      let pIn: number;
      let pOut: number;
      if (mode === 'build') {
        if (st < w.start) continue;
        const dd = Math.max(1e-6, Math.min(dIn, Math.max(1e-6, unit0.end - w.start) * 0.5));
        pIn = inKind === 'none' ? 1 : smooth01((st - w.start) / dd);
        pOut = outKind === 'none' || dIn <= 0 ? (st < unit0.end ? 1 : 0) : smooth01((unit0.end - st) / Math.min(dIn, (unit0.end - unit0.start) * 0.5));
      } else {
        ({ pIn, pOut } = transitionProgress(st, unit0.start, unit0.end, inKind === 'none' ? 0 : dIn, outKind === 'none' ? 0 : dIn, i, nW, stagger));
        if (inKind === 'none') pIn = 1;
        if (outKind === 'none') pOut = 1;
      }
      const seed = gi * 7 + 1;
      let s: AnimState = { ...IDENTITY };
      if (pIn < 1) s = animate(inKind, pIn, { ease, dir, t: st, seed, out: false });
      if (pOut < 1) {
        const o = animate(outKind, pOut, { ease, dir, t: st, seed, out: true });
        s = { alpha: s.alpha * o.alpha, dx: s.dx + o.dx, dy: s.dy + o.dy, scale: s.scale * o.scale, blur: Math.max(s.blur, o.blur), wipe: Math.min(s.wipe, o.wipe), wave: s.wave + o.wave };
      }
      const mo = motion(p.motion as Motion, st, seed, p.motionAmount, motionHz);
      let wipe = s.wipe;
      if (mode === 'typewriter') wipe = Math.min(wipe, typedFraction(w, st));
      if (wipe <= 0 || s.alpha <= 0) continue;
      let scale = s.scale; // animation scale only: the layout's own shrink is `lay.scale`
      let emphasis = 1;
      if (pulse > 0 && gi === activeIdx) emphasis = 1 + pulse * Math.sin(Math.PI * smooth01((st - w.start) / Math.max(1e-6, w.end - w.start)));
      scale *= emphasis;
      let cx = org.x + placed.x + placed.w / 2;
      let cy = org.y + placed.y;
      const pivotWord = stagger > 0 || mode === 'word' || mode === 'build' || mode === 'typewriter';
      if (!pivotWord && s.scale !== 1) {
        cx = blockCx + (cx - blockCx) * s.scale;
        cy = blockCy + (cy - blockCy) * s.scale;
      }
      cx += (s.dx + mo.dx) * sizePx;
      cy += (s.dy + mo.dy) * sizePx;
      const k = lay.scale * scale;
      if (i === 0) unitAlpha = s.alpha * mo.alpha;
      const isActive = highlight && gi === activeIdx;
      let color: ColorValue = colors;
      let override = false;
      if (palette && palette.length && !isActive) {
        const c = palette[gi % palette.length];
        color = [c[0], c[1], c[2], colors[3]];
        override = true;
      }
      if (isActive) {
        color = hl;
        override = true;
      }
      const wpx = placed.w * scale;
      drawn.push({ i: gi, text: tf(w.text), cx, cy, k, alpha: s.alpha * mo.alpha, wipe, blur: s.blur * sizePx * k, wave: (s.wave + (p.motion === 'wave' ? mo.wave : 0)) * sizePx * k, letter: pIn, color, override, left: cx - wpx / 2, width: wpx });
    }

    // layer 0: boxes
    const boxColor: ColorValue = p.boxColor;
    const boxPad = len(p.boxPadding);
    const boxRad = len(p.boxRadius);
    const box = (cx: number, cy: number, hw: number, hh: number, alpha: number, kScale = 1) => {
      if (n >= MAX_INSTANCES) return;
      const q = sprites[n++];
      Object.assign(q, SPRITE_ZERO);
      q.kind = 0;
      q.cx = cx;
      q.cy = cy;
      q.hw = hw * kScale + 2;
      q.hh = hh * kScale + 2;
      q.bw = hw * kScale;
      q.bh = hh * kScale;
      q.p1 = Math.min(boxRad * kScale, hw * kScale, hh * kScale);
      q.r = boxColor[0];
      q.g = boxColor[1];
      q.b = boxColor[2];
      q.a = boxColor[3];
      q.alpha = alpha;
    };
    if (p.boxMode === 'block' && drawn.length) box(blockCx, blockCy, lay.w / 2 + boxPad, lay.h / 2 + boxPad, unitAlpha);
    else if (p.boxMode === 'line' && drawn.length) {
      const lh = sizePx * p.lineHeight * lay.scale;
      for (const l of lay.lines) box(org.x + l.x + l.w / 2, org.y + l.y, l.w / 2 + boxPad, lh * 0.5 * 0.94 + boxPad * 0.3, unitAlpha);
    } else if (p.boxMode === 'word') {
      for (const d of drawn) if (d.i === activeIdx) box(d.cx, d.cy, d.width / 2 + boxPad, sizePx * lay.scale * 0.62 + boxPad * 0.5, d.alpha, 1);
    }

    const place = (q: Sprite, d: W, c: { x: number; y: number; w: number; h: number }) => {
      let left = d.cx - (c.w * d.k) / 2;
      let top = d.cy - (c.h * d.k) / 2;
      if (snap) {
        left = Math.round(left);
        top = Math.round(top);
      }
      q.cx = left + (c.w * d.k) / 2;
      q.cy = top + (c.h * d.k) / 2;
      q.hw = (c.w * d.k) / 2 + d.wave + 2;
      q.hh = (c.h * d.k) / 2 + d.wave + 2;
      q.bx = c.x;
      q.by = c.y;
      q.bw = c.w;
      q.bh = c.h;
      q.k = d.k;
      q.wipe = d.wipe;
      q.blur = d.blur;
      q.alpha = d.alpha;
      q.waveAmp = d.wave;
      q.waveK = waveK / Math.max(1e-6, d.k);
      q.wavePhase = 2 * Math.PI * motionHz * st;
      q.letter = d.letter;
      q.left = left + margin * d.k;
      q.width = Math.max(1, (c.w - 2 * margin) * d.k);
      q.spread = p.letterStagger;
    };
    const layer = (kind: number) => {
      for (const d of drawn) {
        if (n >= MAX_INSTANCES) return;
        const c = atlas.cells.get(d.text)!;
        const strokeW = Math.min(strokeBase * d.k, margin * d.k - 1.5);
        let col: ColorValue;
        if (kind === 1) {
          if (shadowColor[3] <= 0 || (shBlur <= 0 && shX === 0 && shY === 0)) return;
          col = shadowColor;
        } else if (kind === 2) {
          if (strokeW <= 0 || strokeColor[3] <= 0) return;
          col = strokeColor;
        } else col = d.color;
        const q = sprites[n++];
        Object.assign(q, SPRITE_ZERO);
        q.kind = kind;
        place(q, d, c);
        q.r = col[0];
        q.g = col[1];
        q.b = col[2];
        q.a = kind === 3 && d.override ? -col[3] : col[3];
        if (kind === 2) q.p1 = strokeW;
        if (kind === 1) {
          const lim = margin * d.k * 0.8;
          q.p1 = Math.min(shBlur * d.k, lim);
          q.sx = Math.max(-lim, Math.min(lim, shX * d.k));
          q.sy = Math.max(-lim, Math.min(lim, shY * d.k));
          q.shadowGrow = Math.max(0, strokeW);
          q.hw += Math.abs(q.sx) + q.p1;
          q.hh += Math.abs(q.sy) + q.p1;
        }
      }
    };
    layer(1);
    layer(2);
    layer(3);

    const fillMode = hasFillPic ? 2 : p.fillStyle === 'gradient' ? 1 : p.fillStyle === 'dither' ? 3 : 0;
    const ang = (p.gradientAngle * Math.PI) / 180;
    const header: FrameHeader = {
      canvasW: rw,
      canvasH: rh,
      fillMode,
      ditherCell: cell > 1 ? 1 : Math.max(1, Math.round(sizePx / 40)),
      hard: p.oneBit,
      threshold: p.threshold,
      nearest: p.oneBit && cell > 1,
      gradA: colors,
      gradB: p.gradientColor,
      block: [org.x, org.y, org.x + lay.w, org.y + lay.h],
      gradDir: [Math.cos(ang), Math.sin(ang)],
    };
    const art = ctx.gpu.alloc(rw, rh, rUnit);
    drawSprites({ gpu: ctx.gpu, out: art, atlas: atlas as Atlas, fill: ctx.in.image, header, sprites, count: n });
    return { ...finish(art), ...numbers };
  },
});

/** Sprite storage reused by every render (rewritten from scratch each time; `drawSprites` is synchronous). */
const SPRITES: Sprite[] = Array.from({ length: MAX_INSTANCES }, newSprite);
const SPRITE_ZERO: Sprite = newSprite();

function drawEmpty(gpu: import('../../types').NodeGpu, art: { texture: GPUTexture }): void {
  const enc = gpu.device.createCommandEncoder({ label: 'subtitles-empty' });
  enc.beginRenderPass({ colorAttachments: [{ view: gpu.view(art.texture), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
  gpu.device.queue.submit([enc.finish()]);
}

export type { Cue };
