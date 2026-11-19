/**
 * The planning half of Codec Datamosh. Pure: no codec, no GPU, no DOM.
 *
 * A real datamosh compresses the picture with a video codec, damages the compressed stream on purpose and decodes it again. Two kinds
 * of damage are planned here:
 *
 *  - KEY FRAME REMOVAL. A codec stream is a key frame (a whole picture) followed by delta frames ("move these blocks, add this
 *    correction"). Where the input cuts to a new shot we ask the encoder for a key frame AND, right after it, for a delta of the very
 *    same picture (which says "nothing moved"). The key frame is then left out of what the decoder is given. Everything after it was
 *    made for the new shot, but the decoder still holds the old one, so the new shot's motion drags the old shot's pixels around.
 *    The second encode keeps the number of frames exact: every project frame still has exactly one chunk.
 *  - BLOOM. One delta frame is given to the decoder again and again in place of the frames that followed it, so its motion is applied
 *    over and over and the picture smears in the direction it was moving.
 *
 * `encodeSteps` says what to ask of the encoder for each frame (it works frame by frame, so the encoder can run while the frames
 * are rendered); `decodePlan` then says which chunks the decoder gets, in which order, and which decoded picture each project frame shows.
 */

export type MoshMode = 'keys' | 'bloom' | 'both';
export type MoshRemoveAt = 'cuts' | 'list' | 'both';
export type MoshBloomWhere = 'frame' | 'cuts';

export interface MoshSettings {
  mode: MoshMode;
  /** Where key frames are removed: at detected cuts, at the listed frames, or both. */
  removeAt: MoshRemoveAt;
  /** Listed frames (0 based, already wrapped into the project). */
  positions: readonly number[];
  /** 0 = only the first frame is a kept key frame; otherwise a kept key frame every this many frames (the picture heals). */
  refreshEvery: number;
  /** Bloom starts at one chosen frame, or on the first moving frame after every removed key frame. */
  bloomWhere: MoshBloomWhere;
  bloomAt: number;
  /** How many times the bloom frame is repeated (it replaces that many of the frames after it). */
  bloomCount: number;
}

/** One request to the encoder, in the order they are made. */
export interface MoshStep {
  /** Project frame whose picture is encoded. */
  frame: number;
  /** Ask for a key frame. */
  key: boolean;
  /** The chunk is made only so that the encoder moves on to the new shot: the decoder never gets it. */
  drop: boolean;
}

/**
 * What the encoder actually made for a step (`null` = it made nothing: some encoders skip a frame under pressure).
 * `leaf`: no later frame is predicted from this one (the fallback codecs make every other frame like that). Repeating a leaf does
 * not pile up motion, the decoder would show the same picture each time, so a bloom never starts on one.
 */
export type MoshChunk = { key: boolean; leaf?: boolean } | null;

const removesKeys = (s: MoshSettings) => s.mode === 'keys' || s.mode === 'both';
const blooms = (s: MoshSettings) => (s.mode === 'bloom' || s.mode === 'both') && s.bloomCount > 0;

/** A kept key frame (the picture is whole again): the first frame, and every `refreshEvery` frames. */
export function isRefreshFrame(frame: number, s: Pick<MoshSettings, 'refreshEvery'>): boolean {
  if (frame <= 0) return true;
  const n = Math.round(s.refreshEvery);
  return n > 0 && frame % n === 0;
}

/** Is the key frame of this frame removed? `cut`: the cut detector fired on it. A kept key frame always wins. */
export function isRemovedFrame(frame: number, cut: boolean, s: MoshSettings): boolean {
  if (!removesKeys(s) || isRefreshFrame(frame, s)) return false;
  const listed = s.removeAt !== 'cuts' && s.positions.includes(frame);
  const detected = s.removeAt !== 'list' && cut;
  return listed || detected;
}

/** What to ask of the encoder for one frame. One step normally; two where a key frame is removed (the key, then "nothing moved"). */
export function encodeSteps(frame: number, cut: boolean, s: MoshSettings): MoshStep[] {
  if (isRefreshFrame(frame, s)) return [{ frame, key: true, drop: false }];
  if (isRemovedFrame(frame, cut, s))
    return [
      { frame, key: true, drop: true },
      { frame, key: false, drop: false },
    ];
  return [{ frame, key: false, drop: false }];
}

