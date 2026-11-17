import { describe, expect, it, vi } from 'vitest';
import { DEPTH_ANYTHING_V2_SMALL_ID, modelEntry } from './model-catalogue';
import { MemoryModelBackend, ModelStore } from './models';
import { createDepthAiRuntime, isDeviceLost, type OrtLike, type OrtSessionLike } from './depth-ai';

/** A fake onnxruntime-web: records providers, returns a ramp as "depth", can fail on WebGPU or lose the device. */
function fakeOrt(o: { webgpuFails?: string; loseDeviceAtRun?: number; half?: boolean } = {}) {
  const log = { created: [] as string[], runs: 0, released: 0, dims: [] as number[][], concurrent: 0, maxConcurrent: 0 };
  const ort: OrtLike = {
    env: { wasm: {} },
    Tensor: class {
      constructor(public type: string, public data: Float32Array, public dims: readonly number[]) {}
    } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      async create(_m, options) {
        const ep = (options.executionProviders as string[])[0];
        if (ep === 'webgpu' && o.webgpuFails) throw new Error(o.webgpuFails);
        log.created.push(ep);
        const session: OrtSessionLike = {
          inputNames: ['pixel_values'],
          outputNames: ['predicted_depth'],
          async run(feeds) {
            log.concurrent++;
            log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
            await new Promise((r) => setTimeout(r, 2));
            log.concurrent--;
            log.runs++;
            if (o.loseDeviceAtRun === log.runs) throw new Error('Device is lost');
            const t = feeds.pixel_values as { dims: number[] };
            log.dims.push(t.dims);
            const [, , h, w] = t.dims;
            const data = new Float32Array(w * h).map((_, i) => (i % w) / w);
            return { predicted_depth: { dims: [1, h, w], type: 'float32', getData: async () => data, dispose: () => undefined } };
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

async function make(o: Parameters<typeof fakeOrt>[0] & { gpu?: boolean; ready?: boolean } = {}) {
  const entry = modelEntry(DEPTH_ANYTHING_V2_SMALL_ID)!;
  const backend = new MemoryModelBackend();
  if (o.ready !== false) await backend.put(entry.id, new Blob([new Uint8Array(entry.bytes)]));
  const store = new ModelStore({ fetch: vi.fn() as unknown as typeof fetch, backend });
  const f = fakeOrt(o);
  const rt = createDepthAiRuntime({ store, loadOrt: async () => f.ort, hasWebGpu: async () => o.gpu !== false, idleMs: 0 });
  return { rt, ...f };
}

const rgba = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).fill(128);

describe('depth runtime', () => {
  it('says whether the model file is present without loading anything', async () => {
    const a = await make({ ready: false });
    expect(await a.rt.modelReady()).toBe(false);
    expect(a.rt.info().loaded).toBe(false);
    const b = await make();
    expect(await b.rt.modelReady()).toBe(true);
    expect(b.log.created).toEqual([]); // still nothing loaded
  });

  it('refuses to open without the model (it never downloads it)', async () => {
    const a = await make({ ready: false });
    await expect(a.rt.open()).rejects.toThrow(/not on this computer/);
  });

  it('loads one WebGPU session, reuses it for every frame, and resizes to a multiple of 14 keeping the aspect', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    expect(e.provider).toBe('webgpu');
    const r1 = await e.infer(rgba(160, 90), 160, 90, 518);
    const r2 = await e.infer(rgba(160, 90), 160, 90, 518);
    expect(log.created).toEqual(['webgpu']);
    expect(log.runs).toBe(2);
    expect(log.dims[0]).toEqual([1, 3, 294, 518]);
    expect(r1).toMatchObject({ width: 518, height: 294 });
    expect(r1.data.length).toBe(518 * 294);
    expect(r2.data[1]).toBeCloseTo(1 / 518, 6);
    await rt.open(); // opening again reuses it
    expect(log.created).toEqual(['webgpu']);
  });

  it('serialises jobs: two inferences never overlap', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    await Promise.all([e.infer(rgba(28, 14), 28, 14, 392), e.infer(rgba(28, 14), 28, 14, 392), e.infer(rgba(28, 14), 28, 14, 392)]);
    expect(log.runs).toBe(3);
    expect(log.maxConcurrent).toBe(1);
  });

  it('falls back to WASM and keeps the exact WebGPU error in a note when the model fails on WebGPU', async () => {
    const { rt, log } = await make({ webgpuFails: 'Failed to run JSEP kernel: unsupported op Foo' });
    const e = await rt.open();
    expect(log.created).toEqual(['wasm']);
    expect(e.provider).toBe('wasm');
    expect(e.note).toMatch(/Failed to run JSEP kernel: unsupported op Foo/);
    expect(e.note).toMatch(/slow/);
  });

  it('uses WASM with a clear note when there is no WebGPU at all', async () => {
    const { rt } = await make({ gpu: false });
    const e = await rt.open();
    expect(e.provider).toBe('wasm');
    expect(e.note).toMatch(/no WebGPU/);
  });

  it('on device loss it releases the session, tells the user, and the next job loads a fresh one', async () => {
    const { rt, log } = await make({ loseDeviceAtRun: 1 });
    const e = await rt.open();
    await expect(e.infer(rgba(28, 14), 28, 14, 392)).rejects.toThrow(/GPU was reset/);
    expect(log.released).toBe(1);
    expect(rt.info().loaded).toBe(false);
    const e2 = await rt.open();
    await e2.infer(rgba(28, 14), 28, 14, 392);
    expect(log.created).toEqual(['webgpu', 'webgpu']);
  });

  it('dispose releases the session on demand', async () => {
    const { rt, log } = await make();
    await rt.open();
    expect(rt.info().loaded).toBe(true);
    await rt.dispose();
    expect(log.released).toBe(1);
    expect(rt.info().loaded).toBe(false);
  });

  it('aborted before it starts: nothing runs', async () => {
    const { rt, log } = await make();
    const e = await rt.open();
    const ctl = new AbortController();
    ctl.abort();
    await expect(e.infer(rgba(28, 14), 28, 14, 392, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.runs).toBe(0);
  });

  it('recognises device-loss errors', () => {
    expect(isDeviceLost(new Error('Device is lost'))).toBe(true);
    expect(isDeviceLost(new Error('GPUDevice was destroyed'))).toBe(true);
    expect(isDeviceLost(new Error('out of memory'))).toBe(false);
  });
});
