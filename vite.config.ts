/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { phoneLink } from './vite-plugins/phone-link';
import { ortFiles } from './vite-plugins/ort-files';

/**
 * RSMPS_LAN=1 (npm run dev:lan): enable the phone link (scan a QR code to use a phone as a camera). The app itself stays on
 * http://localhost, as in plain `npm run dev`, so both modes show the same projects (a browser stores them per address); phones
 * get an https address of their own on the next port (see vite-plugins/phone-link.ts).
 */
const lan = process.env.RSMPS_LAN === '1';
/** Test hook only (never needed in use): RSMPS_LAN_NOSSL=1 serves the LAN mode over plain http so a headless browser can reach it. */
const ssl = lan && process.env.RSMPS_LAN_NOSSL !== '1';
/** A real certificate (for example from `tailscale cert`): RSMPS_CERT / RSMPS_KEY are paths to PEM files. Replaces the self-signed one. */
const realCert = lan && process.env.RSMPS_CERT && process.env.RSMPS_KEY ? { cert: readFileSync(process.env.RSMPS_CERT), key: readFileSync(process.env.RSMPS_KEY) } : null;

export default defineConfig(() => {
  const plugins: PluginOption[] = [react(), phoneLink({ lan, https: ssl, tls: realCert, tailnetName: realCert ? process.env.RSMPS_TS_NAME : undefined }), ortFiles(__dirname)];
  return {
    base: './',
    plugins,
    // CPU-heavy tests (scan, zip, GPU readback) run side by side; the 5 s default is too tight on a busy machine.
    test: { testTimeout: 30_000 },
    worker: {
      format: 'es' as const,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: { main: resolve(__dirname, 'index.html'), phone: resolve(__dirname, 'phone.html') },
      },
    },
    server: {
      port: 5173,
      open: false,
      // Build outputs must not be watched: a locked file in release/ (the packaged app) crashed the dev server.
      watch: { ignored: ['**/release/**', '**/.desktop-stage/**', '**/dist/**', '**/dist-cli/**', '**/tmp/**', '**/test-output*/**'] },
      // LAN mode: reachable by IP and by host names such as machine.tailnet.ts.net (Vite's host check would otherwise refuse names).
      // Requests arrive through the https front with the phone's host name, so Vite's host check is off in LAN mode. Only the plain-http
      // test mode opens the dev server itself to the network.
      ...(lan ? { allowedHosts: true as const, ...(ssl ? {} : { host: true }) } : {}),
    },
  };
});
