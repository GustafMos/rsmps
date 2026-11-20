import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STYLE_AI_MESSAGES, STYLE_AI_MODEL } from '../engine/lib/style-ai-bridge';
import { adainMix, addTile, featureStats, joinFrame, packTile, styleStages, styleTiles, styleWorkSize, toRgba } from '../engine/lib/style-ai-math';
import type { OrtLike, OrtSessionLike } from './depth-ai';
import { STYLE_AI_MODEL_IDS, modelEntry } from './model-catalogue';
import { MemoryModelBackend, ModelStore } from './models';
import { STYLE_FEATURE_FLOATS, STYLE_PICTURE_FLOATS, createStyleAiRuntime, isOutOfMemory } from './style-ai';

/** A fake onnxruntime-web: tells encoder from decoder by the file size, records providers and shapes, can fail in several ways. */
function fakeOrt(o: { webgpuCreateFails?: string; webgpuRunFails?: string; loseDeviceAtRun?: number; oomAtRun?: number; wrongSize?: boolean } = {}) {
  const log = { created: [] as string[], runs: [] as string[], dims: [] as number[][], released: 0, concurrent: 0, maxConcurrent: 0 };
  const encoderBytes = modelEntry(STYLE_AI_MODEL.encoder)!.bytes;
  const ort: OrtLike = {
    env: { wasm: {} },
    Tensor: class {
      constructor(public type: string, public data: Float32Array, public dims: readonly number[]) {}
    } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      async create(model, options) {
        const ep = (options.executionProviders as string[])[0];
        if (ep === 'webgpu' && o.webgpuCreateFails) throw new Error(o.webgpuCreateFails);
        const which = model.length === encoderBytes ? 'encoder' : 'decoder';
        log.created.push(`${ep}:${which}`);
        const session: OrtSessionLike = {
          inputNames: ['input.1'],
          outputNames: ['out'],
          async run(feeds) {
            log.concurrent++;
            log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
            await new Promise((r) => setTimeout(r, 1));
            log.concurrent--;
            log.runs.push(`${ep}:${which}`);
            const n = log.runs.length;
            if (o.loseDeviceAtRun === n) throw new Error('Device is lost');
            if (o.oomAtRun === n) throw new Error('std::bad_alloc');
            if (ep === 'webgpu' && o.webgpuRunFails) throw new Error(o.webgpuRunFails);
            const t = feeds['input.1'] as { dims: number[]; data: Float32Array };
            log.dims.push([...t.dims]);
            const size = o.wrongSize ? 7 : which === 'encoder' ? STYLE_FEATURE_FLOATS : STYLE_PICTURE_FLOATS;
            const data = new Float32Array(size).fill(t.data[0]);
            return { out: { dims: [], type: 'float32', getData: async () => data, dispose: () => undefined } };
          },
          async release() {
            log.released++;
          },
        };
        return session;
      },
    },
  };
  return { ort, log };
}

async function make(o: Parameters<typeof fakeOrt>[0] & { gpu?: boolean; ready?: 'both' | 'encoder' | 'none' } = {}) {
  const backend = new MemoryModelBackend();
  const have = o.ready === 'none' ? [] : o.ready === 'encoder' ? [STYLE_AI_MODEL.encoder] : STYLE_AI_MODEL_IDS;
  for (const id of have) await backend.put(id, new Blob([new Uint8Array(modelEntry(id)!.bytes)]));
  const store = new ModelStore({ fetch: vi.fn() as unknown as typeof fetch, backend });
  const f = fakeOrt(o);
  const rt = createStyleAiRuntime({ store, loadOrt: async () => f.ort, hasWebGpu: async () => o.gpu !== false, idleMs: 0, toBlob: async (rgba) => new Blob([rgba as BlobPart]) });
  return { rt, ...f };
}

const picture = (v = 0.25) => new Float32Array(STYLE_PICTURE_FLOATS).fill(v);
const features = (v = 2) => new Float32Array(STYLE_FEATURE_FLOATS).fill(v);

