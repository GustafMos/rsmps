/**
 * Client for the services the packaged desktop app provides on its own origin (`app://rsmps/__rsmps/…`): the on-demand phone
 * link server, the official add-ons manager and FFmpeg export. No preload, no IPC: plain fetch. In the web version none of this
 * exists and nothing here ever calls fetch (`isDesktop()` guards every entry point; `DesktopClient` throws when used there).
 *
 * The parsing helpers are pure so they can be tested without a network.
 */

export const DESKTOP_BASE = 'app://rsmps/__rsmps/';

/** True in the packaged app (the page is served from the `app:` scheme). */
export function isDesktop(loc: { protocol: string } | undefined = typeof location === 'undefined' ? undefined : location): boolean {
  return loc?.protocol === 'app:';
}

/** `base` + `path` with no doubled or missing slash. */
export function desktopUrl(path: string, base: string = DESKTOP_BASE): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/* ------------------------------------------------ types ------------------------------------------------ */

export type PhoneServerState = 'off' | 'starting' | 'on' | 'error';

export interface LanCandidate {
  address: string;
  adapter?: string;
  kind: 'lan' | 'tailscale' | 'other';
  label: string;
  url: string;
}

export interface LanInfo {
  lan: boolean;
  desktop: boolean;
  state: PhoneServerState;
  error?: string;
  origins: string[];
  candidates: LanCandidate[];
  /** `wss://127.0.0.1:<port>`; empty when the desktop has no phone service at all. */
  ws: string;
  port?: number;
  declined?: boolean;
}

export type AddonState = 'not-installed' | 'installing' | 'installed' | 'error';

export interface AddonDownload {
  version: string;
  size: number;
  sizeLabel: string;
  host: string;
  license: { name: string; url: string };
  source: { name: string; url: string };
  sha256: string;
  hashVerifiedByMaintainer: boolean;
}

export interface AddonInfo {
  id: string;
  name: string;
  title: string;
  description: string;
  homepage: string;
  state: AddonState;
  download: AddonDownload | null;
  /** Text for platforms with no download (install it yourself, then locate it). */
  bringYourOwn: string;
  canLocate: boolean;
  /** A warning shown on the card (large third-party program, not code-signed...). */
  notice?: string;
  /** Add-ons that belong together (COLMAP and Brush: 'splat-train'). */
  group?: string;
  installed: { source: 'download' | 'custom' | 'system'; version: string; path: string } | null;
  progress?: { phase: 'downloading' | 'verifying' | 'extracting'; received: number; total: number };
  error?: string;
}

/** What an add-on POST answers: the entry plus the flags the endpoints add. */
export interface AddonReply {
  info: AddonInfo;
  declined?: boolean;
  canceled?: boolean;
}

export interface ExportCodecInfo {
  id: string;
  label: string;
  ext: string;
  alpha: boolean;
  even: boolean;
  audio: boolean;
}

export interface FfmpegExportInfo {
  available: boolean;
  source: string | null;
  version: string | null;
  codecs: ExportCodecInfo[];
  active: boolean;
}

export interface ExportStartRequest {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateMbps?: number;
  audio?: { sampleRate: number; channels: number };
  name?: string;
}

export interface ExportStartReply {
  id: string;
  ext: string;
  alpha: boolean;
  even: boolean;
  frameBytes: number;
}

export interface ExportFinishReply {
  saved: boolean;
  canceled?: boolean;
  path?: string;
  bytes?: number;
  frames?: number;
}

/** The FFmpeg export half of the client: what the exporter needs (and what tests fake). */
export interface FfmpegExportClient {
  info(): Promise<FfmpegExportInfo>;
  start(req: ExportStartRequest, signal?: AbortSignal): Promise<ExportStartReply>;
  audio(id: string, pcm: ArrayBufferView, signal?: AbortSignal): Promise<void>;
  frame(id: string, rgba: ArrayBufferView, signal?: AbortSignal): Promise<number>;
  finish(id: string, signal?: AbortSignal): Promise<ExportFinishReply>;
  /** Never throws. */
  cancel(id: string): Promise<void>;
}

/* ---------------------------------------------- parsing ---------------------------------------------- */

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The message of an `{error}` body, else a generic one with the status. */
export function errorText(body: unknown, status: number, fallback = 'The desktop app could not do that.'): string {
  const e = obj(body).error;
  if (typeof e === 'string' && e.trim()) return e.trim();
  return `${fallback} (status ${status})`;
}

