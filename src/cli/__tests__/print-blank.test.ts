import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdPrintBlank, readWav } from '../print-blank';

function wav16(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  tag(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => dv.setInt16(44 + i * 2, Math.round(v * 32767), true));
  return out;
}

describe('rsmps print-blank', () => {
  it('writes a PDF and PNG pages for blank sheets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsmps-blank-'));
    try {
      const code = await cmdPrintBlank(['--frames', '14', '--per-sheet', '6', '--aspect', '4:3', '--guides', 'cross,pegs', '--ghost', '--exposure-sheet', '--shoot-on', '2', '--format', 'both', '--dpi', '72', '--name', 'cli test', '--out', dir, '--quiet']);
      expect(code).toBe(0);
      const files = readdirSync(dir);
      expect(files).toContain('cli test.pdf');
      expect(files.filter((f) => f.endsWith('.png')).length).toBeGreaterThanOrEqual(4); // 3 sheets + exposure
      expect(readFileSync(join(dir, 'cli test.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects bad options with a readable message', async () => {
    await expect(cmdPrintBlank(['--paper', 'a9', '--frames', '4'])).rejects.toThrow(/Unknown --paper/);
    await expect(cmdPrintBlank(['--aspect', '16:9'])).rejects.toThrow(/--frames/);
    await expect(cmdPrintBlank(['--frames', '4', '--guides', 'wobble'])).rejects.toThrow(/Unknown guide/);
  });
  it('reads PCM WAV files for --beats-from', () => {
    const w = readWav(wav16(new Float32Array(1000).fill(0.5), 8000));
    expect(w.sampleRate).toBe(8000);
    expect(w.channels[0].length).toBe(1000);
    expect(w.channels[0][10]).toBeCloseTo(0.5, 2);
    expect(() => readWav(new Uint8Array(10))).toThrow(/WAV/);
  });
});
