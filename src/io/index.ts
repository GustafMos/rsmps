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
import { SignalRouter } from './signals';
import { ScanImpl } from './scan';

/** Every asset id referenced by an `assets` param anywhere in the graph. */
export function assetIdsOf(graph: import('../engine/types').GraphDoc, registry: Registry): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!def) continue;
    for (const [key, p] of Object.entries(def.params)) {
      const v = n.params[key];
      if ((p as { type: string }).type === 'assets' && Array.isArray(v)) for (const x of v) if (typeof x === 'string') ids.add(x);
    }
  }
  return ids;
}

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
  const router = new SignalRouter();
  router.live = (id, name) => audio.signal(id, name);
  library.signals = router;

  const player = new PlayerImpl({ gpu, gate, registry, audio, library, router });
  router.onExportEnd = () => player.invalidate();
  library.subscribe(() => player.invalidate());

  const exporter = new ExporterImpl({ gpu, gate, registry, library, audio, router });
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
    async switchProject(id) {
      await projects.flush(); // (a) the old project's pending save
      player.releaseCaches(); // (b) pause + audio off, (c) player frame cache
      audio.stop();
      const graph = await projects.loadProject(id);
      await gate.clearEngine(); // (c) engine cache (waits for an in-flight evaluation)
      library.releaseDecodedExcept(graph ? assetIdsOf(graph, registry) : new Set()); // (d)
      gpu.trim(); // (c) idle pooled textures of the old project
      if (graph) await projects.setActive(id); // (e)
      return graph;
    },
    memory() {
      return {
        engineCacheBytes: (engine as unknown as { cacheBytes?: number }).cacheBytes ?? 0,
        gpuPoolBytes: gpu.allocatedBytes,
        frameCacheBytes: player.cacheBytes,
        decodedMediaBytes: library.decodedBytes(),
      };
    },
    audio: {
      listDevices: (kind) => audio.listDevices(kind),
      onDevicesChanged: (l) => audio.onDevicesChanged(l),
      sendNote: (id, n, v, on) => audio.sendNote(id, n, v, on),
    },
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
  if (import.meta.env.DEV) (window as unknown as { __rsmpsIo?: Io }).__rsmpsIo = io; // dev-only handle for browser tests
  return io;
};