export function parseLanInfo(raw: unknown): LanInfo {
  const o = obj(raw);
  const state = (['off', 'starting', 'on', 'error'] as const).find((s) => s === o.state) ?? 'off';
  const kinds = ['lan', 'tailscale', 'other'] as const;
  const candidates: LanCandidate[] = (Array.isArray(o.candidates) ? o.candidates : [])
    .map(obj)
    .filter((c) => typeof c.url === 'string' && typeof c.address === 'string')
    .map((c) => ({ address: str(c.address), adapter: typeof c.adapter === 'string' ? c.adapter : undefined, kind: kinds.find((k) => k === c.kind) ?? 'other', label: str(c.label, str(c.address)), url: str(c.url) }));
  return {
    lan: o.lan === true && state === 'on',
    desktop: o.desktop === true,
    state,
    ...(typeof o.error === 'string' && o.error ? { error: o.error } : {}),
    origins: (Array.isArray(o.origins) ? o.origins : []).filter((x): x is string => typeof x === 'string'),
    candidates,
    ws: str(o.ws),
    ...(typeof o.port === 'number' ? { port: o.port } : {}),
    ...(o.declined === true ? { declined: true } : {}),
  };
}

/** `${ws}/__rsmps/phone-ws?role=desktop&token=…` for the desktop side of a pairing. */
export function phoneSocketUrl(ws: string, token: string): string {
  return `${ws.replace(/\/+$/, '')}/__rsmps/phone-ws?role=desktop&token=${encodeURIComponent(token)}`;
}

export function parseAddon(raw: unknown): AddonInfo {
  const o = obj(raw);
  const state = (['not-installed', 'installing', 'installed', 'error'] as const).find((s) => s === o.state) ?? 'not-installed';
  const d = o.download ? obj(o.download) : null;
  const inst = o.installed ? obj(o.installed) : null;
  const prog = o.progress ? obj(o.progress) : null;
  const phases = ['downloading', 'verifying', 'extracting'] as const;
  const bring = o.bringYourOwn;
  return {
    id: str(o.id),
    name: str(o.name, str(o.id)),
    title: str(o.title, str(o.name)),
    description: str(o.description),
    homepage: str(o.homepage),
    state,
    download: d
      ? {
          version: str(d.version),
          size: num(d.size),
          sizeLabel: str(d.sizeLabel),
          host: str(d.host),
          license: { name: str(obj(d.license).name), url: str(obj(d.license).url) },
          source: { name: str(obj(d.source).name), url: str(obj(d.source).url) },
          sha256: str(d.sha256),
          hashVerifiedByMaintainer: d.hashVerifiedByMaintainer === true,
        }
      : null,
    bringYourOwn: typeof bring === 'string' ? bring : '',
    canLocate: o.canLocate === true,
    ...(typeof o.notice === 'string' && o.notice ? { notice: o.notice } : {}),
    ...(typeof o.group === 'string' && o.group ? { group: o.group } : {}),
    installed: inst ? { source: (['download', 'custom', 'system'] as const).find((s) => s === inst.source) ?? 'custom', version: str(inst.version), path: str(inst.path) } : null,
    ...(prog ? { progress: { phase: phases.find((p) => p === prog.phase) ?? 'downloading', received: num(prog.received), total: num(prog.total) } } : {}),
    ...(typeof o.error === 'string' && o.error ? { error: o.error } : {}),
  };
}

export function parseAddonList(raw: unknown): AddonInfo[] {
  const list = obj(raw).addons;
  return Array.isArray(list) ? list.map(parseAddon).filter((a) => a.id) : [];
}

export function parseAddonReply(raw: unknown): AddonReply {
  const o = obj(raw);
  return { info: parseAddon(raw), ...(o.declined === true ? { declined: true } : {}), ...(o.canceled === true ? { canceled: true } : {}) };
}

export function parseExportInfo(raw: unknown): FfmpegExportInfo {
  const o = obj(raw);
  return {
    available: o.available === true,
    source: typeof o.source === 'string' ? o.source : null,
    version: typeof o.version === 'string' ? o.version : null,
    codecs: (Array.isArray(o.codecs) ? o.codecs : []).map(obj).filter((c) => typeof c.id === 'string').map((c) => ({ id: str(c.id), label: str(c.label), ext: str(c.ext), alpha: c.alpha === true, even: c.even === true, audio: c.audio !== false })),
    active: o.active === true,
  };
}

