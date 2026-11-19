import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { HapConvertError, MAX_PIECE, createHapConvertService, explainFailure, hapArgs, hapEstimateBytes, hapPlan, hasHapEncoder, parseTime } from './hap-convert.mjs';

const root = mkdtempSync(join(tmpdir(), 'rsmps-hapconv-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for FFmpeg: records how it was started; the test decides what it prints and how it ends. */
function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args) => {
    const proc = new EventEmitter();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit('close', null);
    };
    calls.push({ bin, args, proc });
    return proc;
  };
  return { spawn, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const START = { format: 'hap', width: 1920, height: 1080, maxSide: 1280, duration: 10, fps: 30, ext: 'mp4' };

describe('the plan', () => {
  it('scales down, never up, to sides that are multiples of 4', () => {
    expect(hapPlan(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(hapPlan(1920, 1080, 3840)).toEqual({ width: 1920, height: 1080 });
    expect(hapPlan(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
    expect(hapPlan(853, 481, 3840)).toEqual({ width: 852, height: 480 });
    expect(hapPlan(2, 1, 1280)).toEqual({ width: 4, height: 4 });
    for (const [w, h, m] of [[1366, 768, 1280], [4096, 2160, 1920], [641, 359, 640]]) {
      const p = hapPlan(w, h, m);
      expect(p.width % 4 + p.height % 4).toBe(0);
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(Math.ceil(Math.min(m, Math.max(w, h)) / 4) * 4);
    }
  });
  it('estimates the size: HAP half a byte per pixel, HAP Q and HAP Alpha a whole one', () => {
    expect(hapEstimateBytes('hap', 1920, 1080, 30)).toBe(1920 * 1080 * 0.5 * 30);
    expect(hapEstimateBytes('hap_q', 1920, 1080, 30)).toBe(1920 * 1080 * 30);
    expect(hapEstimateBytes('hap_alpha', 1920, 1080, 30)).toBe(1920 * 1080 * 30);
  });
  it('FFmpeg arguments: HAP of the chosen kind, the sound (when there is one) as PCM, in a MOV', () => {
    const a = hapArgs({ input: '/w/in.mp4', output: '/w/out.mov', format: 'hap_q', width: 1280, height: 720 }).join(' ');
    expect(a).toContain('-i /w/in.mp4');
    expect(a).toContain('-map 0:v:0 -map 0:a:0?');
    expect(a).toContain('-vf scale=1280:720:flags=bicubic');
    expect(a).toContain('-c:v hap -format hap_q');
    expect(a).toContain('-c:a pcm_s16le');
    expect(a.endsWith('-f mov /w/out.mov')).toBe(true);
  });
  it('reads progress lines and explains common failures', () => {
    expect(parseTime('frame=  120 fps= 30 q=-0.0 size=   10240KiB time=00:00:04.00 bitrate=20971.5kbits/s speed=1.00x')).toBe(4);
    expect(parseTime('frame=    1 fps=0.0 q=-0.0 size=       0KiB time=01:02:03.50 bitrate=N/A')).toBe(3723.5);
    expect(parseTime('Stream mapping:')).toBeNull();
    expect(explainFailure(["Unknown encoder 'hap'"])).toMatch(/cannot write HAP/);
    expect(explainFailure(['av_interleaved_write_frame(): No space left on device'])).toMatch(/disk is full/);
    expect(explainFailure(['in.bin: Invalid data found when processing input'])).toMatch(/could not read this clip/);
    expect(explainFailure(['frame= 1 fps=0 time=00:00:00.04', 'Something odd happened'])).toBe('FFmpeg stopped: Something odd happened');
    expect(explainFailure([])).toBe('FFmpeg stopped unexpectedly.');
  });
  it('finds the hap encoder in the list FFmpeg prints, and only that one', () => {
    expect(hasHapEncoder(' V....D hap                  Vidvox Hap\n V....D h264_nvenc   x')).toBe(true);
    expect(hasHapEncoder(' V....D libx264              H.264\n A....D hap                  not video\n V....D hapless x')).toBe(false);
    expect(hasHapEncoder('')).toBe(false);
  });
});

describe('a conversion, with a stand-in for FFmpeg', () => {
  const make = (over = {}) => {
    const f = fakeSpawn();
    const svc = createHapConvertService({ tmpRoot: join(root, 'jobs'), binary: async () => '/bin/ffmpeg', spawn: f.spawn, probe: async () => true, ...over });
    return { ...f, svc };
  };

  it('says what is possible: no FFmpeg, an FFmpeg without HAP, an FFmpeg with HAP', async () => {
    expect(await make({ binary: async () => null }).svc.info()).toEqual({ available: false, hap: false });
    expect(await make({ probe: async () => false }).svc.info()).toEqual({ available: true, hap: false });
    expect(await make({ probe: async () => { throw new Error('x'); } }).svc.info()).toEqual({ available: true, hap: false });
    expect(await make().svc.info()).toEqual({ available: true, hap: true });
  });

  it('upload, run, progress, download in pieces, clean up', async () => {
    const { svc, calls } = make();
    const job = await svc.start(START);
    expect(job).toMatchObject({ width: 1280, height: 720, estimate: 1280 * 720 * 0.5 * 300 });
    expect(svc.chunk(job.id, Buffer.from('abc'))).toEqual({ bytes: 3 });
    expect(svc.chunk(job.id, Buffer.from('defg'))).toEqual({ bytes: 7 });
    expect(svc.status(job.id)).toMatchObject({ state: 'uploading', fraction: 0 });
    expect(svc.run(job.id)).toMatchObject({ state: 'running', fraction: 0 });
    expect(calls).toHaveLength(1);
    const { bin, args, proc } = calls[0];
    expect(bin).toBe('/bin/ffmpeg');
    const input = args[args.indexOf('-i') + 1];
    const output = args[args.length - 1];
    expect(readFileSync(input, 'utf8')).toBe('abcdefg'); // the pieces arrived in order, in a file of the service's own choosing
    expect(input.startsWith(join(root, 'jobs'))).toBe(true);
    expect(input.endsWith('in.mp4')).toBe(true);
    expect(args.join(' ')).toContain('scale=1280:720');
    // progress lines arrive split across writes, as they do from a real process
    proc.stderr.write('frame=  75 fps= 30 q=-0.0 size=  100KiB time=00:00:0');
    proc.stderr.write('2.50 bitrate=1.0kbits/s speed=1x\r');
    await tick();
    expect(svc.status(job.id)).toMatchObject({ state: 'running', fraction: 0.25 });
    proc.stderr.write('frame= 300 fps= 30 q=-0.0 size=  400KiB time=00:00:10.00 bitrate=1.0kbits/s speed=1x\r');
    await tick();
    expect(svc.status(job.id).fraction).toBe(0.99); // never "done" before FFmpeg has really finished the file
    expect(() => svc.read(job.id, 0, 10)).toThrow(/not finished/);
    writeFileSync(output, Buffer.from('0123456789'));
    proc.emit('close', 0);
    expect(svc.status(job.id)).toMatchObject({ state: 'done', fraction: 1, bytes: 10, error: null });
    expect(existsSync(input)).toBe(false); // the uploaded copy is deleted as soon as it is not needed
    expect(svc.read(job.id, 0, 4).toString()).toBe('0123');
    expect(svc.read(job.id, 4, 100).toString()).toBe('456789');
    expect(() => svc.read(job.id, 10, 1)).toThrow(/outside/);
    expect(() => svc.read(job.id, 0, MAX_PIECE + 1)).toThrow(/piece/);
    expect(svc.cancel(job.id)).toEqual({ canceled: true });
    expect(existsSync(output)).toBe(false);
    expect(() => svc.status(job.id)).toThrow(/Unknown or finished/);
    expect(readdirSync(join(root, 'jobs'))).toEqual([]);
  });

  it('cancel while FFmpeg runs kills it and removes the work folder', async () => {
    const { svc, calls } = make();
    const job = await svc.start(START);
    svc.chunk(job.id, Buffer.from('x'));
    svc.run(job.id);
    svc.cancel(job.id);
    expect(calls[0].proc.killed).toBe(true);
    expect(svc.jobs.size).toBe(0);
    expect(readdirSync(join(root, 'jobs'))).toEqual([]);
  });

  it('a failing FFmpeg is reported in plain words, and the job can still be cleaned up', async () => {
    const { svc, calls } = make();
    const job = await svc.start(START);
    svc.chunk(job.id, Buffer.from('x'));
    svc.run(job.id);
    calls[0].proc.stderr.write('in.mp4: Invalid data found when processing input\n');
    await tick();
    calls[0].proc.emit('close', 1);
    expect(svc.status(job.id)).toMatchObject({ state: 'error', error: 'FFmpeg could not read this clip.' });
    expect(() => svc.read(job.id, 0, 1)).toThrow(/could not read this clip/);
    svc.cancel(job.id);
    // FFmpeg that cannot even start
    const boom = make({ spawn: () => { throw new Error('ENOENT'); } });
    const j2 = await boom.svc.start(START);
    boom.svc.chunk(j2.id, Buffer.from('x'));
    expect(boom.svc.run(j2.id)).toMatchObject({ state: 'error', error: 'FFmpeg could not start: ENOENT' });
    boom.svc.disposeAll();
    // FFmpeg that ends well but wrote nothing
    const empty = make();
    const j3 = await empty.svc.start(START);
    empty.svc.chunk(j3.id, Buffer.from('x'));
    empty.svc.run(j3.id);
    empty.calls[0].proc.emit('close', 0);
    expect(empty.svc.status(j3.id)).toMatchObject({ state: 'error', error: 'FFmpeg wrote an empty file.' });
    empty.svc.disposeAll();
  });

  it('refuses what it should: bad input, wrong order, no FFmpeg, no HAP encoder, a result that would be huge', async () => {
    const { svc } = make();
    await expect(svc.start({ ...START, format: 'h264' })).rejects.toThrow(/Unknown HAP kind/);
    await expect(svc.start({ ...START, format: 'constructor' })).rejects.toThrow(HapConvertError);
    await expect(svc.start({ ...START, width: 0 })).rejects.toThrow(/Width/);
    await expect(svc.start({ ...START, height: 1.5 })).rejects.toThrow(/Height/);
    await expect(svc.start({ ...START, duration: -1 })).rejects.toThrow(/length/);
    await expect(svc.start({ ...START, fps: 0 })).rejects.toThrow(/frame rate/);
    await expect(svc.start({ ...START, format: 'hap_q', maxSide: 3840, width: 3840, height: 2160, duration: 600 })).rejects.toThrow(/GB.*smaller size/);
    await expect(make({ binary: async () => null }).svc.start(START)).rejects.toMatchObject({ status: 409 });
    await expect(make({ probe: async () => false }).svc.start(START)).rejects.toThrow(/cannot write HAP/);
    // an extension from the page never becomes part of a path unless it is plain letters and digits
    const odd = await svc.start({ ...START, ext: '../../x' });
    svc.chunk(odd.id, Buffer.from('x'));
    expect(svc.jobs.get(odd.id).input.endsWith('in.bin')).toBe(true);
    expect(() => svc.chunk(odd.id, Buffer.alloc(0))).toThrow(/piece/);
    expect(() => svc.chunk('nope', Buffer.from('x'))).toThrow(/Unknown or finished/);
    const emptyJob = await svc.start(START);
    expect(() => svc.run(emptyJob.id)).toThrow(/empty/);
    svc.run(odd.id);
    expect(() => svc.run(odd.id)).toThrow(/already started/);
    expect(() => svc.chunk(odd.id, Buffer.from('x'))).toThrow(/already handed over/);
    await svc.start(START);
    await svc.start(START);
    await expect(svc.start(START)).rejects.toThrow(/Too many/);
    svc.disposeAll();
    expect(svc.jobs.size).toBe(0);
    expect(readdirSync(join(root, 'jobs'))).toEqual([]);
  });
});

// The real thing, when this machine has an FFmpeg that can write HAP (CI may not).
const realFfmpeg = (() => {
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return r.status === 0 && hasHapEncoder(r.stdout) ? 'ffmpeg' : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!realFfmpeg)('a conversion with a real FFmpeg', () => {
  for (const format of ['hap', 'hap_q', 'hap_alpha']) {
    it(`${format}: an H.264 clip with sound becomes a HAP MOV of the planned size, sound kept as PCM`, async () => {
      const src = join(root, `src-${format}.mp4`);
      const made = spawnSync(realFfmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=322x182:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
      if (made.status !== 0) return; // this FFmpeg has no H.264 encoder to make the source with: nothing to convert
      const svc = createHapConvertService({ tmpRoot: join(root, 'real'), binary: async () => realFfmpeg });
      expect(await svc.info()).toEqual({ available: true, hap: true });
      const job = await svc.start({ format, width: 322, height: 182, maxSide: 3840, duration: 1, fps: 25, ext: 'mp4' });
      expect([job.width, job.height]).toEqual([324, 184]);
      const bytes = readFileSync(src);
      for (let at = 0; at < bytes.length; at += 10000) svc.chunk(job.id, bytes.subarray(at, at + 10000));
      svc.run(job.id);
      let st = svc.status(job.id);
      for (let i = 0; i < 400 && st.state === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 25));
        st = svc.status(job.id);
      }
      expect(st).toMatchObject({ state: 'done', fraction: 1, error: null });
      const parts = [];
      for (let at = 0; at < st.bytes; at += 50000) parts.push(svc.read(job.id, at, 50000));
      const out = join(root, `out-${format}.mov`);
      writeFileSync(out, Buffer.concat(parts));
      const probe = spawnSync(realFfmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string,width,height,nb_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' });
      if (probe.status === 0) {
        const tag = { hap: 'Hap1', hap_q: 'HapY', hap_alpha: 'Hap5' }[format];
        expect(probe.stdout).toMatch(new RegExp(`hap,${tag},324,184,25`));
        expect(probe.stdout).toMatch(/pcm_s16le/);
      }
      svc.cancel(job.id);
      expect(readdirSync(join(root, 'real'))).toEqual([]);
    });
  }
});
