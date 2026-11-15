import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Registry } from '../../engine/define';
import { addNode, connect, createGraph, setParam } from '../../engine/graph';
import { registerBuiltins } from '../../engine/nodes';
import type { GraphDoc, ProjectSettings } from '../../engine/types';
import { findFfmpeg } from '../ffmpeg';

export function builtinRegistry(): Registry {
  const r = new Registry();
  registerBuiltins(r);
  return r;
}

export function tempDir(prefix = 'rsmps-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Chain {
  graph: GraphDoc;
  ids: string[];
}

/** Build `type[0] -> type[1] -> ... -> image-out`, wiring each node's first image output to the next first image input. */
export function chain(
  registry: Registry,
  steps: { type: string; params?: Record<string, unknown>; label?: string }[],
  project: Partial<ProjectSettings> = {},
  outParams: Record<string, unknown> = {},
): Chain {
  let graph = createGraph('testgraph');
  graph = { ...graph, project: { ...graph.project, width: 64, height: 48, fps: 12, duration: 1, lengthMode: 'absolute', ...project } };
  const ids: string[] = [];
  let prev: { id: string; port: string } | null = null;
  for (const step of [...steps, { type: 'image-out', params: { name: '{name}', ...outParams }, label: 'Out' }]) {
    const added = addNode(graph, registry, step.type, { x: 0, y: 0 }, step.params ?? {});
    graph = added.graph;
    if (step.label) graph = { ...graph, nodes: graph.nodes.map((n) => (n.id === added.node.id ? { ...n, label: step.label } : n)) };
    const def = registry.get(step.type)!;
    if (prev) {
      const inPort = Object.entries(def.inputs).find(([, v]) => (v as { type: string }).type === 'image')![0];
      graph = connect(graph, registry, { node: prev.id, port: prev.port }, { node: added.node.id, port: inPort });
    }
    const outPort = Object.entries(def.outputs).find(([, v]) => (v as { type: string }).type === 'image')?.[0];
    prev = outPort ? { id: added.node.id, port: outPort } : null;
    ids.push(added.node.id);
  }
  return { graph, ids };
}

export { addNode, connect, setParam };

/** Write a translucent coloured disc PNG (straight alpha 128 at the centre). */
export async function writeSprite(file: string, w: number, h: number, color: string): Promise<void> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="${color}" fill-opacity="0.5"/></svg>`,
  );
  await sharp(svg).png().toFile(file);
}

export async function readRaw(file: string): Promise<{ data: Buffer; width: number; height: number; at: (x: number, y: number) => number[] }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
}

export async function ffmpegBin(): Promise<string | null> {
  return findFfmpeg();
}

/** Run ffmpeg synchronously (tests only). */
export function ffmpegSync(bin: string, args: string[]): { status: number | null; stderr: string; stdout: Buffer } {
  const r = spawnSync(bin, ['-hide_banner', '-nostdin', ...args], { encoding: 'buffer' });
  return { status: r.status, stderr: r.stderr.toString(), stdout: r.stdout };
}
