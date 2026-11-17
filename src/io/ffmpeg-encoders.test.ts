import { describe, expect, it } from 'vitest';
import { ALL_ENCODERS } from './export-codecs';
import { missingEncoderMessage, parseEncoderList, wantedPresent } from './ffmpeg-encoders';

/** Shape of `ffmpeg -hide_banner -encoders` (legend, separator, one line per encoder), written by hand from FFmpeg 7+ output. */
const SAMPLE = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V.S..D dxv                  Resolume DXV
 V.S..D hap                  Vidvox Hap
 VFS... prores_ks            Apple ProRes (iCodec Pro) (codec prores)
 V....D qtrle                QuickTime Animation (RLE) video
 A....D pcm_s16le            PCM signed 16-bit little-endian
 S..... srt                  SubRip subtitle (codec subrip)
`;

describe('encoder list parser', () => {
  it('reads encoder names and skips the legend', () => {
    const set = parseEncoderList(SAMPLE);
    expect([...set].sort()).toEqual(['dxv', 'hap', 'libx264', 'libx265', 'pcm_s16le', 'prores_ks', 'qtrle', 'srt']);
    expect(set.has('=')).toBe(false);
  });
  it('handles Windows line ends, empty text and a missing separator', () => {
    expect(parseEncoderList(SAMPLE.replace(/\n/g, '\r\n')).has('dxv')).toBe(true);
    expect(parseEncoderList('').size).toBe(0);
    expect(parseEncoderList(' V....D libx264              x\n').has('libx264')).toBe(true);
  });
  it('lists only the encoders the codec table asks about, sorted', () => {
    expect(wantedPresent(parseEncoderList(SAMPLE), ALL_ENCODERS)).toEqual(['dxv', 'hap', 'libx264', 'libx265', 'pcm_s16le', 'prores_ks', 'qtrle']);
    expect(wantedPresent(new Set(), ALL_ENCODERS)).toEqual([]);
  });
  it('says plainly what is missing', () => {
    expect(missingEncoderMessage('HAP', 'hap')).toMatch(/HAP needs the "hap" encoder/);
  });
});
