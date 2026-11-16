// Bundles the desktop main process's helper modules with esbuild, so the packaged app needs no node_modules and the shared
// logic exists once:
//   desktop/build/phone-server.mjs  desktop/phone/ + vite-plugins/phone-session.ts + ws + selfsigned
//   desktop/build/addons.mjs        desktop/addons/ + src/cli/encode.ts (codec argument sets, VideoWriter) + fflate
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'], // optional native accelerators of ws
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [join(root, 'desktop', 'phone', 'index.mjs')], outfile: join(root, 'desktop', 'build', 'phone-server.mjs') });

// src/cli/encode.ts reaches ffmpeg through ./ffmpeg (a CLI lookup) and sharp (stills): swap in the desktop shim and a stub.
const redirect = {
  name: 'desktop-redirects',
  setup(b) {
    b.onResolve({ filter: /^\.\/ffmpeg$/ }, (a) => (a.importer.endsWith(join('src', 'cli', 'encode.ts')) ? { path: join(root, 'desktop', 'addons', 'shim-ffmpeg.mjs') } : undefined));
    b.onResolve({ filter: /^sharp$/ }, () => ({ path: join(root, 'desktop', 'addons', 'stub-sharp.mjs') }));
  },
};
await build({ ...common, entryPoints: [join(root, 'desktop', 'addons', 'index.mjs')], outfile: join(root, 'desktop', 'build', 'addons.mjs'), plugins: [redirect] });
console.log('desktop modules bundled');
