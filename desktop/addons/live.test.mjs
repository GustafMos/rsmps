import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { LiveError, createLiveService, explainFailure, liveArgs, liveTarget, parseProgress, redact } from './live.mjs';

const KEY = 'live_123456789_AbCdEfGhIjKlMnOpQrStUv';

describe('where the stream goes', () => {
  it('a known service needs only the key; secure address when FFmpeg has TLS, plain otherwise', () => {
    expect(liveTarget({ service: 'twitch', key: KEY }).url).toBe(`rtmps://live.twitch.tv:443/app/${KEY}`);
    expect(liveTarget({ service: 'twitch', key: ` ${KEY} ` }, false).url).toBe(`rtmp://live.twitch.tv/app/${KEY}`);
    expect(liveTarget({ service: 'youtube', key: 'abcd-efgh-ijkl-mnop-qrst' }).url).toBe('rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl-mnop-qrst');
    expect(liveTarget({ service: 'twitch', key: KEY }).secrets).toEqual([KEY]);
  });
  it('refuses a missing or odd key, an unknown service, and addresses that are not rtmp', () => {
    expect(() => liveTarget({ service: 'twitch', key: '' })).toThrow(/stream key/);
    expect(() => liveTarget({ service: 'twitch', key: 'abc def; rm -rf /' })).toThrow(LiveError);
    expect(() => liveTarget({ service: 'nope', key: KEY })).toThrow(/Unknown/);
    for (const url of ['http://example.com/live', 'file:///etc/passwd', 'rtmp://', 'rtmp://host', '-f lavfi rtmp://x/y']) expect(() => liveTarget({ service: 'custom', url }), url).toThrow(LiveError);
    expect(() => liveTarget({ service: 'custom', url: 'rtmps://example.com/live' }, false)).toThrow(/secure/);
  });
  it('a custom address may carry the key or get it appended; both are treated as secret', () => {
    const a = liveTarget({ service: 'custom', url: 'rtmp://example.com/live/', key: 'secretkey1' });
    expect(a.url).toBe('rtmp://example.com/live/secretkey1');
    const b = liveTarget({ service: 'custom', url: 'rtmp://example.com/live/secretkey2' });
    expect(redact(`Opening ${b.url} for writing`, b.secrets)).toBe('Opening rtmp://example.com/live/••• for writing');
    expect(redact(`x ${a.url} y ${KEY}`, [...a.secrets, KEY])).not.toMatch(/secretkey1|live_1234/);
  });
});

describe('FFmpeg arguments', () => {
  const base = { width: 1280, height: 720, fps: 30, videoKbps: 4500, audioKbps: 160, hasAudio: true, encoder: 'libx264', url: 'rtmp://h/app/k' };
  it('H.264 at a constant bitrate with a key frame every 2 seconds, AAC, FLV, picture fitted into the frame', () => {
    const a = liveArgs(base).join(' ');
    expect(a).toContain('-i pipe:0');
    expect(a).toContain('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720');
    expect(a).toContain('fps=30,format=yuv420p');
    expect(a).toContain('keyint=60:min-keyint=60:scenecut=0');
    expect(a).toContain('-b:v 4500k -maxrate 4500k -bufsize 9000k');
    expect(a).toContain('-c:a aac -b:a 160k -ar 48000 -ac 2');
    expect(a).toMatch(/-map 0:v:0 -map 0:a:0/);
    expect(a.endsWith('-f flv rtmp://h/app/k')).toBe(true);
  });
  it('a recording without sound gets a silent track; hardware encoders get a plain key-frame interval', () => {
    const quiet = liveArgs({ ...base, hasAudio: false }).join(' ');
    expect(quiet).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(quiet).toContain('-map 0:v:0 -map 1:a:0');
    expect(quiet).toContain('-shortest');
    const hw = liveArgs({ ...base, encoder: 'h264_nvenc', fps: 60 }).join(' ');
    expect(hw).toContain('-c:v h264_nvenc -g 120');
    expect(hw).not.toContain('x264-params');
  });
});

