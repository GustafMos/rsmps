// Smoke test: can this machine run WebGPU headlessly in Node (used by tests and the CLI)?
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) {
  console.error('No WebGPU adapter available.');
  process.exit(1);
}
console.log('adapter:', adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description);
const device = await adapter.requestDevice();
const tex = device.createTexture({
  size: [4, 4],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const enc = device.createCommandEncoder();
enc
  .beginRenderPass({
    colorAttachments: [
      { view: tex.createView(), clearValue: [1, 0.5, 0, 1], loadOp: 'clear', storeOp: 'store' },
    ],
  })
  .end();
const buf = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [4, 4]);
device.queue.submit([enc.finish()]);
await buf.mapAsync(GPUMapMode.READ);
console.log('first pixel:', [...new Uint8Array(buf.getMappedRange()).slice(0, 4)]);
process.exit(0);
