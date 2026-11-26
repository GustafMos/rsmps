/**
 * A short memory of what the cameras did (opens, closes, errors, who takes turns), kept only in this page's memory, so the owner can copy
 * it and send it when a camera misbehaves on a phone. No pictures and nothing personal: only camera labels and settings.
 */
export interface LogItem {
  at: number;
  text: string;
}

export const LOG_KEEP = 150;
export const LOG_SHOW = 60;

export class CameraLog {
  private items: LogItem[] = [];

  add(text: string): void {
    this.items.push({ at: performance.now(), text });
    if (this.items.length > LOG_KEEP) this.items.splice(0, this.items.length - LOG_KEEP);
  }

  /** The newest `max` events, oldest first, each with the time before `now` in seconds. */
  lines(now: number, max = LOG_SHOW): string[] {
    return this.items.slice(-max).map((i) => `${(-Math.max(0, now - i.at) / 1000).toFixed(1).padStart(7)} s  ${i.text}`);
  }

  clear(): void {
    this.items = [];
  }
}

/** How a constraints object reads in the log (short). */
export function constraintsText(c: MediaTrackConstraints | boolean): string {
  if (typeof c === 'boolean') return String(c);
  const part = (v: unknown): string => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.entries(o)
        .map(([k, x]) => `${k} ${String(x)}`)
        .join(' ');
    }
    return String(v);
  };
  const out = Object.entries(c).map(([k, v]) => `${k}=${part(v)}`);
  return out.length ? out.join(', ') : 'any camera';
}

export function errorText(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`;
}
