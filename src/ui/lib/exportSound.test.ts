import { describe, expect, it } from 'vitest';
import { audioRegistry, makeGraph } from '../../engine/audio/testing';
import { defineNode } from '../../engine/define';
import { describeExportSound, ownSoundSource, soundToWire } from './exportSound';

/** The audio registry (Media In, Audio Output, effects) plus a stand-in picture Output and Media Timeline. */
const registry = (() => {
  const r = audioRegistry();
  if (!r.get('image-out')) r.register(defineNode({ id: 'image-out', title: 'Output', category: 'output', description: 'Stand-in picture output.', inputs: { image: { type: 'image', label: 'Image' } }, outputs: {}, params: {}, render: () => ({}) }) as never);
  return r;
})();
const files: Record<string, { kind: string; name: string; hasAudio: boolean }> = {
  talk: { kind: 'video', name: 'talk.mp4', hasAudio: true },
  mute: { kind: 'video', name: 'mute.mp4', hasAudio: false },
  photo: { kind: 'image', name: 'photo.png', hasAudio: false },
};
const info = (id: string) => files[id];
const g = (nodes: { id: string; type: string; params?: Record<string, unknown>; bypass?: boolean }[], edges: string[]) => makeGraph({ nodes, edges });
const pic = (assets: string[]) => ({ id: 'pic', type: 'media-in', params: { assets } });

describe('what sound an export gets', () => {
  it('a clip with sound and no Audio Output: its own sound is exported but not heard, and is what Enable audio wires', () => {
    const graph = g([pic(['talk']), { id: 'out', type: 'image-out' }], ['pic.image -> out.image']);
    const d = describeExportSound(graph, registry, info, 0);
    expect(d.kind).toBe('clip');
    expect(d.unheard).toBe(true);
    expect(d.text).toContain('talk.mp4');
    expect(soundToWire(graph, registry, info, 0)).toMatchObject({ node: { id: 'pic' }, port: 'audio' });
  });
  it('a wired Audio Output is the sound: nothing more to wire, even when it plays another clip', () => {
    const graph = g([pic(['talk']), { id: 'snd', type: 'media-in', params: { assets: ['talk'] } }, { id: 'out', type: 'image-out' }, { id: 'aout', type: 'audio-out' }], ['pic.image -> out.image', 'snd.audio -> aout.audio']);
    const d = describeExportSound(graph, registry, info, 0);
    expect(d.kind).toBe('output');
    expect(d.unheard).toBe(false);
    expect(d.text).toContain('Media In');
    expect(soundToWire(graph, registry, info, 0)).toBeNull();
  });
  it('Audio Outputs that are all switched off: no sound', () => {
    const graph = g([pic(['talk']), { id: 'out', type: 'image-out' }, { id: 'aout', type: 'audio-out', params: { enabled: false } }], ['pic.image -> out.image', 'pic.audio -> aout.audio']);
    expect(describeExportSound(graph, registry, info, 0)).toMatchObject({ kind: 'none', unheard: false });
  });
  it('an Audio Output with nothing wired falls back to the clip, and is what gets a wire', () => {
    const graph = g([pic(['talk']), { id: 'out', type: 'image-out' }, { id: 'aout', type: 'audio-out' }], ['pic.image -> out.image']);
    expect(describeExportSound(graph, registry, info, 0).kind).toBe('clip');
    expect(soundToWire(graph, registry, info, 0)?.node.id).toBe('pic');
  });
  it('no sound to speak of: a picture, a clip without sound, a Media In that feeds no output', () => {
    for (const assets of [['photo'], ['mute'], []]) {
      const graph = g([pic(assets), { id: 'out', type: 'image-out' }], ['pic.image -> out.image']);
      expect(describeExportSound(graph, registry, info, 0)).toMatchObject({ kind: 'none', unheard: false });
      expect(soundToWire(graph, registry, info, 0)).toBeNull();
    }
    const loose = g([pic(['talk']), { id: 'out', type: 'image-out' }], []);
    expect(ownSoundSource(loose, registry, info, 0)).toBeNull();
  });
  it('follows the batch item', () => {
    const graph = g([pic(['photo', 'talk']), { id: 'out', type: 'image-out' }], ['pic.image -> out.image']);
    expect(describeExportSound(graph, registry, info, 0).kind).toBe('none');
    expect(describeExportSound(graph, registry, info, 1).kind).toBe('clip');
  });
});
