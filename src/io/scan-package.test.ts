import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookAtQuat } from '../engine/lib/scan-coverage';
import { DEFAULT_GRID, intrinsicsFromProjection, type ScanData, type ScanShot } from '../engine/lib/scan-data';
import { lensFromFov, projectionMatrix } from '../engine/lib/xr-math';
import { buildScanZip, readScanPackage, unzipScan } from './scan-package';

const proj = projectionMatrix(lensFromFov(60, 0.75));
const mk = (i: number): ScanShot => {
  const pos: [number, number, number] = [Math.sin(i), 0.4, Math.cos(i) - 2];
  return { asset: `asset${i}`, t: i, pos, quat: lookAtQuat(pos, [0, 0.3, -2]), w: 90, h: 120, ...intrinsicsFromProjection(proj, 90, 120), sharp: 0.8 };
};
const scan: ScanData = { v: 1, units: 'm', target: { center: [0, 0.3, -2], radius: 0.5, up: [0, 1, 0] }, grid: { ...DEFAULT_GRID }, shots: [0, 1, 2, 3, 4].map(mk) };
// fake photos: a JPEG-looking header plus a body that differs per photo (the bytes must come back unchanged)
const photo = (i: number): ArrayBuffer => {
  const b = new Uint8Array(3000 + i * 11);
  for (let k = 0; k < b.length; k++) b[k] = (k * 31 + i * 7) & 255;
  b[0] = 0xff;
  b[1] = 0xd8;
  return b.buffer;
};

describe('scan zip', () => {
  it('writes a zip that the system unzip and python accept, with the original photo bytes, then reads back to the same scan', async () => {
    const progress: number[] = [];
    // shot 2's photo is gone from Media: it is left out of everything and the others are renumbered
    const res = await buildScanZip(scan, { folder: 'Chair scan', readAsset: async (id) => (id === 'asset2' ? null : photo(Number(id.slice(5)))), onProgress: (f) => progress.push(f) });
    expect(res.photos).toBe(4);
    expect(res.skipped).toBe(1);
    expect(res.folder).toBe('Chair-scan');
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
    const bytes = new Uint8Array(await res.blob.arrayBuffer());

    // 1. the real tools
    const dir = mkdtempSync(join(tmpdir(), 'scanzip-'));
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(zipPath, bytes);
      const out = join(dir, 'out');
      expect(execFileSync('unzip', ['-t', zipPath]).toString()).toContain('No errors detected');
      execFileSync('unzip', ['-q', zipPath, '-d', out]);
      const py = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(sorted(z.namelist()))', zipPath]).toString();
      expect(py.split('\n')[0]).toBe('None');
      const base = join(out, 'Chair-scan');
      expect(Buffer.from(readFileSync(join(base, 'images/0003.jpg')))).toEqual(Buffer.from(photo(3))); // old shot 3 is now the third photo
      for (const f of ['sparse/0/cameras.txt', 'sparse/0/images.txt', 'sparse/0/points3D.txt', 'transforms.json', 'scan.json', 'README.txt']) expect(readFileSync(join(base, f)).length).toBeGreaterThan(10);
      expect(readFileSync(join(base, 'sparse/0/images.txt'), 'utf8')).toContain('Number of images: 4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 2. our reader
    const pack = readScanPackage(unzipScan(bytes));
    expect(pack.scan.shots.length).toBe(4);
    expect(pack.photos.length).toBe(4);
    expect(pack.missing).toBe(0);
    expect(pack.scan.shots.map((s) => s.pos)).toEqual([0, 1, 3, 4].map((i) => mk(i).pos));
    pack.scan.shots.forEach((s, i) => {
      const idx = Number(s.asset.slice(4));
      expect(Buffer.from(pack.photos[idx].bytes)).toEqual(Buffer.from(photo([0, 1, 3, 4][i])));
    });
  });

  it('stops when cancelled, and refuses a scan with no photos or no files', async () => {
    const ac = new AbortController();
    await expect(buildScanZip(scan, { readAsset: async () => { ac.abort(); return photo(1); }, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(buildScanZip({ ...scan, shots: [] }, { readAsset: async () => photo(1) })).rejects.toThrow(/no photos/);
    await expect(buildScanZip(scan, { readAsset: async () => null })).rejects.toThrow(/Media/);
  });

  it('reads a loose pile of files (scan.json and numbered photos) and says plainly what is not a scan', () => {
    const enc = new TextEncoder();
    const files = { 'scan.json': enc.encode(JSON.stringify(scan)), '0001.jpg': new Uint8Array([1]), '0002.jpg': new Uint8Array([2]), '0004.jpg': new Uint8Array([4]) };
    const p = readScanPackage(files);
    expect(p.scan.shots.length).toBe(3);
    expect(p.missing).toBe(2);
    expect(() => readScanPackage({ 'x.txt': enc.encode('hi') })).toThrow(/scan\.json/);
    expect(() => readScanPackage({ 'scan.json': enc.encode('{"v":9}') })).toThrow(/not a 3D scan/);
    expect(() => unzipScan(new Uint8Array([1, 2, 3, 4]))).toThrow(/zip/);
  });
});