describe('style transfer runtime', () => {
  it('needs BOTH files; says so without loading anything, and never downloads', async () => {
    for (const ready of ['none', 'encoder'] as const) {
      const a = await make({ ready });
      expect(await a.rt.modelReady()).toBe(false);
      await expect(a.rt.open()).rejects.toThrow(STYLE_AI_MESSAGES.noModel);
      expect(a.log.created).toEqual([]);
    }
    const b = await make();
    expect(await b.rt.modelReady()).toBe(true);
    expect(b.log.created).toEqual([]); // still nothing loaded
  });

  it('loads one pair of WebGPU sessions, reuses it, and feeds the fixed layouts: picture 1x3x512x512, features 1x512x64x64', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    expect(e.provider).toBe('webgpu');
    const f = await e.encode(picture());
    const p = await e.decode(features());
    expect(f.length).toBe(STYLE_FEATURE_FLOATS);
    expect(f[0]).toBe(0.25);
    expect(p.length).toBe(STYLE_PICTURE_FLOATS);
    expect(p[5]).toBe(2);
    expect(log.dims).toEqual([[1, 3, 512, 512], [1, 512, 64, 64]]);
    await e.encode(picture());
    await rt.open();
    expect(log.created).toEqual(['webgpu:encoder', 'webgpu:decoder']);
    expect(e.note).toBeUndefined();
  });

  it('serialises: two runs never overlap', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    await Promise.all([e.encode(picture()), e.decode(features()), e.encode(picture())]);
    expect(log.runs.length).toBe(3);
    expect(log.maxConcurrent).toBe(1);
  });

  it('refuses data of the wrong size before it reaches the model, and a model that answers with the wrong size', async () => {
    const { rt } = await make();
    const e = await rt.open();
    await expect(e.encode(new Float32Array(12))).rejects.toThrow(/was given 12 values/);
    const bad = await make({ wrongSize: true, gpu: false });
    await expect((await bad.rt.open()).decode(features())).rejects.toThrow(/returned 7 values/);
  });

  it('falls back to the processor when WebGPU cannot create the model, or has none, and says why', async () => {
    const a = await make({ webgpuCreateFails: 'no kernel for Pad(reflect)' });
    const ea = await a.rt.open();
    expect(a.log.created).toEqual(['wasm:encoder', 'wasm:decoder']);
    expect(ea.provider).toBe('wasm');
    expect(ea.note).toMatch(/no kernel for Pad\(reflect\).*slow/);
    const b = await make({ gpu: false });
    expect((await b.rt.open()).note).toMatch(/no WebGPU/);
  });

  it('when WebGPU creates the model but cannot run it, the same call is run again on the processor and it stays there', async () => {
    const { rt, log } = await make({ webgpuRunFails: 'Failed to run JSEP kernel Resize' });
    const e = await rt.open();
    expect(e.provider).toBe('webgpu');
    const f = await e.encode(picture(0.5));
    expect(f[0]).toBe(0.5);
    expect(e.provider).toBe('wasm');
    expect(e.note).toMatch(/Failed to run JSEP kernel Resize.*slow/);
    await e.decode(features());
    await rt.dispose();
    await (await rt.open()).encode(picture()); // after a release it does not try WebGPU again
    expect(log.created).toEqual(['webgpu:encoder', 'webgpu:decoder', 'wasm:encoder', 'wasm:decoder', 'wasm:encoder', 'wasm:decoder']);
    expect(log.runs).toEqual(['webgpu:encoder', 'wasm:encoder', 'wasm:decoder', 'wasm:encoder']);
  });

  it('on device loss it releases the sessions, tells the user, and the next call loads fresh ones', async () => {
    const { rt, log } = await make({ loseDeviceAtRun: 1 });
    const e = await rt.open();
    await expect(e.encode(picture())).rejects.toThrow(/GPU was reset.*Render again/);
    expect(log.released).toBe(2);
    expect(rt.info().loaded).toBe(false);
    await (await rt.open()).encode(picture());
    expect(log.created.length).toBe(4);
  });

  it('out of memory is said in plain words', async () => {
    const { rt } = await make({ oomAtRun: 1 });
    await expect((await rt.open()).encode(picture())).rejects.toThrow(STYLE_AI_MESSAGES.memory);
    expect(isOutOfMemory(new Error('Array buffer allocation failed'))).toBe(true);
    expect(isOutOfMemory(new Error('invalid input name'))).toBe(false);
  });

  it('a cancelled job does not run the model', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    const ctl = new AbortController();
    ctl.abort();
    await expect(e.encode(picture(), ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.runs).toEqual([]);
  });
});