export interface MoshDecodePlan {
  /** Indices into the steps / chunks, in the order the decoder gets them. Starts with a key frame; never contains a dropped chunk. */
  feed: number[];
  /** For every project frame: which position of `feed` is its picture. Same length as the project. */
  show: number[];
  /** Frames whose key frame was left out. */
  removed: number[];
  /** Frames a bloom starts on. */
  bloomStarts: number[];
}

/**
 * Which chunks the decoder gets. `steps` are the requests made (in order, frames ascending from 0 without gaps), `chunks[i]` what the
 * encoder made for `steps[i]`.
 *
 * Rules:
 *  - the first chunk fed is a key frame (an error is thrown when the encoder did not make one: nothing can be decoded then);
 *  - a chunk marked `drop` is never fed;
 *  - a key frame the encoder made WITHOUT being asked (some do, on a hard cut) cannot be removed after the fact, so it is fed and the
 *    picture heals there; it is not counted in `removed`;
 *  - a kept key frame is always fed, also inside a bloom, and it ends the bloom (the picture heals as often as "Key frame every" says);
 *  - a bloom repeats its frame `bloomCount` times IN PLACE of the frames after it, so the project keeps its length and what follows
 *    stays in time with the sound; it starts on the first frame at or after the chosen one that is a delta frame and not a `leaf`;
 *  - a frame the encoder skipped shows the picture before it.
 */
export function decodePlan(steps: readonly MoshStep[], chunks: readonly MoshChunk[], s: MoshSettings): MoshDecodePlan {
  const frames = steps.length ? steps[steps.length - 1].frame + 1 : 0;
  // The chunk each frame is shown from (the last step of a frame is the kept one), and whether its key frame was removed.
  const kept: number[] = new Array(frames).fill(-1);
  const removed: number[] = [];
  steps.forEach((st, i) => {
    if (st.drop) {
      if (chunks[i]?.key) removed.push(st.frame);
    } else if (chunks[i]) kept[st.frame] = i;
  });
  if (frames === 0) return { feed: [], show: [], removed: [], bloomStarts: [] };
  if (kept[0] < 0 || !chunks[kept[0]]?.key) throw new Error('The encoder did not start with a key frame, so nothing can be decoded.');

  const isKey = (f: number) => kept[f] >= 0 && !!chunks[kept[f]]?.key;
  const startSet = new Set<number>();
  if (blooms(s)) {
    if (s.bloomWhere === 'frame') startSet.add(Math.round(s.bloomAt));
    // After a removed key frame the first chunk is "nothing moved"; the one after it carries the new shot's first motion.
    else for (const f of removed) startSet.add(f + 1);
  }

  const feed: number[] = [];
  const show: number[] = [];
  const bloomStarts: number[] = [];
  let bloom: { chunk: number; left: number } | null = null;
  let wantStart = false;
  for (let f = 0; f < frames; f++) {
    let chunk = kept[f];
    if (startSet.has(f)) wantStart = true;
    if (isKey(f)) bloom = null;
    else if (wantStart && chunk >= 0 && !chunks[chunk]?.leaf) {
      bloom = { chunk, left: Math.max(0, Math.round(s.bloomCount)) };
      bloomStarts.push(f);
      wantStart = false;
    } else if (bloom && bloom.left > 0) {
      chunk = bloom.chunk;
      bloom.left--;
    }
    if (chunk >= 0) feed.push(chunk);
    show.push(Math.max(0, feed.length - 1));
  }
  return { feed, show, removed, bloomStarts };
}

/**
 * Which decoded picture each project frame shows, given what the decoder really gave back (`got[i]` = did feed position `i` produce
 * a picture). A missing picture shows the nearest one before it (or, at the very start, the first one after). Returns null when there
 * is no picture at all.
 */
