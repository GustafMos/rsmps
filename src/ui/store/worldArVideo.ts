/**
 * "Save as video" for a World AR take: the recorded camera clip with the viewed node's picture rendered over it, frame by frame
 * through the exporter, the way the Recorder renders a smooth take. The take and its raw camera clip are never touched: a failed or
 * cancelled rendering leaves them as they were and the button is there again.
 */
import { AR_VIDEO_OUTPUT_LABEL, arVideoFrames, arVideoSize, buildWorldArVideoGraph } from '../../engine/lib/ar-video-graph';
import { flattenGraph } from '../../engine/group';
import { isWorldTake, type WorldTake } from '../../engine/lib/world-take';
import type { GraphDoc } from '../../engine/types';
import type { Io } from '../../io/api';
import { formatElapsed, takeFileName } from '../../io/live-record';
import type { Editor } from './editor';
import { createStore, type Store } from './createStore';
import { browserRecorderEnv, remainingSeconds, takeOutputParams, type RecorderEnv } from './recorder';

/** The video is no larger than this on its long side: a phone renders and encodes it. */
export const AR_VIDEO_MAX_SIDE = 1280;

export interface ArVideoUi {
  phase: 'idle' | 'rendering' | 'saving';
  /** Path id of the World AR Camera node being rendered. */
  nodeId: string | null;
  progress: number;
  remaining: number | null;
  /** File name of the last finished video, so it can be saved as a file again. */
  lastName: string | null;
}

const IDLE: ArVideoUi = { phase: 'idle', nodeId: null, progress: 0, remaining: null, lastName: null };

type Env = Pick<RecorderEnv, 'saveFile' | 'now'>;

export interface ArVideoOptions {
  /** Render the graph alone (over black) although there is no camera clip. */
  alone?: boolean;
  /** Save the file to the device's downloads as well as to Media (default yes). */
  download?: boolean;
}

export class WorldArVideoController {
  readonly store: Store<ArVideoUi> = createStore<ArVideoUi>({ ...IDLE });
  private abort: AbortController | null = null;
  private last: File | null = null;

  /** `elsewhere`: a reason why something else (the Recorder) is busy, or null. */
  constructor(
    private ed: Editor,
    private io: Io,
    private elsewhere: () => string | null = () => null,
    private env: Env = browserRecorderEnv,
  ) {}

  /** Why a rendering cannot start now, or null. Shared with the Recorder and the Export button through `Editor.exportBusy`. */
  busy(): string | null {
    if (this.store.get().phase !== 'idle') return 'A video is already being saved.';
    if (this.io.worldAr?.active) return 'Close the AR view first: the video is rendered when the camera is free.';
    return this.ed.exportBusy ?? this.elsewhere();
  }

  /** Can a video be made from the take of this node, and what is missing. Pure reading of the project. */
  plan(nodeId: string): { take: WorldTake; clipAsset: string | null; clipMissing: boolean } | null {
    const node = this.find(nodeId)?.node;
    const take = node?.params.take;
    if (!isWorldTake(take)) return null;
    const asset = take.clipAsset && this.io.library.assetInfo(take.clipAsset) ? take.clipAsset : null;
    return { take, clipAsset: asset, clipMissing: !!take.clipAsset && !asset };
  }

  private find(nodeId: string) {
    const view = flattenGraph(this.ed.state.graph);
    const id = view.alias.get(nodeId) ?? nodeId;
    const node = view.graph.nodes.find((n) => n.id === id);
    return node ? { node, flat: view.graph } : null;
  }

