/**
 * Playback performance readout: what the Performance panel shows and the text of "Copy performance report".
 *
 * Everything here is pure except `perf`, a small set of counters that the media library and the player bump ONLY while the panel is
 * on (`perf.enabled`), so nothing is timed and nothing is allocated when it is off. The numbers are CPU-side wall-clock times: the GPU
 * works asynchronously, so a node's "ms" is the time the page spent on it (including waiting for its video frames), not its GPU time.
 */

export interface PerfCounters {
  enabled: boolean;
  decode: {
    /** Requests for a video frame that reached a decoder (frames already in the store are not counted). */
    requests: number;
    /** Frames taken in order from a decoder that kept running. */
    sequential: number;
    /** Frames that needed the decoder to jump to another place in the file. */
    seeks: number;
    /** Frames served by the browser's own video player (the fallback for files the fast decoder cannot read). */
    browser: number;
    /** Frames asked for again after they had already been decoded once (the store had let them go). */
    repeats: number;
    /** Frames decoded ahead of time, for the next picture. */
    ahead: number;
    /** Total time requests waited for a decoder (ms). */
    waitMs: number;
  };
  uploads: { count: number; pixels: number; sizes: string[] };
}

function fresh(): PerfCounters['decode'] {
  return { requests: 0, sequential: 0, seeks: 0, browser: 0, repeats: 0, ahead: 0, waitMs: 0 };
}

export const perf: PerfCounters = { enabled: false, decode: fresh(), uploads: { count: 0, pixels: 0, sizes: [] } };

export function resetPerf(): void {
  perf.decode = fresh();
  perf.uploads = { count: 0, pixels: 0, sizes: [] };
}

export function setPerfEnabled(on: boolean): void {
  if (on && !perf.enabled) resetPerf();
  perf.enabled = on;
}

export function noteUpload(width: number, height: number): void {
  perf.uploads.count++;
  perf.uploads.pixels += width * height;
  const s = `${width}x${height}`;
  if (perf.uploads.sizes.length < 8 && !perf.uploads.sizes.includes(s)) perf.uploads.sizes.push(s);
}

/** Frames already decoded once: how often the same frame had to be decoded again. Bounded. */
const decodedOnce = new Set<string>();
export function noteDecoded(key: string): void {
  if (decodedOnce.has(key)) perf.decode.repeats++;
  else {
    if (decodedOnce.size > 50_000) decodedOnce.clear();
    decodedOnce.add(key);
  }
}
export function forgetDecoded(): void {
  decodedOnce.clear();
}

/* ------------------------------------------------------------------------------------------------ */

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Nearest-rank percentile, p in 0..100. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** One presented frame, as the player measured it. */
export interface FrameSample {
  /** performance.now() when it was shown. */
  at: number;
  /** Time the graph took to evaluate (ms); 0 for a frame served from the saved frames. */
  evalMs: number;
  /** Time spent waiting for video frames inside that evaluation (ms). */
  decodeMs: number;
  /** Time spent putting the picture on the screen (ms). */
  drawMs: number;
  /** Time spent waiting for the graphics card to finish (ms), 0 when not waited for. */
  gpuWaitMs: number;
  /** Per-node CPU time of that evaluation, by node id. Only nodes that actually ran are in it. */
  nodes?: ReadonlyMap<string, number>;
  /** Served from the saved frames (no effects ran). */
  cached: boolean;
}

export interface SlowNode {
  id: string;
  ms: number;
}

export interface PerfWindow {
  frames: number;
  shownPerSecond: number;
  evalAvg: number;
  evalP95: number;
  decodeAvg: number;
  drawAvg: number;
  gpuWaitAvg: number;
  cachedShare: number;
  /** Average per-node time over the frames that evaluated the graph (a node that did not run counts as 0 in its frame). */
  slowest: SlowNode[];
  nodeAvg: SlowNode[];
}

/** Keeps the last `windowMs` of frame samples and summarises them. */
export class PerfAggregator {
  private samples: FrameSample[] = [];
  skipped = 0;

  constructor(private windowMs = 2000) {}

