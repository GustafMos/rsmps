import { describe, expect, it } from 'vitest';
import { DesktopClient, baseName, desktopUrl, errorText, isDesktop, parseAddon, parseAddonList, parseExportFinish, parseExportInfo, parseExportStart, parseLanInfo, phoneSocketUrl } from './desktop';
import { FFMPEG_CODEC_VALUES, ffmpegFallbackCodec, ffmpegOnlyCodec, needsFfmpeg, videoRoute } from './export-codecs';
import { desktopAddresses, startFailure } from './phone';

describe('desktop helpers', () => {
  it('detects the packaged app by its page protocol only', () => {
    expect(isDesktop({ protocol: 'app:' })).toBe(true);
    expect(isDesktop({ protocol: 'https:' })).toBe(false);
    expect(isDesktop({ protocol: 'http:' })).toBe(false);
    expect(isDesktop(undefined)).toBe(false);
  });
  it('builds urls and the desktop phone socket url', () => {
    expect(desktopUrl('lan-info')).toBe('app://rsmps/__rsmps/lan-info');
    expect(desktopUrl('/addons/ffmpeg/install', 'app://rsmps/__rsmps')).toBe('app://rsmps/__rsmps/addons/ffmpeg/install');
    expect(phoneSocketUrl('wss://127.0.0.1:4444', 'ab12')).toBe('wss://127.0.0.1:4444/__rsmps/phone-ws?role=desktop&token=ab12');
  });
  it('reads error bodies', () => {
    expect(errorText({ error: ' Nope ' }, 409)).toBe('Nope');
    expect(errorText({}, 500)).toContain('500');
  });
  it('parses lan-info, ignoring junk', () => {
    const i = parseLanInfo({
      lan: true,
      desktop: true,
      state: 'on',
      origins: ['https://192.168.0.5:20001', 5],
      candidates: [{ address: '192.168.0.5', adapter: 'Wi-Fi', kind: 'lan', label: 'Wi-Fi 192.168.0.5', url: 'https://192.168.0.5:20001' }, { nope: 1 }],
      port: 20001,
      ws: 'wss://127.0.0.1:20001',
    });
    expect(i.lan).toBe(true);
    expect(i.origins).toEqual(['https://192.168.0.5:20001']);
    expect(desktopAddresses(i)).toEqual([{ url: 'https://192.168.0.5:20001', label: 'Wi-Fi 192.168.0.5', kind: 'lan' }]);
    expect(parseLanInfo({ lan: true, state: 'off' }).lan).toBe(false); // lan is only true when the server is on
    expect(parseLanInfo(null).state).toBe('off');
  });
  it('explains a declined or failed start', () => {
    expect(startFailure(parseLanInfo({ state: 'off', declined: true })).declined).toBe(true);
    expect(startFailure(parseLanInfo({ state: 'error', error: 'Port busy' })).error).toBe('Port busy');
  });
  it('parses add-ons', () => {
    const a = parseAddon({
      id: 'ffmpeg',
      name: 'FFmpeg',
      title: 'T',
      description: 'D',
      homepage: 'https://ffmpeg.org',
      state: 'installing',
      download: { version: '9', size: 10, sizeLabel: '10 MB', host: 'github.com', license: { name: 'GPL', url: 'https://x' }, source: { name: 'S', url: 'https://s' }, sha256: 'ab', hashVerifiedByMaintainer: false },
      bringYourOwn: 'by hand',
      canLocate: true,
      installed: null,
      progress: { phase: 'verifying', received: 5, total: 10 },
    });
    expect(a.state).toBe('installing');
    expect(a.download?.license.name).toBe('GPL');
    expect(a.progress).toEqual({ phase: 'verifying', received: 5, total: 10 });
    expect(parseAddon({ id: 'x', state: 'weird' }).state).toBe('not-installed');
    expect(parseAddonList({ addons: [{ id: 'a' }, { nothing: 1 }] }).map((x) => x.id)).toEqual(['a']);
    expect(parseAddonList('junk')).toEqual([]);
  });
  it('parses export endpoints', () => {
    expect(parseExportInfo({ available: true, source: 'download', version: '9', codecs: [{ id: 'prores', label: 'P', ext: 'mov', alpha: false, even: false, audio: true }, {}], active: false }).codecs).toHaveLength(1);
    expect(() => parseExportStart({})).toThrow();
    expect(parseExportStart({ id: 'a', ext: 'mov', alpha: true, even: false, frameBytes: 16 }).frameBytes).toBe(16);
    expect(parseExportFinish({ saved: false, canceled: true })).toEqual({ saved: false, canceled: true });
    expect(baseName('C:\\Users\\me\\clip.mov')).toBe('clip.mov');
    expect(baseName('/home/me/clip.mov')).toBe('clip.mov');
  });
});

describe('DesktopClient', () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it('never calls fetch outside the desktop app', async () => {
    let called = 0;
    const c = new DesktopClient(async () => (called++, reply({})), undefined, () => false);
    await expect(c.lanInfo()).rejects.toThrow(/desktop/);
    await expect(c.info()).rejects.toThrow();
    expect(called).toBe(0);
  });
  it('POSTs with the right urls and turns error bodies into messages', async () => {
    const seen: string[] = [];
    const c = new DesktopClient(
      async (u, init) => {
        seen.push(`${init?.method ?? 'GET'} ${u}`);
        if (u.endsWith('/locate')) return reply({ error: 'That is not FFmpeg.' }, 400);
        return reply({ id: 'ffmpeg', state: 'installing' });
      },
      undefined,
      () => true,
    );
    const r = await c.addonAction('ffmpeg', 'install');
    expect(r.info.state).toBe('installing');
    await expect(c.addonAction('ffmpeg', 'locate')).rejects.toThrow('That is not FFmpeg.');
    expect(seen).toEqual(['POST app://rsmps/__rsmps/addons/ffmpeg/install', 'POST app://rsmps/__rsmps/addons/ffmpeg/locate']);
  });
});

describe('codec lookup', () => {
  it('marks the FFmpeg-only formats and maps them to endpoint ids', () => {
    expect(FFMPEG_CODEC_VALUES).toEqual(['prores', 'prores4444', 'qtrle', 'png-mov', 'webm-alpha']);
    expect(ffmpegOnlyCodec('png-mov')?.id).toBe('png');
    expect(ffmpegOnlyCodec('prores4444')).toMatchObject({ alpha: true, even: false, ext: 'mov' });
    expect(ffmpegOnlyCodec('webm-alpha')).toMatchObject({ alpha: true, even: true, ext: 'webm' });
    expect(ffmpegOnlyCodec('prores')?.alpha).toBe(false);
    for (const v of ['avc', 'hevc', 'vp9', 'av1']) expect(needsFfmpeg(v)).toBe(false);
  });
  it('allows H.264 / H.265 through FFmpeg only as a fallback', () => {
    expect(ffmpegFallbackCodec('avc')?.id).toBe('h264');
    expect(ffmpegFallbackCodec('hevc')?.id).toBe('hevc');
    expect(ffmpegFallbackCodec('vp9')).toBeNull();
    expect(videoRoute('avc', true)).toBe('webcodecs');
    expect(videoRoute('prores', true)).toBe('ffmpeg');
    expect(videoRoute('prores', false)).toBe('missing');
  });
});
