import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { registerBuiltins } from '../../engine/nodes';
import type { AssetInfo } from '../../engine/types';
import { buildLayeredScanGraph, guideRemovalStep } from './scanGraph';

const registry = new Registry();
registerBuiltins(registry);

const asset = (id: string, extra: Record<string, unknown> = {}): AssetInfo => ({ id, name: id, kind: 'video', width: 320, height: 240, duration: 2, fps: 12, hasAudio: false, ...extra }) as AssetInfo;

describe('scan graph for printed sheets', () => {
  it('adds Keep only what I drew for blue / faint / outline guides and nothing for full or blank', () => {
    expect(guideRemovalStep(registry, asset('a', { printGuide: { mode: 'faded', opacity: 40, blue: true } }))!.params).toMatchObject({ guide: 'blue', strength: 0.4 });
    expect(guideRemovalStep(registry, asset('a', { printGuide: { mode: 'faded', opacity: 25, blue: false } }))!.params.guide).toBe('faint');
    expect(guideRemovalStep(registry, asset('a', { printGuide: { mode: 'outline', opacity: 100, blue: false } }))!.params.guide).toBe('outline');
    expect(guideRemovalStep(registry, asset('a', { printGuide: { mode: 'full', opacity: 100, blue: false } }))).toBeNull();
    expect(guideRemovalStep(registry, asset('a', { printGuide: { mode: 'blank', opacity: 100, blue: false } }))).toBeNull();
    expect(guideRemovalStep(registry, asset('a'))).toBeNull();
  });

  it('builds one Scanned frames source per paper layer, ink to alpha, stacked bottom to top', () => {
    const g = buildLayeredScanGraph(registry, 'Layers', [asset('l2', { layer: 1 }), asset('l1', { layer: 0, printGuide: { mode: 'faded', opacity: 30, blue: true } })])!;
    expect(g).not.toBeNull();
    const labels = g.nodes.map((n) => n.label);
    expect(labels).toEqual(expect.arrayContaining(['Scanned frames 1', 'Scanned frames 2', 'Ink to alpha 1', 'Ink to alpha 2', 'Keep only what I drew', 'Stack layers', 'Export']));
    const stack = g.nodes.find((n) => n.label === 'Stack layers')!;
    const wires = g.edges.filter((e) => e.to.node === stack.id);
    expect(wires.length).toBe(2);
    // layer 1 (asset l1) is wired first = bottom of the stack
    const src1 = g.nodes.find((n) => n.label === 'Scanned frames 1')!;
    expect(JSON.stringify(src1.params)).toContain('l1');
    const firstFrom = g.nodes.find((n) => n.id === wires[0].from.node)!;
    expect(firstFrom.label).toBe('Ink to alpha 1');
    expect(g.nodes.filter((n) => n.type === 'paper-clean').every((n) => n.params.output === 'ink')).toBe(true);
  });
});
