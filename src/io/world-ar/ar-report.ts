/**
 * "Copy AR report": the numbers of the last AR session as plain text, for the owner to paste into a message when the AR view feels
 * unsteady or late. Averages and worst values of what the readout shows, what the phone granted, how pictures reach the view, and
 * which extras (ground shadow, anti-aliasing, room light) were on for the viewed node. No pictures, no names, nothing personal.
 */

/** One number over a session: the mean of its samples and the worst (largest or smallest) one. */
class Series {
  private sum = 0;
  private n = 0;
  min = Infinity;
  max = -Infinity;
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.sum += v;
    this.n++;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }
}

/** The numbers one state sample holds (a subset of WorldArViewState, so this file needs no view types). */
export interface ArSample {
  fps: number;
  pictureFps: number;
  renderMs: number;
  copyMs: number;
  pictureBehindMs: number;
  zoom: number;
}

export interface ArReportMeta {
  appVersion: string;
  steadying: string;
  /** The features the browser granted (its own list when it gave one). */
  granted: string[];
  route: string;
  picture: { width: number; height: number } | null;
  groundShadow: boolean | null;
  antiAlias: string | null;
  roomLight: boolean;
  roomLightSeen: boolean;
  physics: boolean;
  seconds: number;
}

export class ArSessionStats {
  private fps = new Series();
  private pictures = new Series();
  private render = new Series();
  private copy = new Series();
  private behind = new Series();
  private zoomMax = 1;

  /** One sample (about five a second). Samples before the first picture, and a zero rate while loading, are left out. */
  add(s: ArSample): void {
    if (s.fps > 0) this.fps.add(s.fps);
    if (s.fps > 0) this.pictures.add(s.pictureFps);
    if (s.renderMs > 0) this.render.add(s.renderMs);
    if (s.renderMs > 0) this.copy.add(s.copyMs);
    if (s.pictureBehindMs > 0) this.behind.add(s.pictureBehindMs);
    this.zoomMax = Math.max(this.zoomMax, s.zoom);
  }

  get samples(): number {
    return this.fps.count;
  }

  report(m: ArReportMeta): string {
    const f = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : 'n/a');
    const line = (name: string, s: Series, worst: 'min' | 'max', unit: string) => (s.count ? `${name}: average ${f(s.mean)}${unit}, worst ${f(worst === 'max' ? s.max : s.min)}${unit}` : `${name}: no samples`);
    return [
      'AR report',
      `app version: ${m.appVersion}`,
      `session: ${m.seconds.toFixed(0)} s, ${this.samples} samples`,
      line('screen frames per second', this.fps, 'min', ''),
      line('object pictures per second', this.pictures, 'min', ''),
      line('render per picture', this.render, 'max', ' ms'),
      line('copy per picture', this.copy, 'max', ' ms'),
      line('object picture behind', this.behind, 'max', ' ms'),
      `steadying: ${m.steadying}`,
      `picture route: ${m.route}`,
      `picture size: ${m.picture ? `${m.picture.width}x${m.picture.height}` : 'none yet'}`,
      `granted features: ${m.granted.length ? m.granted.join(', ') : 'none listed'}`,
      `viewed node: ground shadow ${m.groundShadow === null ? 'n/a' : m.groundShadow ? 'on' : 'off'}, anti-aliasing ${m.antiAlias ?? 'n/a'}`,
      `room light: ${m.roomLight ? 'on' : 'off'}${m.roomLight ? (m.roomLightSeen ? ', estimates received' : ', no estimate received') : ''}`,
      `physics: ${m.physics ? 'yes' : 'no'}`,
      `largest zoom: ${this.zoomMax.toFixed(1)}x`,
    ].join('\n');
  }
}