describe('reading FFmpeg', () => {
  it('progress lines', () => {
    expect(parseProgress('frame=  120 fps= 30 q=23.0 size=    1280kB time=00:00:04.00 bitrate=2621.4kbits/s speed=1.01x')).toEqual({ frames: 120, fps: 30, seconds: 4, kbps: 2621.4, speed: 1.01 });
    expect(parseProgress('frame=    3 fps=0.0 q=0.0 size=       0kB time=01:02:03.50 bitrate=N/A speed=N/A')).toMatchObject({ frames: 3, seconds: 3723.5, kbps: 0, speed: 0 });
    expect(parseProgress('Stream mapping:')).toBeNull();
  });
  it('failures in plain words', () => {
    expect(explainFailure(['[tcp @ 0x1] Connection to tcp://live.twitch.tv:1935 failed: Connection refused'])).toMatch(/reach the streaming server/);
    expect(explainFailure(['[rtmp @ 0x1] Server error: Publishing denied', 'av_interleaved_write_frame(): Broken pipe', 'Error writing trailer of rtmp://x/app/•••'])).toMatch(/stream key/);
    expect(explainFailure(["Unknown encoder 'libx264'"])).toMatch(/H\.264/);
    expect(explainFailure(['something odd happened'])).toBe('FFmpeg stopped: something odd happened');
    expect(explainFailure([])).toBe('FFmpeg stopped unexpectedly.');
  });
});

/** A stand-in for the FFmpeg process. */
function fakeProc() {
  const p = new EventEmitter();
  p.stdin = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = () => p.emit('close', null);
  p.stdin.on('finish', () => setTimeout(() => p.emit('close', 0), 5));
  return p;
}
const svc = (opts = {}) => {
  const procs = [];
  const calls = [];
  const service = createLiveService({
    binary: async () => ('bin' in opts ? opts.bin : '/x/ffmpeg'),
    probe: async () => opts.caps ?? { encoders: new Set(['libx264']), tls: true },
    spawn: (bin, args) => {
      calls.push({ bin, args });
      const p = fakeProc();
      procs.push(p);
      return p;
    },
  });
  return { service, procs, calls };
};
const START = { service: 'twitch', key: KEY, width: 1280, height: 720, fps: 30, videoKbps: 4500, hasAudio: true };

describe('the stream session', () => {
  it('starts FFmpeg with the address, takes the pieces in order and never shows the key', async () => {
    const { service, procs, calls } = svc();
    const r = await service.start(START);
    expect(r).toMatchObject({ encoder: 'libx264', secure: true });
    expect(calls[0].args.at(-1)).toBe(`rtmps://live.twitch.tv:443/app/${KEY}`);
    const got = [];
    procs[0].stdin.on('data', (d) => got.push(d.toString()));
    await Promise.all([service.chunk(r.id, Buffer.from('one')), service.chunk(r.id, Buffer.from('two')), service.chunk(r.id, Buffer.from('three'))]);
    expect(got.join('')).toBe('onetwothree');
    procs[0].stderr.write(`Output #0, flv, to 'rtmps://live.twitch.tv:443/app/${KEY}':\nframe=   60 fps= 30 q=20.0 size=  500kB time=00:00:02.00 bitrate=2048.0kbits/s speed=1.00x\r`);
    await new Promise((res) => setTimeout(res, 10));
    const st = service.status();
    expect(st.current).toMatchObject({ live: true, seconds: 2, fps: 30, kbps: 2048, bytes: 11, error: null });
    expect(JSON.stringify(st)).not.toContain(KEY);
    const stopped = await service.stop(r.id);
    expect(stopped.stopped).toBe(true);
    expect(stopped.current).toBeNull();
    expect(stopped.last).toMatchObject({ live: false, error: null });
    expect(service.active).toBe(false);
  });
  it('one stream at a time; settings are checked before anything starts', async () => {
    const { service, calls } = svc();
    await service.start(START);
    await expect(service.start(START)).rejects.toThrow(/already running/);
    await service.stop();
    await expect(service.start({ ...START, width: 99999 })).rejects.toThrow(/Width/);
    await expect(service.start({ ...START, fps: 0 })).rejects.toThrow(/Frame rate/);
    await expect(service.start({ ...START, key: '' })).rejects.toThrow(/stream key/);
    expect(calls).toHaveLength(1);
  });
  it('says what is missing: no FFmpeg, no H.264 encoder; falls back to rtmp without TLS and to a hardware encoder', async () => {
    await expect(svc({ bin: null }).service.start(START)).rejects.toThrow(/FFmpeg is not set up/);
    await expect(svc({ caps: { encoders: new Set(), tls: true } }).service.start(START)).rejects.toThrow(/H\.264 encoder/);
    const { service, calls } = svc({ caps: { encoders: new Set(['h264_nvenc', 'libopenh264']), tls: false } });
    const r = await service.start(START);
    expect(r).toMatchObject({ encoder: 'h264_nvenc', secure: false });
    expect(calls[0].args.at(-1)).toBe(`rtmp://live.twitch.tv/app/${KEY}`);
  });
  it('when FFmpeg dies the reason is kept (without the key) and further pieces are refused', async () => {
    const { service, procs } = svc();
    const r = await service.start(START);
    procs[0].stderr.write(`[rtmp @ 0x1] Server error: Publishing denied for ${KEY}\nav_interleaved_write_frame(): Broken pipe\n`);
    await new Promise((res) => setTimeout(res, 10));
    procs[0].emit('close', 1);
    const st = service.status();
    expect(st.current).toBeNull();
    expect(st.last.error).toMatch(/stream key may be wrong/);
    expect(JSON.stringify(st)).not.toContain(KEY);
    await expect(service.chunk(r.id, Buffer.from('x'))).rejects.toThrow(/stream key may be wrong/);
    await service.start(START); // a new stream can start afterwards
    expect(service.active).toBe(true);
  });
});

