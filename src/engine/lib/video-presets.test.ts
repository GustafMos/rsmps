import { describe, expect, it } from 'vitest';
import { intraBitrate, resolveVideoPreset, type VideoAvailability } from './video-presets';

const cur = { codec: 'avc', bitrate: 12, allKeys: false };
const avail = (ffmpeg: boolean, ...enc: string[]): VideoAvailability => ({ ffmpeg, encoders: new Set(enc) });
const HD = 1920 * 1080;

describe('video "For" presets', () => {
  it('General changes nothing', () => {
    for (const a of [avail(false), avail(true, 'dxv', 'prores_ks')]) expect(resolveVideoPreset('general', cur, a)).toEqual({ ...cur, summary: '', note: '' });
  });

  // preset x (FFmpeg yes/no) x (encoders present)
  const table: [string, VideoAvailability, string, boolean, number, string][] = [
    ['vj', avail(true, 'dxv', 'prores_ks'), 'dxv', false, 12, 'VJ: DXV-compatible'],
    ['vj', avail(true, 'dxv'), 'dxv', false, 12, 'VJ: DXV-compatible'],
    ['vj', avail(true, 'prores_ks'), 'prores', false, 12, 'VJ: ProRes-compatible 422 HQ'],
    ['vj', avail(true), 'avc', true, 40, 'VJ: H.264 all key frames'],
    ['vj', avail(false, 'dxv', 'prores_ks'), 'avc', true, 40, 'VJ: H.264 all key frames'],
    ['vj', avail(false), 'avc', true, 40, 'VJ: H.264 all key frames'],
    ['editing', avail(true, 'prores_ks'), 'prores', false, 12, 'Editing: ProRes-compatible 422 HQ'],
    ['editing', avail(true, 'dxv'), 'avc', true, 30, 'Editing: H.264 all key frames'],
    ['editing', avail(false, 'prores_ks'), 'avc', true, 30, 'Editing: H.264 all key frames'],
    ['editing', avail(false), 'avc', true, 30, 'Editing: H.264 all key frames'],
    ['web', avail(true, 'dxv', 'prores_ks'), 'avc', false, 12, 'Web: H.264'],
    ['web', avail(false), 'avc', false, 12, 'Web: H.264'],
  ];
  it.each(table)('%s with %j', (preset, a, codec, allKeys, bitrate, summary) => {
    const r = resolveVideoPreset(preset, cur, a, HD);
    expect({ codec: r.codec, allKeys: r.allKeys, bitrate: r.bitrate, summary: r.summary }).toEqual({ codec, allKeys, bitrate, summary });
  });

  it('notes every fallback inside a preset and stays quiet otherwise', () => {
    expect(resolveVideoPreset('vj', cur, avail(true, 'dxv'), HD).note).toBe('');
    expect(resolveVideoPreset('vj', cur, avail(true, 'prores_ks'), HD).note).toMatch(/no DXV encoder/);
    expect(resolveVideoPreset('vj', cur, avail(false), HD).note).toMatch(/Resolume Alley/);
    expect(resolveVideoPreset('editing', cur, avail(false), HD).note).toMatch(/needs the desktop app/);
    expect(resolveVideoPreset('editing', cur, avail(true, 'prores_ks'), HD).note).toBe('');
    expect(resolveVideoPreset('web', cur, avail(false), HD).note).toBe('');
  });

  it('never invents an encoder: an unknown list assumes ProRes only, never DXV', () => {
    const unknown: VideoAvailability = { ffmpeg: true, encoders: null };
    expect(resolveVideoPreset('vj', cur, unknown, HD).codec).toBe('prores');
    expect(resolveVideoPreset('vj', cur, { ffmpeg: false, encoders: null }, HD).codec).toBe('avc');
  });

  it('keeps VP9 as VP9 when the intra-only fallback is needed, and never lowers a higher bitrate', () => {
    expect(resolveVideoPreset('vj', { ...cur, codec: 'vp9' }, avail(false), HD).codec).toBe('vp9');
    expect(resolveVideoPreset('vj', { ...cur, codec: 'hevc' }, avail(false), HD).codec).toBe('avc');
    expect(resolveVideoPreset('vj', { ...cur, bitrate: 90 }, avail(false), HD).bitrate).toBe(90);
  });

  it('scales the intra-only bitrate floor with the pixel count, within the node range', () => {
    expect(intraBitrate(12, HD, 40)).toBe(40);
    expect(intraBitrate(12, HD * 4, 40)).toBe(160);
    expect(intraBitrate(12, HD * 16, 40)).toBe(200);
    expect(intraBitrate(5, 320 * 240, 40)).toBe(8);
  });
});
