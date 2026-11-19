/**
 * The seam between the Codec Datamosh node (engine) and the video codec (io). The engine has no codec: the app installs a
 * `DatamoshService` at start (src/io/datamosh-codec.ts, the browser's WebCodecs encoder and decoder); the command line installs
 * nothing, so a job there fails with a plain sentence; tests install a fake one.
 *
 * The node decides WHAT is encoded and what the decoder is given (lib/datamosh-plan.ts); the service only encodes pictures into
 * chunks and decodes a list of chunks back into pictures.
 */

export interface DatamoshOpenOptions {
  /** Size of the pictures that will be handed to `encode`. */
  width: number;
  height: number;
  /** Longest side of the encoded video (0 = as it comes). */
  maxSide: number;
  fps: number;
  /** 0 (clean) .. 1 (starved): see `moshBitrate`. */
  compression: number;
  /** Codec names that already failed in this job: do not pick them again. */
  exclude?: readonly string[];
}

/** One encode-then-decode session. Use once: `encode` for every step, `finish`, `decode`, `close`. */
export interface DatamoshCodec {
  /** Shown to the user: 'H.264', 'VP8'... */
  readonly name: string;
  /** Size of the encoded (and decoded) pictures. */
  readonly width: number;
  readonly height: number;
  /** Said to the user next to the progress when the codec is not the preferred one. */
  readonly note?: string;
  /**
   * Encode one picture (RGBA, opaque: the alpha is ignored) as the next chunk. `key` asks for a key frame; every other chunk is a
   * delta frame of the picture before it.
   */
  encode(rgba: Uint8ClampedArray, key: boolean): Promise<void>;
  /**
   * Finish encoding. One entry per `encode` call: was the chunk really a key frame, and is it a `leaf` (no later frame is predicted
   * from it); null when the encoder made none.
   */
  finish(): Promise<({ key: boolean; leaf?: boolean } | null)[]>;
  /**
   * Decode the chunks `feed[0], feed[1]...` (indices of `encode` calls; a chunk may appear several times) as ONE stream. Returns one
   * stored picture per fed chunk, in the format the process store keeps for sequences; null where the decoder gave no picture.
   * Throws a `DatamoshRefused` when the decoder gives up on the damaged stream.
   */
  decode(feed: readonly number[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<(Blob | null)[]>;
  close(): void;
}

export interface DatamoshService {
  /** Pick a codec that can encode this size AND whose decoder survives a damaged stream. Throws a readable error when there is none. */
  open(opts: DatamoshOpenOptions, signal?: AbortSignal): Promise<DatamoshCodec>;
}

/** The decoder stopped on the damaged stream. The job then tries the next codec. */
export class DatamoshRefused extends Error {
  constructor(
    readonly codec: string,
    message: string,
  ) {
    super(message);
    this.name = 'DatamoshRefused';
  }
}

let service: DatamoshService | null = null;

export function setDatamoshService(s: DatamoshService | null): void {
  service = s;
}

export function getDatamoshService(): DatamoshService | null {
  return service;
}

/** Sentences shown when the job cannot run (the panel and the command line print them as they are). */
export const DATAMOSH_MESSAGES = {
  noRuntime:
    'Codec Datamosh needs a video encoder, which only the app has (the browser or the desktop app). Mosh it there once: the result is saved with the project, and exports and the command line then use it.',
  noEncoder: 'This browser has no video encoder that can be used for a datamosh (WebCodecs with H.264 or VP9). Try a current Chrome or Edge, or the desktop app.',
  refused: "This browser's decoder refuses a damaged stream, so the datamosh cannot be made here. Try a current Chrome or Edge, or the desktop app.",
} as const;