/* ---- the real thing: FFmpeg receives what the service sends, over RTMP on this machine ---- */
const FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const canRun = FFMPEG.status === 0 && / libx264 /.test(FFMPEG.stdout) && / libvpx /.test(FFMPEG.stdout);
const dir = mkdtempSync(join(tmpdir(), 'rsmps-live-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!canRun)('end to end with FFmpeg', () => {
  it('a WebM recording with sound arrives at an RTMP server as H.264 + AAC', async () => {
    const port = await freePort();
    const out = join(dir, 'received.flv');
    // the "streaming service": FFmpeg listening for one RTMP publisher, saving what it gets
    const server = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-timeout', '20', '-i', `rtmp://127.0.0.1:${port}/live/testkey12`, '-c', 'copy', '-y', out], { stdio: 'ignore' });
    const serverDone = new Promise((resolve) => server.on('close', resolve));
    await new Promise((res) => setTimeout(res, 700));
    const service = createLiveService({ binary: async () => 'ffmpeg' });
    const r = await service.start({ service: 'custom', url: `rtmp://127.0.0.1:${port}/live`, key: 'testkey12', width: 640, height: 360, fps: 30, videoKbps: 800, hasAudio: true });
    // the "MediaRecorder": 4 seconds of picture and a 440 Hz tone as WebM, produced in real time
    const rec = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=480x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-c:a', 'libopus', '-f', 'webm', '-cluster_time_limit', '250', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let sent = 0;
    for await (const piece of rec.stdout) {
      await service.chunk(r.id, piece);
      sent += piece.length;
    }
    expect(sent).toBeGreaterThan(50_000);
    const mid = service.status().current;
    expect(mid.live).toBe(true);
    const end = await service.stop(r.id);
    expect(end.last.error).toBeNull();
    await serverDone;
    expect(existsSync(out) && statSync(out).size).toBeGreaterThan(50_000);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,sample_rate:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout);
    const v = info.streams.find((s) => s.codec_name === 'h264');
    const a = info.streams.find((s) => s.codec_name === 'aac');
    expect(v).toMatchObject({ width: 640, height: 360 });
    expect(a).toMatchObject({ sample_rate: '48000' });
    expect(Number(info.format.duration)).toBeGreaterThan(3);
    expect(Number(info.format.duration)).toBeLessThan(5.5);
  }, 60_000);

  it('a recording without sound still arrives with a (silent) sound track, and a dead address is reported in words', async () => {
    const port = await freePort();
    const out = join(dir, 'silent.flv');
    const server = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-timeout', '20', '-i', `rtmp://127.0.0.1:${port}/live/testkey12`, '-c', 'copy', '-y', out], { stdio: 'ignore' });
    const serverDone = new Promise((resolve) => server.on('close', resolve));
    await new Promise((res) => setTimeout(res, 700));
    const service = createLiveService({ binary: async () => 'ffmpeg' });
    const r = await service.start({ service: 'custom', url: `rtmp://127.0.0.1:${port}/live/testkey12`, width: 320, height: 180, fps: 15, videoKbps: 400, hasAudio: false });
    const rec = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '3', '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'webm', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    for await (const piece of rec.stdout) await service.chunk(r.id, piece);
    await service.stop(r.id);
    await serverDone;
    const info = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', out], { encoding: 'utf8' }).stdout);
    expect(info.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);

    const dead = createLiveService({ binary: async () => 'ffmpeg' });
    const d = await dead.start({ service: 'custom', url: `rtmp://127.0.0.1:${await freePort()}/live/nokey123`, width: 320, height: 180, fps: 15, videoKbps: 400, hasAudio: false });
    const rec2 = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let failed = null;
    try {
      for await (const piece of rec2.stdout) await dead.chunk(d.id, piece);
      await new Promise((res) => setTimeout(res, 1500));
      await dead.chunk(d.id, Buffer.from([0]));
    } catch (err) {
      failed = err;
    }
    expect(failed?.message ?? dead.status().last?.error).toMatch(/reach the streaming server/);
    expect(dead.active).toBe(false);
  }, 60_000);
});
