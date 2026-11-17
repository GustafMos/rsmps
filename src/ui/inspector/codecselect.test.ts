import { describe, expect, it } from 'vitest';
import { codecOptionLabel, codecUnavailable, hasFfmpegOptions } from './CodecSelect';

describe('FFmpeg tag on codec options', () => {
  it('tags only FFmpeg-only formats, and only until FFmpeg is installed', () => {
    expect(codecOptionLabel('prores', 'ProRes', false)).toBe('ProRes · needs FFmpeg add-on');
    expect(codecOptionLabel('prores', 'ProRes', true)).toBe('ProRes');
    expect(codecOptionLabel('avc', 'H.264', false)).toBe('H.264');
    expect(codecOptionLabel('webm-alpha', 'WebM alpha', false)).toMatch(/needs FFmpeg add-on/);
  });
  it('greys out formats the installed FFmpeg does not have', () => {
    expect(codecOptionLabel('qtrle', 'Animation', true, ['dxv'])).toBe('Animation · not in this FFmpeg');
    expect(codecUnavailable('qtrle', true, ['dxv'])).toBe(true);
    // formats the app writes itself never carry an FFmpeg tag and are never greyed out
    expect(codecOptionLabel('hap', 'HAP', false)).toBe('HAP');
    expect(codecOptionLabel('hap', 'HAP', true, ['dxv'])).toBe('HAP');
    expect(codecUnavailable('hap', true, ['dxv'])).toBe(false);
    expect(codecOptionLabel('qoi', 'QOI', false)).toBe('QOI');
    expect(codecOptionLabel('flac', 'FLAC 16-bit', false)).toBe('FLAC 16-bit');
    expect(codecOptionLabel('mp3', 'MP3', false)).toBe('MP3 · needs FFmpeg add-on');
    expect(codecOptionLabel('dpx', 'DPX', false)).toBe('DPX · needs FFmpeg add-on');
    expect(codecOptionLabel('dxv', 'DXV-compatible', true, ['dxv'])).toBe('DXV-compatible');
    expect(codecOptionLabel('dxv', 'DXV-compatible', true, null)).toBe('DXV-compatible');
    expect(codecOptionLabel('dxv', 'DXV-compatible', false, [])).toBe('DXV-compatible · needs FFmpeg add-on');
    expect(codecUnavailable('avc', true, [])).toBe(false);
  });
  it('recognises the Output codec list', () => {
    expect(hasFfmpegOptions([{ value: 'avc' }, { value: 'qtrle' }])).toBe(true);
    expect(hasFfmpegOptions([{ value: 'avc' }, { value: 'vp9' }])).toBe(false);
  });
});