export function resolveShown(show: readonly number[], got: readonly boolean[]): number[] | null {
  const first = got.indexOf(true);
  if (first < 0) return null;
  const before: number[] = [];
  let last = first;
  for (let i = 0; i < got.length; i++) {
    if (got[i]) last = i;
    before.push(last);
  }
  return show.map((i) => before[Math.min(Math.max(0, i), before.length - 1)] ?? first);
}

/**
 * "12, 48 96" -> [12, 48, 96]: whole frame numbers, wrapped into the project, sorted, without repeats. Anything else is ignored.
 * `base`: the number the text gives the first frame (1 when it comes from the user: the transport counts from 1). The result counts from 0.
 */
export function parsePositions(text: string, frames: number, base = 0): number[] {
  const out = new Set<number>();
  if (frames <= 0) return [];
  for (const part of String(text ?? '').split(/[^0-9.+-]+/)) {
    if (!part) continue;
    const v = Number(part);
    if (!Number.isFinite(v)) continue;
    const f = Math.round(v) - base;
    out.add(((f % frames) + frames) % frames);
  }
  return [...out].sort((a, b) => a - b);
}

/* ----------------------------------------------------------------------- */
/* Cut detection                                                            */
/* ----------------------------------------------------------------------- */

/** Side of the small brightness picture a frame is reduced to for cut detection. */
export const CUT_GRID = 16;

/**
 * Reduce an RGBA picture to a CUT_GRID x CUT_GRID picture of average brightness (0..255). Each cell averages a sparse sample of its
 * pixels (at most 8 x 8), which is plenty to tell two shots apart and costs the same for any picture size.
 */
export function frameSignature(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(CUT_GRID * CUT_GRID);
  if (width <= 0 || height <= 0) return out;
  for (let gy = 0; gy < CUT_GRID; gy++) {
    const y0 = Math.floor((gy * height) / CUT_GRID);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / CUT_GRID));
    const sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let gx = 0; gx < CUT_GRID; gx++) {
      const x0 = Math.floor((gx * width) / CUT_GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / CUT_GRID));
      const sx = Math.max(1, Math.floor((x1 - x0) / 8));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y += sy) {
        for (let x = x0; x < x1 && x < width; x += sx) {
          const i = (y * width + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      out[gy * CUT_GRID + gx] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

/** How different two frames are: mean absolute brightness difference of their signatures, 0 (same) .. 1 (black against white). */
export function cutScore(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

/** The difference above which two frames count as a cut. Sensitivity 0 = only the hardest cuts (0.32), 1 = nearly any change (0.02). */
export function cutThreshold(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 0.5));
  return 0.02 + 0.3 * Math.pow(1 - s, 1.5);
}

/**
 * Frames that start a new shot: the difference to the frame before is above the threshold. A cut is not reported on the frame right
 * after another one (a flash frame would otherwise count twice), and never on frame 0.
 */
export function detectCuts(scores: readonly number[], sensitivity: number): number[] {
  const th = cutThreshold(sensitivity);
  const cuts: number[] = [];
  for (let f = 1; f < scores.length; f++) {
    if (scores[f] > th && cuts[cuts.length - 1] !== f - 1) cuts.push(f);
  }
  return cuts;
}

/* ----------------------------------------------------------------------- */
/* Compression                                                              */
/* ----------------------------------------------------------------------- */

/**
 * Bits per second for a "Compression" of 0 (clean, 0.3 bits per pixel) to 1 (starved, 0.006 bits per pixel). The steps are even to
 * the eye, so the scale is exponential. A starved stream is the point: the blocks get coarse and smear visibly.
 */
export function moshBitrate(width: number, height: number, fps: number, compression: number): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(compression) ? compression : 0.5));
  const bitsPerPixel = 0.3 * Math.pow(0.006 / 0.3, c);
  return Math.max(20000, Math.round(width * height * Math.max(1, fps) * bitsPerPixel));
}

/** The size the frames are encoded at: at most `maxSide` on the longer side, and even on both (video codecs need even sizes). */
export function moshSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const long = Math.max(width, height, 1);
  const k = maxSide > 0 ? Math.min(1, maxSide / long) : 1;
  const even = (v: number) => Math.max(16, Math.floor(Math.round(v * k) / 2) * 2);
  return { width: even(width), height: even(height) };
}
