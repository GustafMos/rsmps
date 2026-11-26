/** Test kit: a fake browser camera API with controllable tracks, videos, visibility and "two cameras at once" rules. Used by the camera tests only. */
import { vi } from 'vitest';

export class FakeVideo {
  static created = 0;
  /** While true no video shows a new picture (the playhead stands still). */
  static freezeAll = false;
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
  readyState = 2;
  videoWidth = 640;
  videoHeight = 480;
  get currentTime(): number {
    return FakeVideo.freezeAll ? 0 : performance.now() / 1000;
  }
  set currentTime(_v: number) {}
  plays = 0;
  onpause: (() => void) | null = null;
  onstalled: (() => void) | null = null;
  onsuspend: (() => void) | null = null;
  onemptied: (() => void) | null = null;
  constructor() {
    FakeVideo.created++;
  }
  play() {
    this.plays++;
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
  load() {}
}

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  stopped = false;
  applied: MediaTrackConstraints[] = [];
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  constructor(
    public caps: Record<string, unknown>,
    public settings: Record<string, unknown>,
    public label = '',
  ) {}
  getCapabilities() {
    return this.caps;
  }
  getSettings() {
    return this.settings;
  }
  async applyConstraints(c: MediaTrackConstraints) {
    this.applied.push(c);
    const w = (c.width as { ideal?: number } | undefined)?.ideal;
    const h = (c.height as { ideal?: number } | undefined)?.ideal;
    if (w) this.settings.width = w;
    if (h) this.settings.height = h;
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

export interface FakeDevice {
  id: string;
  label: string;
  facing: 'user' | 'environment';
}

export const PHONE: FakeDevice[] = [
  { id: 'back0', label: 'camera2 0, facing back', facing: 'environment' },
  { id: 'back1', label: 'camera2 2, facing back', facing: 'environment' },
  { id: 'front0', label: 'camera2 1, facing front', facing: 'user' },
];

/** free: any number of cameras. pair720: a second camera works only while every open camera is 1280 wide or less. never: one camera at a time. */
export type Rule = 'free' | 'pair720' | 'never';

export interface Kit {
  tracks: FakeTrack[];
  gum: MediaStreamConstraints[];
  rule: Rule;
  /** When set, every getUserMedia fails with this error name. */
  failWith: string | null;
  visibility: 'visible' | 'hidden';
  fire(type: string): void;
  live(): FakeTrack[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : (v as { ideal?: number; exact?: number } | undefined)?.ideal ?? (v as { exact?: number } | undefined)?.exact);

export function installCameras(rule: Rule, devices: FakeDevice[] = PHONE, caps: Record<string, unknown> = { zoom: { min: 0.6, max: 10, step: 0.1 } }): Kit {
  const handlers = new Map<string, (() => void)[]>();
  const kit: Kit = {
    tracks: [],
    gum: [],
    rule,
    failWith: null,
    visibility: 'visible',
    fire: (type) => (handlers.get(type) ?? []).forEach((h) => h()),
    live: () => kit.tracks.filter((t) => !t.stopped),
  };
  const doc = {
    createElement: () => new FakeVideo(),
    get visibilityState() {
      return kit.visibility;
    },
    get hidden() {
      return kit.visibility === 'hidden';
    },
    addEventListener: (type: string, fn: () => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: () => void) => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== fn)),
  };
  vi.stubGlobal('HTMLVideoElement', FakeVideo);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      async enumerateDevices() {
        return devices.map((d) => ({ kind: 'videoinput', deviceId: d.id, label: d.label }));
      },
      async getUserMedia(c: MediaStreamConstraints) {
        kit.gum.push(c);
        const fail = (name: string) => Promise.reject(Object.assign(new Error(name), { name }));
        if (kit.failWith) return fail(kit.failWith);
        const v = (typeof c.video === 'object' ? c.video : {}) as MediaTrackConstraints;
        const exact = (v.deviceId as { exact?: string } | undefined)?.exact;
        const fm = typeof v.facingMode === 'string' ? v.facingMode : (v.facingMode as { exact?: string } | undefined)?.exact;
        const dev = (exact ? devices.find((d) => d.id === exact) : fm ? devices.find((d) => d.facing === fm) : undefined) ?? (exact || fm ? undefined : devices[0]);
        if (!dev) return fail('OverconstrainedError');
        const width = num(v.width) ?? 1920;
        const height = num(v.height) ?? Math.round((width * 9) / 16);
        const live = kit.live();
        if (live.length && kit.rule === 'never') return fail('NotReadableError');
        if (live.length && kit.rule === 'pair720' && (width > 1280 || live.some((t) => Number(t.settings.width) > 1280))) return fail('NotReadableError');
        const t = new FakeTrack(caps, { width, height, frameRate: 30, deviceId: dev.id, facingMode: dev.facing }, dev.label);
        kit.tracks.push(t);
        return { getTracks: () => [t], getVideoTracks: () => [t] } as unknown as MediaStream;
      },
    },
  });
  return kit;
}

export function removeCameras(): void {
  vi.unstubAllGlobals();
}
