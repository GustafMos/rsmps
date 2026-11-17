import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Registry } from '../engine/define';
import { registerBuiltins } from '../engine/nodes';
import { BITRATE_CODECS } from '../engine/nodes/output/image-out.node';
import { CODECS, parseCodec } from '../cli/encode';
import { parseForFlag } from '../cli/args';
import { AUDIO_ROWS, CODEC_TABLE, FFMPEG_CODEC_VALUES, STILL_ROWS, VIDEO_ROWS, WIRED_ROWS, audioRow, registryCounts, stillRow, encoderMissing, ffmpegArgsFor, ffmpegOnlyCodec, minSizeMessage, needsFfmpeg, rowById, rowByValue, videoRoute } from './export-codecs';

const outputNode = () => {
  const r = new Registry();
  registerBuiltins(r);
  return r.get('image-out')!;
};
const args = (id: string, o: { bitrateMbps?: number; allKeys?: boolean; encoders?: Set<string> } = {}) => rowById(id)!.args({ bitrateMbps: o.bitrateMbps ?? 12, allKeys: o.allKeys ?? false, encoders: o.encoders ?? null });

describe('codec table', () => {
  it('has unique ids and values, plain labels, and an encoder, extension and hint for every row', () => {
    expect(new Set(CODEC_TABLE.map((r) => r.id)).size).toBe(CODEC_TABLE.length);
    expect(new Set(CODEC_TABLE.map((r) => r.value)).size).toBe(CODEC_TABLE.length);
    for (const r of CODEC_TABLE) {
      expect(r.label.length, r.id).toBeLessThanOrEqual(24);
      expect(r.label, r.id).not.toMatch(/[()]/);
      // a row has an FFmpeg equivalent (encoders) unless the app is the only one that writes it
      if (r.route === 'ffmpeg') expect(r.encoders.length, r.id).toBeGreaterThan(0);
      if (r.route === 'own') expect(r.own, r.id).toBeTruthy();
      expect(['builtin-webcodecs', 'own', 'ffmpeg']).toContain(r.route);
      expect(r.ext, r.id).toMatch(/^[a-z0-9]+$/);
      expect(r.hint.length, r.id).toBeGreaterThan(5);
    }
  });
  it('uses the -compatible wording for trademarked names', () => {
    for (const r of CODEC_TABLE) {
      if (/ProRes/.test(r.label)) expect(r.label, r.id).toMatch(/ProRes-compatible/);
      if (/DXV/.test(r.label)) expect(r.label).toBe('DXV-compatible');
      if (/DNxHR/.test(r.label)) expect(r.label, r.id).toMatch(/DNxHR-compatible/);
      if (/CineForm/.test(r.label)) expect(r.label, r.id).toMatch(/CineForm-compat/);
    }
  });
  it('pairs audio with the container', () => {
    const audio = (id: string) => rowById(id)!.audio?.join(' ');
    expect(audio('prores')).toBe('-c:a pcm_s16le');
    expect(audio('ffv1')).toBe('-c:a flac');
    expect(audio('webm-alpha')).toMatch(/libopus/);
    expect(audio('h264')).toMatch(/aac/);
    expect(rowById('gif')!.audio).toBeNull();
  });
});

