/**
 * Renderer side of "Splat from Video": implements the engine's `Host.splatTrain` over the desktop app's `/__rsmps/splat-train` endpoints
 * (desktop/addons/splat-train.mjs). Frames are encoded to JPEG here (quality 0.92), sent one by one, the job is polled once a second,
 * and the results are read back. In the web version there is no client (`createSplatTrainHost` returns null), so the node says
 * "desktop app only" and nothing is ever fetched.
 */
import type { SplatTrainHost, SplatTrainOutput, SplatTrainRequest } from '../engine/types';
import { DESKTOP_BASE, desktopUrl, errorText, isDesktop, type FetchLike } from './desktop';

export const POLL_MS = 1000;

export interface SplatJobView {
  id: string;
  state: 'receiving' | 'running' | 'done' | 'failed' | 'cancelled';
  step: string;
  stepLabel: string;
  progress: number;
  note: string;
  error?: string;
  warnings: string[];
  report?: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parseJobView(raw: unknown): SplatJobView {
  const o = obj(raw);
  const states = ['receiving', 'running', 'done', 'failed', 'cancelled'] as const;
  return {
    id: typeof o.id === 'string' ? o.id : '',
    state: states.find((s) => s === o.state) ?? 'failed',
    step: typeof o.step === 'string' ? o.step : '',
    stepLabel: typeof o.stepLabel === 'string' ? o.stepLabel : '',
    progress: typeof o.progress === 'number' && Number.isFinite(o.progress) ? Math.min(1, Math.max(0, o.progress)) : 0,
    note: typeof o.note === 'string' ? o.note : '',
    ...(typeof o.error === 'string' && o.error ? { error: o.error } : {}),
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === 'string') : [],
    ...(o.report && typeof o.report === 'object' ? { report: o.report as Record<string, unknown> } : {}),
  };
}

/** Encode straight RGBA as JPEG (browser: OffscreenCanvas). Injectable for tests. */
export type JpegEncoder = (pixels: Uint8ClampedArray, width: number, height: number) => Promise<Uint8Array>;

export const canvasJpeg: JpegEncoder = async (pixels, width, height) => {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas to encode frames with.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(ok, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true });
  });

export class SplatTrainClient implements SplatTrainHost {
  constructor(
    private fetchFn: FetchLike = (u, i) => fetch(u, i),
    private base: string = DESKTOP_BASE,
    private encode: JpegEncoder = canvasJpeg,
    private poll: number = POLL_MS,
  ) {}

  private async call(path: string, init: RequestInit = {}, fallback = 'The desktop app could not do that.'): Promise<unknown> {
    const res = await this.fetchFn(desktopUrl(`splat-train${path}`, this.base), { cache: 'no-store', ...init });
    let body: unknown = null;
    const raw = res.headers?.get?.('content-type') ?? '';
    if (raw.includes('json') || !raw) body = await res.json().catch(() => null);
    if (res.status < 200 || res.status >= 300) throw new Error(errorText(body, res.status, fallback));
    return body;
  }

  private async bytes(path: string): Promise<ArrayBuffer> {
    const res = await this.fetchFn(desktopUrl(`splat-train${path}`, this.base), { cache: 'no-store' });
    if (!res.ok) throw new Error(errorText(await res.json().catch(() => null), res.status, 'The result could not be read.'));
    return res.arrayBuffer();
  }

  async status(): Promise<{ available: boolean; missing: string[] }> {
    const o = obj(await this.call(''));
    return { available: o.available === true, missing: Array.isArray(o.missing) ? o.missing.filter((m): m is string => typeof m === 'string') : [] };
  }

  async train(req: SplatTrainRequest): Promise<SplatTrainOutput> {
    const { signal } = req;
    const start = parseJobView(await this.call('/start', { method: 'POST' }, 'The reconstruction could not start.'));
    const id = encodeURIComponent(start.id);
    try {
      let size = '';
      let same = true;
      const sizes: { width: number; height: number }[] = [];
      for (let i = 0; i < req.frameCount; i++) {
        if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
        const f = await req.frame(i);
        same &&= !size || size === `${f.width}x${f.height}`;
        size = `${f.width}x${f.height}`;
        sizes.push({ width: f.width, height: f.height });
        const jpeg = await this.encode(f.pixels, f.width, f.height);
        await this.call(`/${id}/frame?name=${encodeURIComponent(`frame_${String(i).padStart(4, '0')}.jpg`)}`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg as BodyInit }, 'The desktop app did not accept a frame.');
        req.onProgress((0.08 * (i + 1)) / req.frameCount, `Sending frames: ${i + 1} of ${req.frameCount}`);
      }
      await this.call(`/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req.settings, singleCamera: same, ...(req.settings.input === 'scan' && req.known ? { known: req.known(sizes) } : {}) }) }, 'The reconstruction could not start.');
      let v: SplatJobView;
      for (;;) {
        await sleep(this.poll, signal);
        if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
        v = parseJobView(await this.call(`/${id}`));
        req.onProgress(0.08 + 0.92 * v.progress, v.note || v.stepLabel);
        if (v.state === 'done') break;
        if (v.state === 'failed' || v.state === 'cancelled') throw new Error(v.error || 'The reconstruction stopped.');
      }
      const [ply, model, report] = [await this.bytes(`/${id}/result/ply`), obj(await this.call(`/${id}/result/model`)), obj(await this.call(`/${id}/result/report`))];
      return { ply, model: model as unknown as SplatTrainOutput['model'], report: { ...report, warnings: v.warnings } };
    } finally {
      if (signal.aborted) await this.call(`/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
      await this.call(`/${id}/dispose`, { method: 'POST' }).catch(() => undefined);
    }
  }
}

/** The client in the desktop app, null everywhere else. */
export function createSplatTrainHost(): SplatTrainHost | null {
  return isDesktop() ? new SplatTrainClient() : null;
}
