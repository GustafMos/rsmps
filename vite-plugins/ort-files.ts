import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Ships the onnxruntime-web (MIT) files that the AI Depth node loads LAZILY, under `ort/` next to the app:
 *   ort.webgpu.min.mjs               the runtime (~70 KB)
 *   ort-wasm-simd-threaded.asyncify.mjs  its WebAssembly loader (~52 KB)
 *   ort-wasm-simd-threaded.asyncify.wasm the WebAssembly with the WebGPU and CPU providers (~27 MB)
 * They are plain copies, not bundled: no page loads them until the AI Depth feature is used (src/io/depth-ai.ts imports them by URL),
 * so the app's startup, the main bundle and everyone who never uses the feature pay nothing but the download size of the site.
 * The same URL is served by the dev server. The model itself is never part of the build.
 */
export const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'] as const;

const MIME: Record<string, string> = { '.mjs': 'text/javascript', '.wasm': 'application/wasm' };

export function ortFiles(root = process.cwd()): Plugin {
  const dist = resolve(root, 'node_modules/onnxruntime-web/dist');
  const check = () => {
    const missing = ORT_FILES.filter((f) => !existsSync(join(dist, f)));
    if (missing.length) throw new Error(`ort-files: ${missing.join(', ')} not found in node_modules/onnxruntime-web/dist (run npm install)`);
  };
  return {
    name: 'rsmps-ort-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/ort\/([\w.-]+)(?:\?.*)?$/.exec(req.url ?? '');
        const name = m?.[1];
        if (!name || !(ORT_FILES as readonly string[]).includes(name)) return next();
        const file = join(dist, name);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      check();
      for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(join(dist, f)) });
    },
  };
}
