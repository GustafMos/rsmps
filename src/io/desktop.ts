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
  /** FFmpeg only: which optional encoders the installed build has (dxv, hap, prores_ks...). Absent = not asked / unknown. */
  encoders?: string[];
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
  /** Optional encoders the installed FFmpeg has; null = unknown (no FFmpeg, or it could not be asked). */
  encoders: string[] | null;
  active: boolean;
}

export interface ExportStartRequest {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateMbps?: number;
  /** Every frame a key frame (formats with a bitrate only). */
  allKeys?: boolean;
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

export interface FileSinkStart {
  /** File name without extension, offered in the Save dialog. */
  name: string;
  ext: string;
}

export interface FileSinkReply {
  /** False when the user closed the Save dialog. */
  saved: boolean;
  id?: string;
  path?: string;
}

/** The FFmpeg export half of the client: what the exporter needs (and what tests fake). */
export interface FfmpegExportClient {
  /**
   * Big outputs that the app writes itself (HAP...): ask where to save (native dialog), then write chunks at positions straight into that
   * file, so a multi-gigabyte export never sits in memory. Absent in fakes and in the web version.
   */
  fileStart?(req: FileSinkStart, signal?: AbortSignal): Promise<FileSinkReply>;
  /** `at` = byte position; chunks may be written in any order (the muxer patches its header at the end). */
  fileWrite?(id: string, at: number, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  fileFinish?(id: string): Promise<{ path: string; bytes: number }>;
  /** Never throws; deletes the partial file. */
  fileCancel?(id: string): Promise<void>;
  /** One picture through FFmpeg (DPX, JPEG 2000): straight RGBA in, the finished file out. */
  convertStill?(codec: string, rgba: ArrayBufferView, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Sound through FFmpeg (MP3, Opus, Vorbis, ALAC, AAC): interleaved f32 PCM in, the finished file out. */
  convertAudio?(codec: string, pcm: ArrayBufferView, sampleRate: number, channels: number, signal?: AbortSignal): Promise<Uint8Array>;
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
    ...(Array.isArray(o.encoders) ? { encoders: o.encoders.filter((x): x is string => typeof x === 'string') } : {}),
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
    encoders: Array.isArray(o.encoders) ? o.encoders.filter((x): x is string => typeof x === 'string') : null,
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

/* ---------------------------------------------- go live ----------------------------------------------- */

export interface LiveStartRequest {
  /** 'twitch' | 'youtube' | 'custom'. */
  service: string;
  /** The stream key (a known service), or the last part of a custom address. Never stored by the app unless the user asks. */
  key: string;
  /** Custom only: rtmp:// or rtmps:// address. */
  url?: string;
  width: number;
  height: number;
  fps: number;
  videoKbps: number;
  audioKbps?: number;
  /** The recording carries a sound track. */
  hasAudio: boolean;
}

/** One stream as the main process reports it (the stream key is never part of it). */
export interface LiveStatus {
  id: string;
  live: boolean;
  /** Seconds of stream FFmpeg has sent. */
  seconds: number;
  wallSeconds: number;
  fps: number;
  kbps: number;
  /** 1 = keeping up; below 1 the computer or the connection is too slow. */
  speed: number;
  error: string | null;
}

export interface LiveInfo {
  /** FFmpeg is installed. */
  available: boolean;
  services: { id: string; label: string }[];
  current: LiveStatus | null;
  /** The stream that ended last (with its error, if it failed). */
  last: LiveStatus | null;
}

function parseLiveStatus(v: unknown): LiveStatus | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return { id: str(o.id), live: o.live === true, seconds: num(o.seconds), wallSeconds: num(o.wallSeconds), fps: num(o.fps), kbps: num(o.kbps), speed: num(o.speed), error: typeof o.error === 'string' ? o.error : null };
}

export function parseLiveInfo(v: unknown): LiveInfo {
  const o = obj(v);
  const services = Array.isArray(o.services) ? o.services.map((s) => ({ id: str(obj(s).id), label: str(obj(s).label) })).filter((s) => s.id) : [];
  return { available: o.available === true, services, current: parseLiveStatus(o.current), last: parseLiveStatus(o.last) };
}

/** Last part of a path of either flavour (for the file name shown after a native save). */
/* ------------------------------------------- fast copy as HAP ------------------------------------------ */

/** The kinds of HAP the desktop app's FFmpeg writes: plain, better colour (larger), with transparency (larger). */
export type HapKind = 'hap' | 'hap_q' | 'hap_alpha';

export interface HapConvertInfo {
  /** FFmpeg is installed. */
  available: boolean;
  /** ...and it has the `hap` encoder (not every build does). */
  hap: boolean;
}

export interface HapConvertStart {
  format: HapKind;
  /** The clip as shown (after any rotation). */
  width: number;
  height: number;
  /** Longest side of the copy. */
  maxSide: number;
  /** Seconds, for the progress and the size estimate. */
  duration: number;
  fps: number;
  /** File extension of the clip, a hint for FFmpeg. */
  ext: string;
}

export interface HapConvertStatus {
  state: 'uploading' | 'running' | 'done' | 'error';
  /** 0..1 of the encoding. */
  fraction: number;
  /** Size of the finished file. */
  bytes: number;
  error: string | null;
}

export function parseHapConvertInfo(v: unknown): HapConvertInfo {
  const o = obj(v);
  return { available: o.available === true, hap: o.available === true && o.hap === true };
}

export function parseHapConvertStatus(v: unknown): HapConvertStatus {
  const o = obj(v);
  const state = o.state === 'uploading' || o.state === 'running' || o.state === 'done' ? o.state : 'error';
  return { state, fraction: Math.max(0, Math.min(1, num(o.fraction))), bytes: Math.max(0, num(o.bytes)), error: typeof o.error === 'string' ? o.error : state === 'error' ? 'The conversion failed.' : null };
}

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

  /* Go live (desktop/addons/live.mjs) */
  async liveInfo(): Promise<LiveInfo> {
    return parseLiveInfo(await this.ok('live'));
  }
  async liveStart(req: LiveStartRequest): Promise<{ id: string; encoder: string; secure: boolean }> {
    const o = obj(await this.ok('live/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, 'The stream could not start.'));
    return { id: str(o.id), encoder: str(o.encoder), secure: o.secure === true };
  }
  /** The next piece of the recording. Throws with the reason when the stream has ended. */
  async liveChunk(id: string, bytes: ArrayBuffer | ArrayBufferView): Promise<void> {
    await this.ok(`live/chunk?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes as BodyInit }, 'The stream has ended.');
  }
  async liveStop(id?: string): Promise<LiveInfo> {
    return parseLiveInfo(await this.ok(`live/stop${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST' }));
  }

  /* Fast copy as HAP (desktop/addons/hap-convert.mjs) */
  async hapInfo(): Promise<HapConvertInfo> {
    return parseHapConvertInfo(await this.ok('hap-convert'));
  }
  async hapStart(req: HapConvertStart, signal?: AbortSignal): Promise<{ id: string; width: number; height: number }> {
    const o = obj(await this.ok('hap-convert/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal }, 'The conversion could not start.'));
    if (!str(o.id)) throw new Error('The conversion could not start.');
    return { id: str(o.id), width: num(o.width), height: num(o.height) };
  }
  /** The next piece of the clip, in order. */
  async hapChunk(id: string, bytes: ArrayBuffer | ArrayBufferView, signal?: AbortSignal): Promise<void> {
    await this.ok(`hap-convert/${encodeURIComponent(id)}/chunk`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes as BodyInit, signal }, 'The clip could not be handed to FFmpeg.');
  }
  async hapRun(id: string, signal?: AbortSignal): Promise<HapConvertStatus> {
    return parseHapConvertStatus(await this.ok(`hap-convert/${encodeURIComponent(id)}/run`, { method: 'POST', signal }, 'The conversion could not start.'));
  }
  async hapStatus(id: string, signal?: AbortSignal): Promise<HapConvertStatus> {
    return parseHapConvertStatus(await this.ok(`hap-convert/${encodeURIComponent(id)}`, { signal }, 'The conversion was lost.'));
  }
  /** Bytes [at, at + length) of the finished file. */
  async hapRead(id: string, at: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.enabled()) throw new Error('This is only available in the desktop app.');
    const res = await this.fetchFn(desktopUrl(`hap-convert/${encodeURIComponent(id)}/result?at=${Math.max(0, Math.floor(at))}&length=${Math.max(1, Math.floor(length))}`, this.base), { cache: 'no-store', signal });
    if (!res.ok) {
      let msg: unknown = null;
      try {
        msg = await res.json();
      } catch {
        /* not JSON */
      }
      throw new Error(errorText(msg, res.status, 'The converted clip could not be read.'));
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  /** Stop a conversion, or tidy up after one: the work folder is deleted either way. */
  async hapCancel(id: string): Promise<void> {
    try {
      await this.call(`hap-convert/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch {
      /* gone either way */
    }
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

  /* files the app writes itself (native Save dialog, chunked writes) */
  async fileStart(req: FileSinkStart, signal?: AbortSignal): Promise<FileSinkReply> {
    const o = obj(await this.ok('export/file/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal }, 'The desktop app could not open the file.'));
    return { saved: o.saved === true, ...(typeof o.id === 'string' ? { id: o.id } : {}), ...(typeof o.path === 'string' ? { path: o.path } : {}) };
  }
  async fileWrite(id: string, at: number, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.ok(`export/file/${encodeURIComponent(id)}/write?at=${Math.max(0, Math.floor(at))}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data as BodyInit, signal }, 'The desktop app could not write the file.');
  }
  async fileFinish(id: string): Promise<{ path: string; bytes: number }> {
    const o = obj(await this.ok(`export/file/${encodeURIComponent(id)}/finish`, { method: 'POST' }, 'The desktop app could not finish the file.'));
    return { path: str(o.path), bytes: num(o.bytes) };
  }
  async fileCancel(id: string): Promise<void> {
    try {
      await this.call(`export/file/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch {
      /* gone either way */
    }
  }

  /* FFmpeg conversions that return the file */
  private async bytesFrom(path: string, body: ArrayBufferView, signal: AbortSignal | undefined, fallback: string): Promise<Uint8Array> {
    if (!this.enabled()) throw new Error('This is only available in the desktop app.');
    const res = await this.fetchFn(desktopUrl(path, this.base), { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/octet-stream' }, body: body as BodyInit, signal });
    if (!res.ok) {
      let msg: unknown = null;
      try {
        msg = await res.json();
      } catch {
        /* not JSON */
      }
      throw new Error(errorText(msg, res.status, fallback));
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  async convertStill(codec: string, rgba: ArrayBufferView, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.bytesFrom(`export/ffmpeg/still?codec=${encodeURIComponent(codec)}&width=${width}&height=${height}`, rgba, signal, 'FFmpeg could not write the picture.');
  }
  async convertAudio(codec: string, pcm: ArrayBufferView, sampleRate: number, channels: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.bytesFrom(`export/ffmpeg/sound?codec=${encodeURIComponent(codec)}&rate=${sampleRate}&channels=${channels}`, pcm, signal, 'FFmpeg could not write the sound.');
  }
}
