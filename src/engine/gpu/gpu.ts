/**
 * The single GPU context of the engine: one device, a texture pool, a pipeline
 * cache and the full-screen pass helper nodes use. Nothing here knows about graphs.
 */
import type { ImageValue, MaskValue, NodeGpu, PassOptions, UniformValue } from '../types';
import { PRELUDE } from './prelude';

type Format = 'rgba8unorm' | 'rgba16float';

const VERTEX = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f { return fx(in.uv, in.pos.xy); }
`;

interface UniformLayout {
  wgsl: string;
  size: number;
  fields: { name: string; offset: number; count: number }[];
}

function layoutUniforms(uniforms: Record<string, UniformValue>): UniformLayout {
  const fields: UniformLayout['fields'] = [];
  const lines: string[] = [];
  let offset = 0;
  const add = (name: string, count: number) => {
    const align = count === 1 ? 4 : count === 2 ? 8 : 16;
    const size = count === 3 ? 12 : count * 4;
    offset = Math.ceil(offset / align) * align;
    fields.push({ name, offset, count });
    lines.push(`  ${name}: ${count === 1 ? 'f32' : `vec${count}f`},`);
    offset += size;
  };
  add('size', 2);
  for (const [name, value] of Object.entries(uniforms)) {
    if (name === 'size') throw new Error('uniform name "size" is reserved (output size)');
    const count = typeof value === 'number' || typeof value === 'boolean' ? 1 : value.length;
    if (count < 1 || count > 4) throw new Error(`uniform "${name}" must be a number, bool or array of 2-4 numbers`);
    add(name, count);
  }
  return { wgsl: `struct U {\n${lines.join('\n')}\n};`, size: Math.ceil(offset / 16) * 16, fields };
}

export class Gpu {
  readonly device: GPUDevice;
  private pool = new Map<string, GPUTexture[]>();
  private pooled = new Set<GPUTexture>();
  private refs = new Map<GPUTexture, number>();
  /** Stack of scopes; each holds textures handed out inside it (recycled at `end()` if nobody retained them). */
  private fresh: Set<GPUTexture>[] = [new Set()];
  private pipelines = new Map<string, { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }>();
  private linear: GPUSampler;
  private nearest: GPUSampler;
  private blitPipelines = new Map<string, GPURenderPipeline>();
  /** Bytes currently allocated in pooled textures (in use + idle). */
  allocatedBytes = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  /* ---------------------------- texture lifetime ------------------------ */

  acquire(width: number, height: number, format: Format = 'rgba8unorm'): GPUTexture {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${w}x${h}:${format}`;
    let tex = this.pool.get(key)?.pop();
    if (!tex) {
      tex = this.device.createTexture({
        size: [w, h],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING,
      });
      this.pooled.add(tex);
      this.allocatedBytes += w * h * (format === 'rgba8unorm' ? 4 : 8);
    }
    this.fresh[this.fresh.length - 1].add(tex);
    return tex;
  }

  retain(tex: GPUTexture): void {
    if (!this.pooled.has(tex)) return;
    this.refs.set(tex, (this.refs.get(tex) ?? 0) + 1);
  }

  release(tex: GPUTexture): void {
    if (!this.pooled.has(tex)) return;
    const n = (this.refs.get(tex) ?? 0) - 1;
    if (n > 0) {
      this.refs.set(tex, n);
      return;
    }
    this.refs.delete(tex);
    this.recycle(tex);
  }

  /** Open a temp-texture scope (the kernel wraps every node render in begin/end). */
  begin(): void {
    this.fresh.push(new Set());
  }

  /** Close the scope: every texture acquired inside it that nobody retained goes back to the pool. */
  end(): void {
    const set = this.fresh.length > 1 ? this.fresh.pop()! : this.fresh[0];
    for (const tex of set) {
      if (!this.refs.has(tex)) this.recycle(tex);
    }
    set.clear();
  }

  private recycle(tex: GPUTexture): void {
    const key = `${tex.width}x${tex.height}:${tex.format}`;
    const list = this.pool.get(key) ?? [];
    if (!list.includes(tex)) list.push(tex);
    this.pool.set(key, list);
  }

  /** Destroy idle pooled textures (call when memory is tight or sizes changed a lot). */
  trim(): void {
    for (const list of this.pool.values()) {
      for (const tex of list) {
        this.allocatedBytes -= tex.width * tex.height * (tex.format === 'rgba8unorm' ? 4 : 8);
        this.pooled.delete(tex);
        tex.destroy();
      }
    }
    this.pool.clear();
  }

  /* ------------------------------- passes ------------------------------- */

  pass(options: PassOptions): ImageValue {
    const format: Format = options.format ?? 'rgba8unorm';
    const width = Math.max(1, Math.round(options.size.width));
    const height = Math.max(1, Math.round(options.size.height));
    const textures = options.textures ?? {};
    const names = Object.keys(textures).filter((n) => textures[n]);
    const uniforms = options.uniforms ?? {};
    const layout = layoutUniforms(uniforms);

    const decls = names.map((n, i) => `@group(0) @binding(${3 + i}) var ${n}: texture_2d<f32>;`).join('\n');
    const code = `${layout.wgsl}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var smpNearest: sampler;
${decls}
${PRELUDE}
${options.wgsl}
${VERTEX}`;

    const cacheKey = `${format}|${code}`;
    let entry = this.pipelines.get(cacheKey);
    if (!entry) {
      const bgl = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          ...names.map((_, i) => ({
            binding: 3 + i,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'float' as const },
          })),
        ],
      });
      const module = this.device.createShaderModule({ label: options.label, code });
      const pipeline = this.device.createRenderPipeline({
        label: options.label,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      entry = { pipeline, layout: bgl };
      this.pipelines.set(cacheKey, entry);
    }

    const data = new Float32Array(layout.size / 4);
    const values: Record<string, UniformValue> = { size: [width, height], ...uniforms };
    for (const f of layout.fields) {
      const v = values[f.name];
      const base = f.offset / 4;
      if (typeof v === 'number') data[base] = v;
      else if (typeof v === 'boolean') data[base] = v ? 1 : 0;
      else for (let i = 0; i < f.count; i++) data[base + i] = v[i];
    }
    const ubo = this.device.createBuffer({ size: layout.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ubo, 0, data);

    const target = this.acquire(width, height, format);
    const bindGroup = this.device.createBindGroup({
      layout: entry.layout,
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: this.linear },
        { binding: 2, resource: this.nearest },
        ...names.map((n, i) => {
          const tex = textures[n]!.texture;
          if (tex === target) throw new Error(`pass "${options.label ?? ''}": texture "${n}" cannot be both input and output`);
          return { binding: 3 + i, resource: tex.createView() };
        }),
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const rp = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    rp.setPipeline(entry.pipeline);
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([encoder.finish()]);
    ubo.destroy();

    return { kind: 'image', texture: target, width, height, unit: options.size.unit ?? 1 };
  }

  passMask(options: PassOptions): MaskValue {
    return { ...this.pass(options), kind: 'mask' };
  }

  alloc(width: number, height: number, unit: number, format: Format = 'rgba8unorm'): ImageValue {
    const texture = this.acquire(width, height, format);
    return { kind: 'image', texture, width: texture.width, height: texture.height, unit };
  }

  upload(data: Uint8Array | Uint8ClampedArray, width: number, height: number, unit: number, straight = true): ImageValue {
    let bytes: Uint8Array | Uint8ClampedArray = data;
    if (straight) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 255) {
          out[i] = data[i];
          out[i + 1] = data[i + 1];
          out[i + 2] = data[i + 2];
        } else {
          out[i] = Math.round((data[i] * a) / 255);
          out[i + 1] = Math.round((data[i + 1] * a) / 255);
          out[i + 2] = Math.round((data[i + 2] * a) / 255);
        }
        out[i + 3] = a;
      }
      bytes = out;
    }
    const texture = this.acquire(width, height, 'rgba8unorm');
    this.device.queue.writeTexture({ texture }, bytes as BufferSource, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
    return { kind: 'image', texture, width, height, unit };
  }

  async read(image: { texture: GPUTexture; width: number; height: number }, straight = true): Promise<Uint8ClampedArray> {
    const { width, height } = image;
    let texture = image.texture;
    if (texture.format !== 'rgba8unorm') {
      texture = this.pass({
        label: 'read-convert',
        size: { width, height },
        textures: { src: { texture } },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }',
      }).texture;
    }
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    if (straight) {
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        if (a !== 0 && a !== 255) {
          out[i] = Math.round((out[i] * 255) / a);
          out[i + 1] = Math.round((out[i + 1] * 255) / a);
          out[i + 2] = Math.round((out[i + 2] * 255) / a);
        }
      }
    }
    return out;
  }

  dataTexture(data: Float32Array, width: number, height: number): { texture: GPUTexture } {
    if (data.length !== width * height * 4) throw new Error('dataTexture: need width*height*4 floats');
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
    const texture = this.acquire(width, height, 'rgba16float');
    this.device.queue.writeTexture({ texture }, half, { bytesPerRow: width * 8, rowsPerImage: height }, [width, height]);
    return { texture };
  }

  /** Draw an image into a canvas texture (viewer, encoder). `nearest` keeps pixel art crisp. */
  blit(image: { texture: GPUTexture }, target: GPUTexture, nearest = true): void {
    const key = `${target.format}:${nearest}`;
    let pipeline = this.blitPipelines.get(key);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        code: `@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }
${VERTEX}`,
      });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: target.format }] },
      });
      this.blitPipelines.set(key, pipeline);
    }
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: nearest ? this.nearest : this.linear },
        { binding: 1, resource: image.texture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const rp = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    rp.setPipeline(pipeline);
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** The restricted facade handed to nodes. */
  facade(): NodeGpu {
    return {
      device: this.device,
      pass: (o) => this.pass(o),
      passMask: (o) => this.passMask(o),
      alloc: (w, h, unit, format) => this.alloc(w, h, unit, format),
      upload: (d, w, h, unit, straight) => this.upload(d, w, h, unit, straight),
      read: (img, straight) => this.read(img, straight),
      dataTexture: (d, w, h) => this.dataTexture(d, w, h),
    };
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 112;
  let mant = (x >> 12) & 0x7ff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = ((x & 0x7fffff) | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return (sign | (exp << 10) | (mant >> 1)) + (mant & 1);
}

/** Browser device. Throws a readable error when WebGPU is missing. */
export async function createBrowserDevice(): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser. Use a current Chrome, Edge, Firefox or Safari.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  return adapter.requestDevice();
}

/** Node.js device (tests, CLI) through the `webgpu` package. */
export async function createHeadlessDevice(): Promise<GPUDevice> {
  const name = 'webgpu';
  const mod = (await import(/* @vite-ignore */ name)) as { create: (flags: string[]) => GPU; globals: Record<string, unknown> };
  Object.assign(globalThis, mod.globals);
  const adapter = await mod.create([]).requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  return adapter.requestDevice();
}
