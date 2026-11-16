/**
 * Routes the phone's microphone (the audio track of the phone-link stream) into the audio engine: every Phone Camera node whose
 * `session` param equals a token with a live stream gets that stream; nodes that lose their token or whose stream ends get null.
 * Pure: the engine call is injected, so the mapping can be tested.
 */
import type { GraphDoc } from '../engine/types';

/** Ids of the Phone Camera nodes that belong to a pairing token. Several nodes may share one token. */
export function nodesForToken(graph: GraphDoc, token: string): string[] {
  if (!token) return [];
  return graph.nodes.filter((n) => n.type === 'phone-camera' && n.params.session === token).map((n) => n.id);
}

/** True when a Phone Camera's Sound or tap output is wired to something: the audio engine must run (the Enable audio prompt). */
export function phoneAudioWired(graph: GraphDoc): boolean {
  const phone = new Set(graph.nodes.filter((n) => n.type === 'phone-camera').map((n) => n.id));
  if (phone.size === 0) return false;
  return graph.edges.some((e) => phone.has(e.from.node) && (e.from.port === 'audio' || e.from.port === 'tap'));
}

export class PhoneAudioRouter {
  private streams = new Map<string, MediaStream>();
  private graph: GraphDoc | null = null;
  /** What the engine currently has per node. */
  private attached = new Map<string, MediaStream>();

  constructor(private setLiveStream: (nodeId: string, stream: MediaStream | null) => void) {}

  setGraph(graph: GraphDoc): void {
    this.graph = graph;
    this.sync();
  }

  /** A session's stream appeared (or changed), or ended (null). */
  setStream(token: string, stream: MediaStream | null): void {
    if (stream) this.streams.set(token, stream);
    else this.streams.delete(token);
    this.sync();
  }

  private sync(): void {
    const want = new Map<string, MediaStream>();
    if (this.graph) for (const [token, stream] of this.streams) for (const id of nodesForToken(this.graph, token)) want.set(id, stream);
    for (const [id] of this.attached) {
      if (!want.has(id)) {
        this.setLiveStream(id, null);
        this.attached.delete(id);
      }
    }
    for (const [id, stream] of want) {
      if (this.attached.get(id) === stream) continue;
      this.setLiveStream(id, stream);
      this.attached.set(id, stream);
    }
  }
}