describe('exact FFmpeg arguments', () => {
  it('VJ formats', () => {
    expect(args('dxv')).toEqual(['-c:v', 'dxv', '-format', 'dxt1']);
    expect(args('hap')).toEqual(['-c:v', 'hap', '-format', 'hap']);
    expect(args('hap-alpha')).toEqual(['-c:v', 'hap', '-format', 'hap_alpha']);
    expect(args('hap-q')).toEqual(['-c:v', 'hap', '-format', 'hap_q']);
    expect(args('mjpeg')).toEqual(['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj422p']);
  });
  it('ProRes-compatible profiles keep the two original argument sets', () => {
    expect(args('prores')).toEqual(['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'ap10']);
    expect(args('prores4444')).toEqual(['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'ap10']);
    expect(args('prores-proxy')[3]).toBe('0');
    expect(args('prores-lt')[3]).toBe('1');
    expect(args('prores-standard')[3]).toBe('2');
    expect(args('prores-4444xq').slice(2, 6)).toEqual(['-profile:v', '5', '-pix_fmt', 'yuva444p10le']);
  });
  it('DNxHR, CineForm and lossless', () => {
    expect(args('dnxhr-hqx')).toEqual(['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le']);
    expect(args('dnxhr-444')).toEqual(['-c:v', 'dnxhd', '-profile:v', 'dnxhr_444', '-pix_fmt', 'yuv444p10le']);
    expect(args('cineform')).toEqual(['-c:v', 'cfhd', '-quality', 'high', '-pix_fmt', 'yuv422p10le']);
    expect(args('cineform-alpha')).toEqual(['-c:v', 'cfhd', '-quality', 'high', '-pix_fmt', 'gbrap12le']);
    expect(args('qtrle')).toEqual(['-c:v', 'qtrle', '-pix_fmt', 'argb']);
    expect(args('png')).toEqual(['-c:v', 'png', '-pix_fmt', 'rgba']);
    expect(args('ffv1')).toContain('bgra');
    expect(args('utvideo')).toEqual(['-c:v', 'utvideo', '-pix_fmt', 'gbrap']);
    expect(args('v210')).toEqual(['-c:v', 'v210', '-pix_fmt', 'yuv422p10le']);
  });
  it('delivery formats: bitrate, all-intra and the AV1 encoder that is present', () => {
    expect(args('h264', { bitrateMbps: 8 })).toEqual(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '8M', '-movflags', '+faststart']);
    expect(args('h264', { bitrateMbps: 8, allKeys: true })).toContain('-g');
    expect(args('h264-intra').slice(4, 6)).toEqual(['-g', '1']);
    expect(args('av1-ffmpeg', { encoders: new Set(['libsvtav1', 'libaom-av1']) })[1]).toBe('libsvtav1');
    expect(args('av1-ffmpeg', { encoders: new Set(['libaom-av1']) })[1]).toBe('libaom-av1');
    expect(args('webm-alpha', { bitrateMbps: 3 })).toEqual(['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '3M']);
  });
  it('animated pictures', () => {
    expect(args('gif')[0]).toBe('-vf');
    expect(args('gif')[1]).toBe('split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128');
    expect(rowById('gif')!.args({ bitrateMbps: 1, allKeys: false, encoders: null, dither: 'floyd_steinberg' })[1]).toContain('dither=floyd_steinberg:alpha_threshold');
    expect(args('apng')).toEqual(['-c:v', 'apng', '-plays', '0', '-pix_fmt', 'rgba', '-f', 'apng']);
    expect(args('webp-anim')).toContain('-loop');
  });
  it('builds a whole command (ffmpegArgsFor)', () => {
    const base = { width: 64, height: 48, fps: 24, out: 'o.mov' };
    expect(ffmpegArgsFor('dxv', base)).toEqual(['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '64x48', '-r', '24', '-i', 'pipe:0', '-map', '0:v', '-r', '24', '-c:v', 'dxv', '-format', 'dxt1', 'o.mov']);
    const withAudio = ffmpegArgsFor('prores', { ...base, audio: { file: 'a.f32', sampleRate: 48000, channels: 2 }, frames: 12 });
    expect(withAudio).toEqual(expect.arrayContaining(['-i', 'a.f32', '-map', '1:a', '-frames:v', '12', '-c:a', 'pcm_s16le', '-shortest']));
    expect(ffmpegArgsFor('gif', { ...base, out: 'o.gif', audio: { file: 'a.f32', sampleRate: 48000, channels: 2 } })).not.toContain('-shortest');
    expect(ffmpegArgsFor('wav', { ...base, out: 'o.wav', audio: { file: 'a.f32', sampleRate: 44100, channels: 1 } }).slice(-4)).toEqual(['-vn', '-c:a', 'pcm_s16le', 'o.wav']);
    expect(ffmpegArgsFor('dxv', { ...base, input: { pattern: 'in.mov' } })).toContain('in.mov');
    expect(() => ffmpegArgsFor('nope', base)).toThrow(/Unknown codec/);
  });
});

describe('routing and availability', () => {
  it('routes the new values through FFmpeg and keeps the built-in ones off it', () => {
    for (const v of ['dxv', 'prores', 'dnxhr-hq', 'ffv1', 'h264_intra', 'av1_ffmpeg', 'vp8', 'webp_anim', 'qtrle']) {
      expect(needsFfmpeg(v), v).toBe(true);
      expect(videoRoute(v, true), v).toBe('ffmpeg');
      expect(videoRoute(v, false), v).toBe('missing');
    }
    // formats with an encoder of the app are written by the app, with or without FFmpeg: ONE entry, the route chosen here
    for (const v of ['hap', 'hap_alpha', 'hap_q', 'mjpeg', 'png-mov', 'raw-mov', 'gif', 'apng']) {
      expect(needsFfmpeg(v), v).toBe(false);
      expect(videoRoute(v, true), v).toBe('own');
      expect(videoRoute(v, false), v).toBe('own');
      expect(rowByValue(v)!.route, v).toBe('own');
    }
    for (const v of ['avc', 'hevc', 'vp9', 'av1']) expect(videoRoute(v, false), v).toBe('webcodecs');
    expect(ffmpegOnlyCodec('dxv')).toMatchObject({ id: 'dxv', alpha: false, even: true, ext: 'mov', encoders: ['dxv'], bitrate: false });
    expect(ffmpegOnlyCodec('hap_alpha')).toBeNull(); // own route
    expect(ffmpegOnlyCodec('qtrle')).toMatchObject({ id: 'qtrle', alpha: true });
    expect(ffmpegOnlyCodec('nonsense')).toBeNull();
  });
  it('knows when an encoder is missing, and claims nothing when the list is unknown', () => {
    const dxv = ffmpegOnlyCodec('dxv')!;
    expect(encoderMissing(dxv, ['prores_ks'])).toBe(true);
    expect(encoderMissing(dxv, ['dxv'])).toBe(false);
    expect(encoderMissing(dxv, new Set(['hap']))).toBe(true);
    expect(encoderMissing(dxv, null)).toBe(false);
    expect(encoderMissing(ffmpegOnlyCodec('av1_ffmpeg')!, ['libaom-av1'])).toBe(false);
  });
  it('refuses a picture smaller than DNxHR accepts', () => {
    expect(minSizeMessage('DNxHR-compatible HQ', rowById('dnxhr-hq')!.minSize, 128, 72)).toMatch(/at least 256x120/);
    expect(minSizeMessage('DNxHR-compatible HQ', rowById('dnxhr-hq')!.minSize, 1920, 1080)).toBe('');
    expect(minSizeMessage('DXV-compatible', undefined, 8, 8)).toBe('');
  });
});

describe('everything stays in step with the table', () => {
  it('the Output node codec list is exactly the wired video and animated rows, in order, with the table labels', () => {
    const p = outputNode().params.codec as { options: { value: string; label: string }[] };
    expect(p.options).toEqual(VIDEO_ROWS.map((r) => ({ value: r.value, label: r.label })));
    expect(FFMPEG_CODEC_VALUES).toEqual(VIDEO_ROWS.filter((r) => r.route === 'ffmpeg').map((r) => r.value));
  });
  it('the Output node Image format list is exactly the still rows, and the Audio Output Sound file list the sound rows', () => {
    const p = outputNode().params.imageFormat as { options: { value: string; label: string }[] };
    expect(p.options).toEqual(STILL_ROWS.map((r) => ({ value: r.value, label: r.label })));
    const reg = new Registry();
    registerBuiltins(reg);
    const a = reg.get('audio-out')!.params.soundFormat as { options: { value: string; label: string }[]; default: string };
    expect(a.options).toEqual(AUDIO_ROWS.map((r) => ({ value: r.value, label: r.label })));
    expect(a.default).toBe('wav32f');
  });
  it('the registry counts per route and family add up', () => {
    const c = registryCounts();
    expect(c.byRoute.own + c.byRoute.ffmpeg + c.byRoute['builtin-webcodecs']).toBe(WIRED_ROWS.length);
    expect(c.byKind.video + c.byKind.animated + c.byKind.still + c.byKind.audio).toBe(WIRED_ROWS.length);
    expect(c.byRoute.own).toBeGreaterThanOrEqual(24);
  });
  it('stills and sound rows are found by value, id, extension and alias', () => {
    expect(stillRow('png')!.route).toBe('builtin-webcodecs');
    expect(stillRow('tif')!.value).toBe('tiff');
    expect(stillRow('jpg')!.value).toBe('jpeg');
    expect(stillRow('exr')).toMatchObject({ float: true, route: 'own', alpha: true });
    expect(stillRow('hdr')).toMatchObject({ float: true, alpha: false });
    expect(stillRow('dpx')!.route).toBe('ffmpeg');
    expect(stillRow('nonsense')).toBeNull();
    expect(audioRow('wav16')!.id).toBe('wav');
    expect(audioRow('webm')!.id).toBe('webm-opus');
    expect(audioRow('mp3')!.route).toBe('ffmpeg');
  });
  it('the Output node shows Bitrate and All key frames exactly for the rows that take a bitrate', () => {
    expect([...BITRATE_CODECS].sort()).toEqual(VIDEO_ROWS.filter((r) => r.bitrate).map((r) => r.value).sort());
    const def = outputNode();
    for (const r of VIDEO_ROWS) {
      expect((def.params.bitrate as { visibleIf: (p: Record<string, unknown>) => boolean }).visibleIf({ codec: r.value }), r.value).toBe(r.bitrate);
    }
  });
  it('the CLI knows every video and animated row, with its own flags and aliases', () => {
    const rows = CODEC_TABLE.filter((r) => r.kind === 'video' || r.kind === 'animated');
    expect(Object.keys(CODECS)).toEqual(rows.map((r) => r.id));
    for (const r of rows) {
      expect(parseCodec(r.id), r.id).toBe(r.id);
      expect(parseCodec(r.value), r.value).toBe(r.id);
      expect(CODECS[r.id].args(12), r.id).toEqual(r.args({ bitrateMbps: 12, allKeys: false, encoders: null }));
    }
    expect(parseCodec('dxv')).toBe('dxv');
    expect(parseCodec('hap')).toBe('hap');
    expect(parseCodec('hap-alpha')).toBe('hap-alpha');
    expect(parseCodec('HAP_ALPHA')).toBe('hap-alpha');
    expect(parseCodec('avc')).toBe('h264');
    expect(parseCodec('png-mov')).toBe('png');
    expect(parseCodec('wav')).toBeNull(); // audio rows are not video codecs
    expect(parseCodec('nonsense')).toBeNull();
  });
  it('docs/CLI.md names every video and animated codec', () => {
    const doc = readFileSync(new URL('../../docs/CLI.md', import.meta.url), 'utf8');
    for (const r of CODEC_TABLE.filter((x) => x.kind === 'video' || x.kind === 'animated')) expect(doc, r.id).toContain(`\`${r.id}\``);
  });
  it('--for knows the video presets and keeps "web" for both families', () => {
    expect(parseForFlag('vj')).toEqual({ videoFor: 'vj' });
    expect(parseForFlag('editing')).toEqual({ videoFor: 'editing' });
    expect(parseForFlag('web')).toEqual({ preset: 'web', videoFor: 'web' });
    expect(parseForFlag('godot')).toEqual({ preset: 'godot' });
    expect(() => parseForFlag('nope')).toThrow(/Unknown --for/);
  });
  it('every rowByValue lookup round-trips', () => {
    for (const r of CODEC_TABLE) expect(rowByValue(r.value)).toBe(r);
  });
});
