/**
 * Entry point of the IO layer. `createIo()` wires the GPU device, registry, library, engine, player,
 * exporter, plugin manager and project store together.
 */
import { Registry } from '../engine/define';
import { Engine } from '../engine/engine';
import { Gpu, createBrowserDevice } from '../engine/gpu/gpu';
import { batchCount } from '../engine/graph';
import { registerBuiltins } from '../engine/nodes';
import type { Io, CreateIo } from './api';
import { createAudioBridge } from './audio-bridge';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';
import { Library } from './library';
import { PlayerImpl } from './player';
import { PluginManagerImpl } from './plugins';
import { ProjectStoreImpl } from './projects';
import { ScanImpl } from './scan';

export const createIo: CreateIo = async () => {
  const device = await createBrowserDevice();
  device.addEventListener?.('uncapturederror', (e) => {
    console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error?.message ?? e);
  });
  const gpu = new Gpu(device);
  const registry = new Registry();
  registerBuiltins(registry);

  const library = new Library(gpu);
  const engine = new Engine(gpu, registry, library);
  library.onInvalidate = () => engine.clear();
  const gate = new EvalGate(engine);
  const audio = createAudioBridge();

  const player = new PlayerImpl({ gpu, gate, registry, audio, library });
  library.subscribe(() => player.invalidate());

  const exporter = new ExporterImpl({ gpu, gate, registry, library, audio });
  const plugins = new PluginManagerImpl(registry);
  const projects = new ProjectStoreImpl(registry);

  const io: Io = {
    engine,
    registry,
    library,
    player,
    exporter,
    plugins,
    projects,
    scan: new ScanImpl(library),
    async evaluate(graph, node, opts = {}) {
      const res = await gate.evaluate({
        graph,
        node,
        port: opts.port,
        seconds: opts.seconds ?? 0,
        item: opts.item ?? 0,
        itemCount: batchCount(graph, registry),
        proxy: opts.proxy ?? 1,
        quality: 'preview',
      });
      return res.value;
    },
  };
  return io;
};
