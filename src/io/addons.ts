/**
 * Official add-ons manager client. Desktop app: talks to `app://rsmps/__rsmps/addons`. Web version: `supported` is false and
 * nothing is fetched. Polls an add-on while it installs so the UI can show progress.
 */
import type { AddonActionResult, AddonsApi } from './api';
import type { AddonInfo, DesktopClient } from './desktop';
import { setVideoAvailability } from '../engine/lib/video-presets';

export const POLL_MS = 500;

type Client = Pick<DesktopClient, 'addons' | 'addon' | 'addonAction'>;

export class AddonsImpl implements AddonsApi {
  private cache: AddonInfo[] = [];
  private listeners = new Set<(list: AddonInfo[]) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private client: Client | null,
    private poll: number = POLL_MS,
  ) {}

  get supported(): boolean {
    return this.client !== null;
  }

  async list(): Promise<AddonInfo[]> {
    if (!this.client) return [];
    try {
      this.set(await this.client.addons());
    } catch {
      /* keep what we have */
    }
    this.cache.filter((a) => a.state === 'installing').forEach((a) => this.watch(a.id));
    return this.cache;
  }

  install(id: string) {
    return this.act(id, 'install');
  }
  cancel(id: string) {
    return this.act(id, 'cancel');
  }
  remove(id: string) {
    return this.act(id, 'remove');
  }
  locate(id: string) {
    return this.act(id, 'locate');
  }

  onChange(listener: (list: AddonInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  private async act(id: string, action: 'install' | 'cancel' | 'remove' | 'locate'): Promise<AddonActionResult> {
    if (!this.client) return { ok: false, error: 'Add-ons are available in the desktop app.' };
    try {
      const r = await this.client.addonAction(id, action);
      this.merge(r.info);
      if (r.info.state === 'installing') this.watch(id);
      return { ok: !r.declined && !r.canceled, info: r.info, ...(r.declined ? { declined: true } : {}), ...(r.canceled ? { canceled: true } : {}) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // The add-on's own entry may carry the reason too; refresh it so the card shows the current state.
      void this.refresh(id);
      return { ok: false, error };
    }
  }

  private async refresh(id: string): Promise<AddonInfo | null> {
    if (!this.client) return null;
    try {
      const info = await this.client.addon(id);
      this.merge(info);
      return info;
    } catch {
      return null;
    }
  }

  /** Poll one add-on until it stops installing. */
  private watch(id: string): void {
    if (this.timers.has(id) || !this.client) return;
    const tick = async () => {
      this.timers.delete(id);
      const info = await this.refresh(id);
      if (info?.state === 'installing') this.timers.set(id, setTimeout(tick, this.poll));
    };
    this.timers.set(id, setTimeout(tick, this.poll));
  }

  private merge(info: AddonInfo): void {
    const i = this.cache.findIndex((a) => a.id === info.id);
    this.set(i < 0 ? [...this.cache, info] : this.cache.map((a, k) => (k === i ? info : a)));
  }

  private set(list: AddonInfo[]): void {
    this.cache = list;
    const ff = list.find((a) => a.id === 'ffmpeg' && a.state === 'installed');
    setVideoAvailability({ ffmpeg: !!ff, encoders: ff?.encoders ? new Set(ff.encoders) : null });
    for (const l of [...this.listeners]) l(list);
  }
}
