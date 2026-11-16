import { describe, expect, it } from 'vitest';
import { codecOptionLabel, hasFfmpegOptions } from './CodecSelect';

describe('FFmpeg tag on codec options', () => {
  it('tags only FFmpeg-only formats, and only until FFmpeg is installed', () => {
    expect(codecOptionLabel('prores', 'ProRes', false)).toBe('ProRes · needs FFmpeg add-on');
    expect(codecOptionLabel('prores', 'ProRes', true)).toBe('ProRes');
    expect(codecOptionLabel('avc', 'H.264', false)).toBe('H.264');
    expect(codecOptionLabel('webm-alpha', 'WebM alpha', false)).toMatch(/needs FFmpeg add-on/);
  });
  it('recognises the Output codec list', () => {
    expect(hasFfmpegOptions([{ value: 'avc' }, { value: 'qtrle' }])).toBe(true);
    expect(hasFfmpegOptions([{ value: 'avc' }, { value: 'vp9' }])).toBe(false);
  });
});
