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
import { MemoryGovernor, defaultBudget } from './memory';
import { GpuWatch } from './gpu-watch';
import { EvalGate } from './gate';
import { Library } from './library';
import { listVideoInputs, onVideoDevicesChanged } from './live';
import { PlayerImpl } from './player';
import { PluginManagerImpl } from './plugins';
import { ProjectStoreImpl } from './projects';
import { PhoneLink } from './phone';
import { RecordingController } from './recording';
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
  const watch = new GpuWatch();
  watch.attach(device);
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

  // Late-bound: the governor needs the player, the player reports the governor's numbers.
  let governor!: MemoryGovernor;
  const player = new PlayerImpl({ gpu, gate, registry, audio, library, router, memory: { snapshot: () => governor.snapshot(), relieve: () => void governor.freeMemory() } });
  router.onExportEnd = () => player.invalidate();
  library.subscribe(() => player.invalidate());

  const adapterInfo = (device as unknown as { adapterInfo?: { vendor?: string; architecture?: string; description?: string } }).adapterInfo;
  const deviceMemoryGB = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  governor = new MemoryGovernor(
    {
      gpu,
      exclusive: (fn) => gate.exclusive(fn),
      setEngineBudget: (b) => void gate.setCacheBudget(b),
      clearEngine: () => gate.clearEngine(),
      setPlayerBudget: (b) => player.setCacheBudget(b),
      dropPlayerFrames: () => player.dropFrameCache(),
      setMediaBudget: (b) => void library.setFrameBudget(b),
      dropMediaFrames: () => library.dropFrames(),
      isPlaying: () => player.isPlaying,
    },
    defaultBudget({ vendor: adapterInfo?.vendor, architecture: adapterInfo?.architecture, description: adapterInfo?.description, deviceMemoryGB }),
  );
  governor.start();
  const exporter = new ExporterImpl({ gpu, gate, registry, library, audio, router, player, watch, governor });

  // A lost GPU device is replaced in place: the Gpu object (and so engine, library, player) keeps working, all caches and texture
  // handles are dropped, the canvas is reconnected and the current view renders again. Editor state is untouched.
  const adopt = async () => {
    const next = await createBrowserDevice();
    gpu.replaceDevice(next);
    watch.attach(next);
    engine.forgetAll();
    library.onDeviceReset();
    exporter.onDeviceReset();
    player.onDeviceReset();
    watchLoss(next);
  };
  const watchLoss = (dev: GPUDevice) => {
    void dev.lost.then(async (info) => {
      try {
        await adopt();
      } catch {
        await new Promise((r) => setTimeout(r, 1000)); // one more try; the 'device' error is shown only when recovery fails twice in a row
        try {
          await adopt();
        } catch (err) {
          player.deviceLost(info.message || info.reason || String(err));
        }
      }
    });
  };
  watchLoss(device);
  watch.onError((m) => player.reportGpuError(m));
  const phone = new PhoneLink();
  await phone.init();
  library.live.phone = phone;
  const recording = new RecordingController(audio, player, library);
  const plugins = new PluginManagerImpl(registry);
  const purgeOwned = (id: string, kind: 'graph' | 'scan') => {
    if (kind === 'scan') void library.removeOwned(id);
  };
  const projects = new ProjectStoreImpl(registry);
  projects.onPurge = purgeOwned;

  const io: Io = {
    engine,
    registry,
    library,
    player,
    exporter,
    plugins,
    projects,
    scan: new ScanImpl(library),
    memoryBudget: { get: () => governor.get(), set: (b) => governor.set(b), auto: () => governor.auto() },
    freeMemory: () => governor.freeMemory(),
    async switchProject(id) {
      await projects.flush(); // (a) the old project's pending save
      player.releaseCaches(); // (b) pause + audio off, (c) player frame cache
      audio.stop();
      const graph = await projects.loadProject(id);
      await gate.clearEngine(); // (c) engine cache (waits for an in-flight evaluation)
      library.releaseDecodedExcept(graph ? assetIdsOf(graph, registry) : new Set()); // (d)
      gpu.trim(); // (c) idle pooled textures of the old project
      await projects.setActive(id); // (e) works for graph and scan projects (a scan project without a graph yet returns null)
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
    phone,
    capabilities: () => new Set(phone.available ? (["local-server"] as const) : []),
    devices: {
      list: (kind) => (kind === 'video-input' ? listVideoInputs() : audio.listDevices(kind)),
      onChanged: (l) => {
        const offs = [audio.onDevicesChanged(l), onVideoDevicesChanged(l)];
        return () => offs.forEach((off) => off());
      },
    },
    audio: {
      arm: (id, t) => recording.arm(id, t),
      record: () => recording.record(),
      stop: () => recording.stop(),
      recordingState: () => recording.recordingState(),
      onRecordingState: (l) => recording.onRecordingState(l),
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
