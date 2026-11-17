import { mkdirSync, writeFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ENCODERS, getEncoder } from './index';
import { join, makePicture } from './test-helpers';

describe('encoder table', () => {
  it('has unique ids, short parenthesis-free labels and sane metadata', () => {
    expect(new Set(ENCODERS.map((e) => e.id)).size).toBe(ENCODERS.length);
    for (const e of ENCODERS) {
      expect(e.label.length, e.id).toBeLessThanOrEqual(24);
      expect(e.label, e.id).not.toMatch(/[()]/);
      expect(e.extension).toMatch(/^[a-z0-9]+$/);
      expect(e.mime).toContain('/');
      expect(['video', 'animation', 'image', 'audio']).toContain(e.kind);
    }
    expect(getEncoder('gif')?.kind).toBe('animation');
    expect(getEncoder('nope')).toBeUndefined();
  });

  it('every descriptor produces a non-empty file through its session, and writes samples for manual checks', async () => {
    const dir = pjoin(tmpdir(), 'rsmps-previews', 'encoders');
    mkdirSync(dir, { recursive: true });
    const w = 96;
    const h = 64;
    const frame = (i: number) => {
      const p = makePicture('gradient', w, h);
      for (let y = 20; y < 36; y++) for (let x = 8 + i * 6; x < 24 + i * 6; x++) p.set([255, 220, 0, 255], (y * w + x) * 4);
      return p;
    };
    const alpha = makePicture('alpha', w, h);
    for (const e of ENCODERS) {
      const s = e.begin({ width: w, height: h, fps: 25, sampleRate: 48000, jpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
      if (e.kind === 'audio') {
        s.addAudio!([Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20) * 0.5)]);
      } else if (e.kind === 'image') {
        await s.addFrame(e.alpha ? alpha : frame(0));
        await expect(Promise.resolve().then(() => s.addFrame(alpha))).rejects.toThrow(/one picture/);
      } else for (let i = 0; i < 8; i++) await s.addFrame(frame(i));
      const bytes = join(await s.finish());
      expect(bytes.length, e.id).toBeGreaterThan(20);
      writeFileSync(pjoin(dir, `sample-${e.id}.${e.extension}`), bytes);
    }
  });
});