/**
 * The REAL model, when its two files are on this computer (they are never in the repository and the test machines have no network):
 *
 *   STYLE_AI_MODEL_DIR=/path/with/adain-vgg.onnx/and/adain-decoder.onnx npx vitest run src/io/style-ai.test.ts
 *
 * Add STYLE_AI_OUT=/some/folder to get the pictures as PNG. It checks the files against the catalogue, runs the two networks on the
 * processor through this runtime, and checks what the node relies on: decode(encode(picture)) is that picture again, and giving A's
 * features B's statistics moves A's colours to B's while A's shapes stay.
 */
const DIR = process.env.STYLE_AI_MODEL_DIR ?? '';
const files = STYLE_AI_MODEL_IDS.map((id) => join(DIR, modelEntry(id)!.file));
const present = !!DIR && files.every((f) => existsSync(f));

describe.skipIf(!present)('the real AdaIN model (only when STYLE_AI_MODEL_DIR has the files)', () => {
  it('the files are the catalogued ones, and a transition painted with them behaves as the node expects', { timeout: 600000 }, async () => {
    const backend = new MemoryModelBackend();
    STYLE_AI_MODEL_IDS.forEach((id, i) => {
      const bytes = readFileSync(files[i]);
      const e = modelEntry(id)!;
      expect(bytes.length).toBe(e.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256);
      backend.files.set(id, new Blob([bytes as BlobPart]));
    });
    const store = new ModelStore({ fetch: vi.fn() as unknown as typeof fetch, backend });
    const ortName = 'onnxruntime-web';
    const rt = createStyleAiRuntime({
      store,
      loadOrt: async () => {
        const ort = (await import(/* @vite-ignore */ ortName)) as unknown as OrtLike;
        ort.env.wasm.numThreads = Number(process.env.STYLE_AI_THREADS ?? 4);
        return ort;
      },
      hasWebGpu: async () => false,
      idleMs: 0,
      toBlob: async (rgba) => new Blob([rgba as BlobPart]),
    });
    const engine = await rt.open();
    expect(engine.provider).toBe('wasm');

    // A: a 16:9 scene of flat shapes (sky, sun, hills). B: warm diagonal brush strokes. Both made here, 640 x 360.
    const W = 640;
    const H = 360;
    const make = (fn: (x: number, y: number) => [number, number, number]) => {
      const px = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([...fn(x, y), 255], (y * W + x) * 4);
      return px;
    };
    const a = make((x, y) => {
      if (Math.hypot(x - 470, y - 110) < 55) return [250, 220, 120];
      if (y > 230 + 40 * Math.sin(x / 70)) return [40, 110, 60];
      return [60, 110 + y / 4, 220];
    });
    const b = make((x, y) => {
      const s = Math.sin((x + y) / 9) * Math.sin((x - 2 * y) / 23);
      return [200 + 55 * s, 110 + 90 * s, 30 + 30 * Math.sin(x / 5)];
    });
    const { resizeRgba } = await import('../engine/lib/style-ai-math');
    const out = process.env.STYLE_AI_OUT;
    const save = async (name: string, rgba: Uint8ClampedArray, w: number, h: number) => {
      if (!out) return;
      mkdirSync(out, { recursive: true });
      const sharp = (await import('sharp')).default;
      await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } }).png().toFile(join(out, name));
    };

    for (const long of [512, 768]) {
      const size = styleWorkSize(W, H, long);
      const tiles = styleTiles(size.width, size.height);
      const pa = resizeRgba(a, W, H, size.width, size.height);
      const pb = resizeRgba(b, W, H, size.width, size.height);
      await save(`in-a-${long}.png`, pa, size.width, size.height);
      await save(`in-b-${long}.png`, pb, size.width, size.height);
      const t0 = Date.now();
      const fa: Float32Array[] = [];
      const fb: Float32Array[] = [];
      for (const t of tiles) {
        fa.push(await engine.encode(packTile(pa, size.width, size.height, t.x, t.y)));
        fb.push(await engine.encode(packTile(pb, size.width, size.height, t.x, t.y)));
      }
      const cw = size.width / STYLE_AI_MODEL.stride;
      const ch = size.height / STYLE_AI_MODEL.stride;
      const sa = featureStats(fa, cw, ch);
      const sb = featureStats(fb, cw, ch);
      // features are what the bridge says: not negative (after a ReLU)
      expect(Math.min(...fa[0].subarray(0, 4096))).toBeGreaterThanOrEqual(0);

      const paint = async (shape: number, lead: number) => {
        const acc = new Float32Array(size.width * size.height * 3);
        const weight = new Float32Array(size.width * size.height);
        const mixed = new Float32Array(STYLE_FEATURE_FLOATS);
        for (let k = 0; k < tiles.length; k++) addTile(await engine.decode(adainMix(fa[k], fb[k], sa, sb, shape, lead, mixed)), tiles[k], size.width, size.height, acc, weight);
        return toRgba(joinFrame(acc, weight, null, 0), size.width, size.height);
      };
      const diff = (p: Uint8ClampedArray, q: Uint8ClampedArray) => {
        let s = 0;
        for (let i = 0; i < p.length; i++) if (i % 4 !== 3) s += Math.abs(p[i] - q[i]);
        return s / (p.length * 0.75);
      };
      const mean = (p: Uint8ClampedArray, k: number) => {
        let s = 0;
        for (let i = k; i < p.length; i += 4) s += p[i];
        return s / (p.length / 4);
      };

      const backA = await paint(0, 0);
      const first = (Date.now() - t0) / 1000;
      const styled = await paint(0, 1);
      const backB = await paint(1, 1);
      await save(`a-through-the-network-${long}.png`, backA, size.width, size.height);
      await save(`a-in-the-style-of-b-${long}.png`, styled, size.width, size.height);
      await save(`b-through-the-network-${long}.png`, backB, size.width, size.height);
      if (out) for (const t of [0.15, 0.3, 0.45, 0.6, 0.8]) await save(`transition-${long}-${Math.round(t * 100)}.png`, await paint(styleStages(t).shape, styleStages(t).lead), size.width, size.height);
      console.log(`AdaIN ${size.width}x${size.height}, ${tiles.length} tile(s), wasm: one frame (2 encodes + 1 decode per tile) took ${first.toFixed(1)} s`);

      // decode(encode(picture)) is that picture (painterly, so not exact): much closer to itself than to the other picture
      expect(diff(backA, pa)).toBeLessThan(30);
      expect(diff(backA, pa)).toBeLessThan(diff(backA, pb) * 0.6);
      expect(diff(backB, pb)).toBeLessThan(diff(backB, pa) * 0.6);
      // A in the style of B: the colours went to B's (A is blue and green, B is orange)...
      expect(mean(styled, 0) - mean(styled, 2)).toBeGreaterThan(mean(backA, 0) - mean(backA, 2) + 40);
      // ...but it is not B: the sun of A (brighter than the sky around it) is still there
      const lum = (p: Uint8ClampedArray, x: number, y: number) => {
        const i = (Math.round((y * size.height) / H) * size.width + Math.round((x * size.width) / W)) * 4;
        return p[i] + p[i + 1] + p[i + 2];
      };
      expect(lum(styled, 470, 110)).toBeGreaterThan(lum(styled, 250, 60));
    }
  });
});
