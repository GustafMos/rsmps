import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORT_FILES, ortFiles } from './ort-files';

const dist = resolve(__dirname, '../node_modules/onnxruntime-web/dist');

describe('onnxruntime-web files shipped for AI Depth', () => {
  it('exist in the installed package', () => {
    for (const f of ORT_FILES) expect(existsSync(join(dist, f)), f).toBe(true);
  });

  it('are exactly what the runtime module loads: its wasm loader and wasm both come with it (a package update that renames them fails here)', () => {
    const js = readFileSync(join(dist, 'ort.webgpu.min.mjs'), 'utf8');
    const loaders = [...new Set(js.match(/ort-wasm-simd-threaded[\w.]*\.mjs/g) ?? [])];
    expect(loaders.length).toBeGreaterThan(0);
    for (const l of loaders) {
      expect(ORT_FILES as readonly string[], `ort.webgpu.min.mjs loads ${l}`).toContain(l);
      expect(ORT_FILES as readonly string[]).toContain(l.replace(/\.mjs$/, '.wasm'));
    }
  });

  it('the plugin emits them under ort/ at build time and nothing else', () => {
    const p = ortFiles(resolve(__dirname, '..'));
    const emitted: string[] = [];
    (p.generateBundle as (this: { emitFile(f: { fileName: string }): void }) => void).call({ emitFile: (f) => emitted.push(f.fileName) });
    expect(emitted.sort()).toEqual([...ORT_FILES].map((f) => `ort/${f}`).sort());
  });
});