  /** Start rendering. Returns false when it did not start (a reason was shown). */
  async start(nodeId: string, o: ArVideoOptions = {}): Promise<boolean> {
    const { ed, io, env } = this;
    const plan = this.plan(nodeId);
    if (!plan) {
      ed.toast('There is no AR recording on this node to make a video from.', 'info');
      return false;
    }
    const why = this.busy();
    if (why) {
      ed.toast(why, 'info');
      return false;
    }
    const { take, clipAsset } = plan;
    if (!clipAsset && !o.alone) {
      ed.toast(
        plan.clipMissing
          ? 'The camera clip of this take is no longer in Media, so there is no camera picture to put the object over. You can still save the object alone, over black.'
          : 'This recording has no camera picture (the phone did not hand it over), only the movement. You can save the object alone, over black.',
        'info',
      );
      return false;
    }
    const shown = take.shown && this.find(take.shown) ? take.shown : (ed.state as { viewedNodeId?: string | null }).viewedNodeId;
    const viewed = shown && shown !== nodeId ? this.find(shown) : null;
    if (!shown || !viewed) {
      ed.toast('View the node you want in the video first (the eye on your 3D Object), then press Save as video.', 'info');
      return false;
    }
    const info = clipAsset ? io.library.assetInfo(clipAsset) : null;
    const source: GraphDoc = ed.state.graph;
    const size = arVideoSize(info ? { width: info.width, height: info.height } : null, source.project, AR_VIDEO_MAX_SIDE);
    const output = { ...takeOutputParams(null, size, AR_VIDEO_MAX_SIDE), name: AR_VIDEO_OUTPUT_LABEL };
    const port = Object.entries(io.registry.get(viewed.node.type)?.outputs ?? {}).find(([, d]) => (d as { type?: string }).type === 'image')?.[0] ?? 'image';
    const built = buildWorldArVideoGraph(source, { arId: nodeId, viewedId: shown, viewedPort: port, take, clipAsset, width: size.width, height: size.height, output });
    if (!built) {
      ed.toast('The video could not be set up: a node of the recording is gone.', 'error');
      return false;
    }
    const frames = arVideoFrames(take, info && info.duration > 0 ? info.duration : null);
    const fps = take.fps;
    const date = new Date();
    const began = env.now();
    const ac = new AbortController();
    this.abort = ac;
    const blocked = ed as unknown as { exportBlocked: string | null };
    blocked.exportBlocked = 'A video of an AR recording is being rendered. Export when it has finished.';
    const wasPlaying = io.player.getState().playing;
    if (wasPlaying) io.player.pause(); // the viewer would render the same GPU work at the same time
    this.store.set((s) => ({ ...IDLE, phase: 'rendering', nodeId, lastName: s.lastName }));
    const keep = 'The AR recording and its camera clip are unchanged.';
    try {
      const sound = info?.hasAudio && clipAsset ? ((await io.library.assetAudio?.(clipAsset)) ?? null) : null;
      const files = await io.exporter.run({
        graph: built.graph,
        outputs: [built.outputId],
        items: 'current',
        item: (ed.state as { item?: number }).item ?? 0,
        zip: false,
        signal: ac.signal,
        runProcesses: true,
        onProgress: (pr) => this.store.set((s) => (s.phase === 'rendering' ? { ...s, progress: pr.fraction, remaining: remainingSeconds((env.now() - began) / 1000, pr.fraction) } : s)),
        // frame n of the video is clip frame n, at the clip's own clock: the camera node reads the take at the same time
        take: { frames, at: (frame) => ({ seconds: frame / fps }), audio: sound, audioStart: 0 },
      });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const video = files.find((f) => /\.(mp4|webm|mov|mkv)$/i.test(f.name) && f.blob.size > 0);
      const report = files.find((f) => /^errors.*\.txt$/i.test(f.name));
      if (!video) throw new Error(report ? (await report.blob.text()).trim().split('\n')[0].replace(`${AR_VIDEO_OUTPUT_LABEL}: `, '') : 'no video was made');
      const ext = /\.([a-z0-9]+)$/i.exec(video.name)?.[1].toLowerCase() ?? 'mp4';
      const file = new File([video.blob], takeFileName('AR video', date, ext), { type: video.blob.type });
      this.last = file;
      this.store.set((s) => ({ ...s, phase: 'saving', lastName: file.name }));
      const download = o.download !== false;
      if (download) env.saveFile(file);
      const [asset] = await io.library.add([file]);
      if (!asset) throw new Error('the video could not be added to Media');
      ed.toast(`${download ? 'Saved to your downloads and to Media' : 'Saved to Media'}: ${file.name} (${formatElapsed(frames / fps)}${sound ? ', with sound' : ', picture only'}). ${keep}`, 'ok');
      return true;
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) ed.toast(`Saving the video was cancelled. ${keep} Press "Save as video" to try again.`, 'info');
      else ed.toast(`The video could not be made: ${err instanceof Error ? err.message : String(err)}. ${keep} Press "Save as video" to try again.`, 'error');
      return false;
    } finally {
      this.abort = null;
      blocked.exportBlocked = null;
      if (wasPlaying) io.player.play();
      this.store.set((s) => ({ ...IDLE, lastName: s.lastName }));
    }
  }

  /** Stop the rendering. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Save the last finished video as a file on the device again. */
  saveLast(): void {
    if (this.last) this.env.saveFile(this.last);
  }
}