export function parseExportStart(raw: unknown): ExportStartReply {
  const o = obj(raw);
  if (typeof o.id !== 'string' || !o.id) throw new Error('The desktop app did not start the export.');
  return { id: o.id, ext: str(o.ext), alpha: o.alpha === true, even: o.even === true, frameBytes: num(o.frameBytes) };
}

export function parseExportFinish(raw: unknown): ExportFinishReply {
  const o = obj(raw);
  const saved = o.saved === true;
  return { saved, ...(o.canceled === true ? { canceled: true } : {}), ...(typeof o.path === 'string' ? { path: o.path } : {}), ...(typeof o.bytes === 'number' ? { bytes: o.bytes } : {}), ...(typeof o.frames === 'number' ? { frames: o.frames } : {}) };
}

/** Last part of a path of either flavour (for the file name shown after a native save). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/* ----------------------------------------------- client ---------------------------------------------- */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** All endpoints, over an injectable `fetch` (tests pass a fake). */
export class DesktopClient implements FfmpegExportClient {
  constructor(
    private fetchFn: FetchLike = (u, i) => fetch(u, i),
    private base: string = DESKTOP_BASE,
    private enabled: () => boolean = () => isDesktop(),
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    if (!this.enabled()) throw new Error('This is only available in the desktop app.');
    const res = await this.fetchFn(desktopUrl(path, this.base), { cache: 'no-store', ...init });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: body ?? {} };
  }

  private async ok(path: string, init?: RequestInit, fallback?: string): Promise<unknown> {
    const r = await this.call(path, init);
    if (r.status < 200 || r.status >= 300) throw new Error(errorText(r.body, r.status, fallback));
    return r.body;
  }

  /* phone link */
  async lanInfo(): Promise<LanInfo> {
    return parseLanInfo(await this.ok('lan-info'));
  }
  async lanStart(): Promise<LanInfo> {
    return parseLanInfo(await this.ok('lan-start', { method: 'POST' }));
  }
  async lanStop(): Promise<LanInfo> {
    return parseLanInfo(await this.ok('lan-stop', { method: 'POST' }));
  }

  /* add-ons */
  async addons(): Promise<AddonInfo[]> {
    return parseAddonList(await this.ok('addons'));
  }
  async addon(id: string): Promise<AddonInfo> {
    return parseAddon(await this.ok(`addons/${encodeURIComponent(id)}`));
  }
  /** install / cancel / remove / locate. A 400 from `locate` or `install` carries `{error}`: thrown as an Error with that text. */
  async addonAction(id: string, action: 'install' | 'cancel' | 'remove' | 'locate'): Promise<AddonReply> {
    return parseAddonReply(await this.ok(`addons/${encodeURIComponent(id)}/${action}`, { method: 'POST' }, 'The add-on request failed.'));
  }

  /* FFmpeg export */
  async info(): Promise<FfmpegExportInfo> {
    return parseExportInfo(await this.ok('export/ffmpeg'));
  }
  async start(req: ExportStartRequest, signal?: AbortSignal): Promise<ExportStartReply> {
    return parseExportStart(await this.ok('export/ffmpeg/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal }, 'FFmpeg could not start the export.'));
  }
  async audio(id: string, pcm: ArrayBufferView, signal?: AbortSignal): Promise<void> {
    await this.ok(`export/ffmpeg/${encodeURIComponent(id)}/audio`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm as BodyInit, signal }, 'FFmpeg did not accept the audio.');
  }
  async frame(id: string, rgba: ArrayBufferView, signal?: AbortSignal): Promise<number> {
    const body = await this.ok(`export/ffmpeg/${encodeURIComponent(id)}/frame`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: rgba as BodyInit, signal }, 'FFmpeg did not accept a frame.');
    return num(obj(body).frames);
  }
  async finish(id: string, signal?: AbortSignal): Promise<ExportFinishReply> {
    return parseExportFinish(await this.ok(`export/ffmpeg/${encodeURIComponent(id)}/finish`, { method: 'POST', signal }, 'FFmpeg could not finish the file.'));
  }
  async cancel(id: string): Promise<void> {
    try {
      await this.call(`export/ffmpeg/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch {
      /* the export is gone either way */
    }
  }
}
