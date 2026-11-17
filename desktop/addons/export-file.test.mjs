import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExportError, createExportService } from './export.mjs';

const root = mkdtempSync(join(tmpdir(), 'rsmps-file-sink-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function service(target) {
  const asked = [];
  const svc = createExportService({ tmpRoot: join(root, 'tmp'), binary: async () => null, pickSavePath: async (name, ext) => (asked.push([name, ext]), target) });
  return { svc, asked };
}

describe('files the app writes itself (desktop export service)', () => {
  it('the path comes from the Save dialog only; chunks go to positions; the header can be patched at the end; finish reports the size', async () => {
    const target = join(root, 'a.mov');
    const { svc, asked } = service(target);
    const started = await svc.fileStart({ name: '../../etc/passwd', ext: 'mov!' });
    expect(started.saved).toBe(true);
    expect(started.path).toBe(target); // whatever the page sent, the dialog decided
    expect(asked).toEqual([['passwd', 'mov']]); // the name is reduced to a plain file name, the extension to letters and digits
    svc.fileWrite(started.id, 0, Buffer.from([0, 0, 0, 0, 9, 9]));
    svc.fileWrite(started.id, 6, Buffer.from('mdat-and-more'));
    svc.fileWrite(started.id, 0, Buffer.from([1, 2, 3, 4])); // the patch
    const done = svc.fileFinish(started.id);
    expect(done).toMatchObject({ saved: true, path: target, bytes: 19 });
    const bytes = readFileSync(target);
    expect(Array.from(bytes.subarray(0, 6))).toEqual([1, 2, 3, 4, 9, 9]);
    expect(bytes.subarray(6).toString()).toBe('mdat-and-more');
    expect(() => svc.fileWrite(started.id, 0, Buffer.from([1]))).toThrow(/Unknown or finished/); // closed
  });

  it('a closed Save dialog starts nothing; cancel deletes the partial file; bad positions and sizes are refused', async () => {
    expect((await service(null).svc.fileStart({ name: 'a', ext: 'mov' })).saved).toBe(false);
    const target = join(root, 'b.mov');
    const { svc } = service(target);
    const s = await svc.fileStart({ name: 'b', ext: 'mov' });
    svc.fileWrite(s.id, 0, Buffer.from('xyz'));
    expect(() => svc.fileWrite(s.id, -1, Buffer.from('x'))).toThrow(ExportError);
    expect(() => svc.fileWrite(s.id, 1.5, Buffer.from('x'))).toThrow(ExportError);
    expect(() => svc.fileWrite(s.id, 0, Buffer.alloc(0))).toThrow(ExportError);
    svc.fileCancel(s.id);
    expect(existsSync(target)).toBe(false);
    await expect(service(target).svc.fileStart({ name: 'a', ext: '!!' })).rejects.toThrow(/ext/);
  });

  it('pictures and sound through FFmpeg need FFmpeg and a known format', async () => {
    const { svc } = service(null);
    await expect(svc.still({ codec: 'dpx', width: '2', height: '2' }, Buffer.alloc(16))).rejects.toThrow(/FFmpeg is not set up/);
    const withBin = createExportService({ tmpRoot: join(root, 'tmp2'), binary: async () => 'ffmpeg-that-does-not-exist', pickSavePath: async () => null });
    await expect(withBin.still({ codec: 'png-image', width: '2', height: '2' }, Buffer.alloc(16))).rejects.toThrow(/not an FFmpeg picture format/);
    await expect(withBin.still({ codec: 'dpx', width: '2', height: '2' }, Buffer.alloc(15))).rejects.toThrow(/16 bytes/);
    await expect(withBin.sound({ codec: 'mp3', rate: '10', channels: '2' }, Buffer.alloc(8))).rejects.toThrow(/rate needs/);
    await expect(withBin.sound({ codec: 'dpx', rate: '48000', channels: '2' }, Buffer.alloc(8))).rejects.toThrow(/not a sound format/);
  });
});

describe('pictures and sound through a real FFmpeg (skipped when there is none)', async () => {
  const { findFfmpeg } = await import('../../src/cli/ffmpeg.ts');
  const bin = await findFfmpeg();
  const it2 = bin ? it : it.skip;
  const svc = createExportService({ tmpRoot: join(root, 'tmp3'), binary: async () => bin, pickSavePath: async () => null });
  it2('a DPX picture and a JPEG 2000 picture come back as files', async () => {
    const rgba = Buffer.alloc(32 * 16 * 4, 120);
    const dpx = await svc.still({ codec: 'dpx', width: '32', height: '16' }, rgba);
    expect(['SDPX', 'XPDS']).toContain(dpx.subarray(0, 4).toString()); // big or little endian
    const jp2 = await svc.still({ codec: 'jp2', width: '32', height: '16' }, rgba);
    expect(jp2.length).toBeGreaterThan(50);
  });
  it2('a sound file comes back as a file (FLAC here, which every FFmpeg has)', async () => {
    const pcm = Buffer.alloc(4 * 2 * 4800);
    for (let i = 0; i < 4800 * 2; i++) pcm.writeFloatLE(Math.sin(i / 20) * 0.5, i * 4);
    const out = await svc.sound({ codec: 'flac', rate: '48000', channels: '2' }, pcm);
    expect(out.subarray(0, 4).toString()).toBe('fLaC');
  });
});
