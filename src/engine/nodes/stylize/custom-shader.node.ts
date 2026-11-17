import { defineNode } from '../../define';
import { PASS_PRELUDE, PRELUDE } from '../../gpu/prelude';
import { DEFAULT_SHADER, SHADER_EXAMPLES, SHADER_HELP } from '../../lib/shader-examples';

/**
 * Custom Shader: the user's WGSL runs as a full-screen `gpu.pass`. The code is either the BODY of
 * `fn fx(uv: vec2f, px: vec2f) -> vec4f` (no `fn fx` in the text) or a complete WGSL snippet that defines `fn fx` itself
 * (and any helper functions). Built-ins are documented in SHADER_HELP (shown in the inspector).
 *
 * Compile errors: the kernel's own shader report is not reachable from a node and names lines of the whole assembled shader
 * (uniform struct, prelude, ...). So the code is first compiled once on its own (`validate`) inside a copy we assemble ourselves,
 * where we know exactly how many lines precede the user's text, and the error is reported against the USER's line numbers.
 * The outcome per code text is remembered (a pure function of the text, so it cannot change what a render produces); that also
 * keeps a broken shader reporting its error when a slider moves, instead of silently drawing nothing.
 */

const MAX_CODE = 20000;

const HELPERS = (hasSrc: boolean, hasSrc2: boolean) =>
  [
    `const HAS_SRC: bool = ${hasSrc};`,
    `const HAS_SRC2: bool = ${hasSrc2};`,
    hasSrc ? 'fn src(uv: vec2f) -> vec4f { return textureSampleLevel(img, smp, uv, 0.0); }' : 'fn src(uv: vec2f) -> vec4f { return vec4f(0.0); }',
    hasSrc2 ? 'fn src2(uv: vec2f) -> vec4f { return textureSampleLevel(img2, smp, uv, 0.0); }' : 'fn src2(uv: vec2f) -> vec4f { return vec4f(0.0); }',
  ].join('\n');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const countLines = (s: string) => s.split('\n').length;

interface Built {
  /** The text handed to gpu.pass (helpers + user code). */
  wgsl: string;
  /** Standalone copy used only to compile-check the code with exact line numbers. */
  check: string;
  /** Lines of `check` that come before the user's first line. */
  before: number;
  userLines: number;
}