  add(s: FrameSample): void {
    this.samples.push(s);
    const cut = s.at - this.windowMs * 2;
    let i = 0;
    while (i < this.samples.length && this.samples[i].at < cut) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  clear(): void {
    this.samples = [];
    this.skipped = 0;
  }

  summary(now: number, top = 3): PerfWindow {
    const from = now - this.windowMs;
    const w = this.samples.filter((s) => s.at >= from);
    const evaluated = w.filter((s) => !s.cached);
    const sums = new Map<string, number>();
    for (const s of evaluated) if (s.nodes) for (const [id, ms] of s.nodes) sums.set(id, (sums.get(id) ?? 0) + ms);
    const nodeAvg = [...sums].map(([id, t]) => ({ id, ms: t / Math.max(1, evaluated.length) })).sort((a, b) => b.ms - a.ms);
    return {
      frames: w.length,
      shownPerSecond: w.length === 0 ? 0 : (w.length * 1000) / this.windowMs,
      evalAvg: average(evaluated.map((s) => s.evalMs)),
      evalP95: percentile(evaluated.map((s) => s.evalMs), 95),
      decodeAvg: average(evaluated.map((s) => s.decodeMs)),
      drawAvg: average(w.map((s) => s.drawMs)),
      gpuWaitAvg: average(evaluated.map((s) => s.gpuWaitMs)),
      cachedShare: w.length === 0 ? 0 : (w.length - evaluated.length) / w.length,
      slowest: nodeAvg.slice(0, top),
      nodeAvg,
    };
  }
}

/** The slowest nodes of one evaluation, by time. */
export function slowestNodes(timings: ReadonlyMap<string, number>, top = 3): SlowNode[] {
  return [...timings].map(([id, ms]) => ({ id, ms })).sort((a, b) => b.ms - a.ms).slice(0, top);
}

/* ------------------------------------------------------------------------------------------------ */

export interface DecodeStats {
  requests: number;
  sequential: number;
  seeks: number;
  browser: number;
}

/** In plain words: how the video frames are being read. */
export function decodeModeText(d: DecodeStats): string {
  if (d.requests + d.browser === 0) return 'no video frames needed';
  if (d.browser > 0 && d.browser >= d.sequential + d.seeks) return 'the browser video player (the fast decoder cannot read this file)';
  const total = d.sequential + d.seeks;
  if (total === 0) return 'no video frames needed';
  return d.seeks * 4 <= total ? 'sequential (fast)' : 'seeking (slow: a jump in the file for most frames)';
}

export interface PerfSnapshot {
  playing: boolean;
  /** Project frame rate. */
  projectFps: number;
  window: PerfWindow;
  skipped: number;
  /** Size actually rendered, and the full size, in pixels. */
  rendered: { width: number; height: number } | null;
  full: { width: number; height: number } | null;
  /** Share of full size (1 = full). */
  scale: number;
  cachedFrames: number;
  totalFrames: number;
  decode: DecodeStats & { repeats: number; ahead: number; waitMs: number };
  uploads: { count: number; pixels: number; sizes: string[] };
  /** Saving frames for the next loop: how many were saved and the time per saved frame (ms). */
  saving: { saved: number; msEach: number };
  gpuName: string;
  deviceMemoryGB: number | null;
  /** Whether the graphics card's own timer was available and used (it is not at present). */
  gpuTimeMeasured: boolean;
}

export function scaleWords(scale: number): string {
  if (scale >= 0.995) return 'full size';
  const known: [number, string][] = [[0.75, 'three quarters size'], [0.5, 'half size'], [0.35, 'about a third size'], [0.25, 'quarter size']];
  for (const [v, w] of known) if (Math.abs(scale - v) < 0.02) return w;
  return `${Math.round(scale * 100)}% size`;
}

const f0 = (n: number) => String(Math.round(n));
const f1 = (n: number) => n.toFixed(1);

export interface NameOf {
  (id: string): string;
}

/** The lines of the panel, in plain words. `nameOf` turns a node id into the name the user sees. */
export function panelLines(s: PerfSnapshot, nameOf: NameOf): string[] {
  const w = s.window;
  const out: string[] = [];
  out.push(s.playing ? `Showing ${f1(w.shownPerSecond)} frames per second (project: ${f0(s.projectFps)})` : 'Paused: press play to measure');
  out.push(`Waiting for video frames: ${f1(w.decodeAvg)} ms`);
  out.push(`Effects: ${f1(w.evalAvg)} ms (slowest 1 in 20: ${f1(w.evalP95)} ms)`);
  if (w.slowest.length) out.push(`Slowest: ${w.slowest.map((n) => `${nameOf(n.id)} ${f1(n.ms)} ms`).join(', ')}`);
  out.push(`Drawing: ${f1(w.drawAvg)} ms`);
  if (w.gpuWaitAvg > 0) out.push(`Waiting for the graphics card: ${f1(w.gpuWaitAvg)} ms`);
  if (s.rendered) out.push(`Rendering at ${s.rendered.width} x ${s.rendered.height}, ${scaleWords(s.scale)}`);
  out.push(`Saved frames: ${s.cachedFrames} of ${s.totalFrames} ready`);
  out.push(`Frames skipped: ${s.skipped}`);
  out.push(`Video: ${decodeModeText(s.decode)}`);
  out.push(`Graphics card: ${s.gpuName || 'not reported'}${s.deviceMemoryGB ? `, memory ${s.deviceMemoryGB} GB or more` : ''}`);
  return out;
}

export const ESTIMATE_NOTE =
  'Times are measured on the page (CPU side). The graphics card works in the background, so a node time is an estimate of its cost, not its exact GPU time. GPU time is not measured.';

export interface ReportInput {
  snapshot: PerfSnapshot;
  nameOf: NameOf;
  /** Node types in graph order. Types only: never file names, node names or media names. */
  nodeTypes: string[];
  userAgent: string;
  appVersion: string;
}

/** A short block of text for the owner to paste into a message. */
export function buildReport(r: ReportInput): string {
  const s = r.snapshot;
  const w = s.window;
  const lines: string[] = [];
  lines.push(`RSMPS performance report (app ${r.appVersion})`);
  lines.push(`Browser: ${r.userAgent}`);
  lines.push(`Graphics card: ${s.gpuName || 'not reported'}; device memory: ${s.deviceMemoryGB ? `${s.deviceMemoryGB} GB or more` : 'not reported'}`);
  lines.push('');
  lines.push(`Playing: ${s.playing ? 'yes' : 'no (paused, numbers are from the last playback)'}`);
  lines.push(`Frames shown per second: ${f1(w.shownPerSecond)} of ${f0(s.projectFps)} wanted; skipped: ${s.skipped}`);
  if (s.rendered && s.full) lines.push(`Rendering at ${s.rendered.width} x ${s.rendered.height} (${scaleWords(s.scale)}); full size is ${s.full.width} x ${s.full.height}`);
  lines.push(`Saved frames: ${s.cachedFrames} of ${s.totalFrames}; frames shown straight from them: ${f0(w.cachedShare * 100)}%`);
  lines.push('');
  lines.push(`Waiting for video frames: ${f1(w.decodeAvg)} ms per frame`);
  lines.push(`Effects (whole graph): ${f1(w.evalAvg)} ms average, ${f1(w.evalP95)} ms slowest 1 in 20`);
  lines.push(`Drawing: ${f1(w.drawAvg)} ms`);
  lines.push(`Waiting for the graphics card: ${f1(w.gpuWaitAvg)} ms`);
  lines.push(`Saving frames for the next loop: ${s.saving.saved} saved, ${f1(s.saving.msEach)} ms each`);
  lines.push(`Video decoding: ${decodeModeText(s.decode)}; ${s.decode.sequential} in order, ${s.decode.seeks} jumps, ${s.decode.browser} by the browser player, ${s.decode.ahead} decoded ahead, ${s.decode.repeats} decoded twice`);
  lines.push(`Pictures sent to the graphics card: ${s.uploads.count}${s.uploads.sizes.length ? ` (sizes ${s.uploads.sizes.join(', ')})` : ''}`);
  lines.push('');
  lines.push('Time per node (ms per evaluated frame):');
  if (w.nodeAvg.length === 0) lines.push('  none measured yet');
  for (const n of w.nodeAvg.slice(0, 12)) lines.push(`  ${r.nameOf(n.id)}: ${f1(n.ms)}`);
  lines.push('');
  lines.push(`Graph, in order (node types): ${r.nodeTypes.join(' > ') || 'empty'}`);
  lines.push('');
  lines.push(`Note: ${ESTIMATE_NOTE}`);
  return lines.join('\n');
}
