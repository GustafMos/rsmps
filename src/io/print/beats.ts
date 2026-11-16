/**
 * A simple energy-onset detector for beat marks on exposure sheets. Pure: takes mono (or multi-channel) PCM and
 * returns the times of sudden rises in short-time energy. Not a tempo tracker; it finds hits.
 */

export interface BeatOptions {
  /** Analysis window and hop in samples at 44.1 kHz scale (scaled to the real rate). */
  windowSize?: number;
  hopSize?: number;
  /** Threshold = local mean flux + `sensitivity` x local standard deviation (default 1.5; lower finds more). */
  sensitivity?: number;
  /** Minimum time between two beats in seconds (default 0.18). */
  minGapSeconds?: number;
}

/** Mix channels to one and return RMS energy per hop. */
function energyCurve(channels: readonly Float32Array[], hop: number, win: number): Float32Array {
  const n = channels[0]?.length ?? 0;
  const frames = Math.max(0, Math.floor((n - win) / hop) + 1);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < win; i++) {
      let s = 0;
      for (const c of channels) s += c[start + i];
      s /= channels.length;
      sum += s * s;
    }
    out[f] = Math.sqrt(sum / win);
  }
  return out;
}

/** Times (seconds) of detected onsets. */
export function detectBeats(channels: readonly Float32Array[], sampleRate: number, o: BeatOptions = {}): number[] {
  if (channels.length === 0 || channels[0].length === 0 || !(sampleRate > 0)) return [];
  const scale = sampleRate / 44100;
  const win = Math.max(64, Math.round((o.windowSize ?? 1024) * scale));
  const hop = Math.max(32, Math.round((o.hopSize ?? 512) * scale));
  const e = energyCurve(channels, hop, win);
  const flux = new Float32Array(e.length);
  for (let i = 1; i < e.length; i++) flux[i] = Math.max(0, e[i] - e[i - 1]);
  const sens = o.sensitivity ?? 1.5;
  const half = Math.max(4, Math.round((0.5 * sampleRate) / hop));
  const minGap = Math.max(1, Math.round(((o.minGapSeconds ?? 0.18) * sampleRate) / hop));
  const peaks: number[] = [];
  let peakMax = 0;
  for (let i = 0; i < flux.length; i++) peakMax = Math.max(peakMax, flux[i]);
  let eMax = 0;
  for (let i = 0; i < e.length; i++) eMax = Math.max(eMax, e[i]);
  // a hit is a rise of at least a tenth of the loudest level (a steady tone only wobbles)
  if (peakMax < 0.1 * eMax || peakMax <= 1e-5) return [];
  let last = -minGap;
  for (let i = 1; i < flux.length - 1; i++) {
    if (!(flux[i] >= flux[i - 1] && flux[i] > flux[i + 1])) continue;
    let mean = 0;
    let sq = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(flux.length - 1, i + half); j++) {
      mean += flux[j];
      sq += flux[j] * flux[j];
      cnt++;
    }
    mean /= cnt;
    const sd = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
    if (flux[i] < mean + sens * sd || flux[i] < 0.08 * peakMax) continue;
    if (i - last < minGap) {
      // keep the stronger of two close peaks
      if (peaks.length && flux[i] > flux[last]) {
        peaks[peaks.length - 1] = i;
        last = i;
      }
      continue;
    }
    peaks.push(i);
    last = i;
  }
  return peaks.map((p) => (p * hop + win / 2) / sampleRate);
}

/** Beat times as frame numbers at `fps`, unique and ascending. */
export function beatFrames(times: readonly number[], fps: number): number[] {
  const set = new Set<number>();
  for (const t of times) set.add(Math.max(0, Math.round(t * fps)));
  return [...set].sort((a, b) => a - b);
}