function build(code: string, hasSrc: boolean, hasSrc2: boolean): Built {
  const helpers = HELPERS(hasSrc, hasSrc2);
  const full = /\bfn\s+fx\s*\(/.test(stripComments(code));
  const wgsl = full ? `${helpers}\n${code}` : `${helpers}\nfn fx(uv: vec2f, px: vec2f) -> vec4f {\n${code}\n}`;
  // The declarations the kernel adds in front of a pass (same names and types; the memory layout does not matter for checking).
  let binding = 3;
  const prefix = [
    'struct U { size: vec2f, a: f32, b: f32, c: f32, d: f32, color: vec4f, time: f32, phase: f32 };',
    '@group(0) @binding(0) var<uniform> u: U;',
    '@group(0) @binding(1) var smp: sampler;',
    '@group(0) @binding(2) var smpNearest: sampler;',
    hasSrc ? `@group(0) @binding(${binding++}) var img: texture_2d<f32>;` : '',
    hasSrc2 ? `@group(0) @binding(${binding++}) var img2: texture_2d<f32>;` : '',
    PRELUDE,
    PASS_PRELUDE,
  ].join('\n');
  const before = countLines(prefix) + countLines(helpers) + (full ? 0 : 1);
  const entry = '@fragment fn check_entry(@builtin(position) p: vec4f) -> @location(0) vec4f { return fx(p.xy / u.size, p.xy); }';
  return { wgsl, check: `${prefix}\n${wgsl}\n${entry}`, before, userLines: countLines(code) };
}

/** Compile the user's code on its own and describe the first error against the USER's lines. Null = it compiles. */
async function validate(device: GPUDevice, built: Built): Promise<string | null> {
  const module = device.createShaderModule({ label: 'custom-shader check', code: built.check });
  const info = await module.getCompilationInfo();
  const err = info.messages.find((m) => m.type === 'error');
  if (!err) return null;
  const line = err.lineNum - built.before;
  const text = err.message.replace(/\s+/g, ' ').trim();
  if (line >= 1 && line <= built.userLines) return `Shader error, line ${line}, column ${err.linePos}: ${text}`;
  if (err.lineNum > built.before + built.userLines) {
    return `Shader error: ${text} (the code must define fn fx(uv: vec2f, px: vec2f) -> vec4f, or be the body of it and end with a return of a vec4f)`;
  }
  return `Shader error: ${text}`;
}

const outcomes = new Map<string, string | null>();
const MAX_OUTCOMES = 64;

export default defineNode({
  id: 'custom-shader',
  title: 'Custom Shader',
  category: 'stylize',
  description:
    'Write your own effect or generator in WGSL, the shader language of WebGPU (open standard, close to GLSL). Reads up to two images, four sliders and a color; animates in a perfect loop from the loop phase. For quick experiments: ship a polished effect as a plugin.',
  keywords: ['shader', 'wgsl', 'code', 'glsl', 'shadertoy', 'fragment', 'program', 'script', 'custom', 'effect', 'generator', 'webgpu'],
  inputs: {
    image: { type: 'image', label: 'Image' },
    image2: { type: 'image', label: 'Image 2' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    code: {
      type: 'string',
      kind: 'code',
      multiline: true,
      default: DEFAULT_SHADER,
      label: 'Shader code',
      hint: SHADER_HELP,
      examples: SHADER_EXAMPLES,
    },
    a: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'A', hint: 'Available in the code as u.a' },
    b: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'B', hint: 'u.b' },
    c: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'C', hint: 'u.c' },
    d: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'D', hint: 'u.d' },
    color: { type: 'color', default: [0.35, 0.8, 1, 1], label: 'Color', hint: 'u.color (straight rgba)' },
  },
  summary: (p, wired) => `WGSL · ${p.code.trim() ? p.code.split('\n').length : 0} lines${wired?.has('image') ? '' : ' · no input: canvas size'}`,
  async render(ctx) {
    const p = ctx.params;
    const code = p.code;
    const size = ctx.in.image ?? ctx.in.image2 ?? ctx.canvas;
    if (!code.trim()) {
      // Nothing written yet: pass the picture through (or a clear frame).
      if (ctx.in.image) return { image: ctx.in.image };
      return { image: ctx.gpu.pass({ label: 'custom-shader-empty', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' }) };
    }
    if (code.length > MAX_CODE) throw new Error(`The shader code is too long (${code.length} characters, the limit is ${MAX_CODE}).`);

    const built = build(code, !!ctx.in.image, !!ctx.in.image2);
    let problem = outcomes.get(built.wgsl);
    if (problem === undefined) {
      problem = await validate(ctx.gpu.device, built);
      outcomes.set(built.wgsl, problem);
      if (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value as string);
    }
    if (problem) throw new Error(problem);

    // Read the clock only when the code can use it, so a still shader is not re-rendered every frame.
    const body = stripComments(code);
    const usesTime = /\bu\s*\.\s*time\b/.test(body);
    const usesPhase = /\bu\s*\.\s*phase\b/.test(body);
    const image = ctx.gpu.pass({
      label: 'custom-shader',
      size,
      textures: { img: ctx.in.image, img2: ctx.in.image2 },
      uniforms: {
        a: p.a,
        b: p.b,
        c: p.c,
        d: p.d,
        color: p.color,
        time: usesTime ? ctx.time.seconds : 0,
        phase: usesPhase ? ctx.time.phase : 0,
      },
      wgsl: built.wgsl,
    });
    return { image };
  },
});
