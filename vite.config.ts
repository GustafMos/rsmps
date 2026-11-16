import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { phoneLink } from './vite-plugins/phone-link';

/**
 * RSMPS_LAN=1 (npm run dev:lan): serve over https with a self-signed certificate on all network interfaces and enable the
 * phone link (scan a QR code to use a phone as a camera). Without it the dev server is plain http on localhost, as always.
 */
const lan = process.env.RSMPS_LAN === '1';
/** Test hook only (never needed in use): RSMPS_LAN_NOSSL=1 serves the LAN mode over plain http so a headless browser can reach it. */
const ssl = lan && process.env.RSMPS_LAN_NOSSL !== '1';
/** A real certificate (for example from `tailscale cert`): RSMPS_CERT / RSMPS_KEY are paths to PEM files. Replaces the self-signed one. */
const realCert = lan && process.env.RSMPS_CERT && process.env.RSMPS_KEY ? { cert: readFileSync(process.env.RSMPS_CERT), key: readFileSync(process.env.RSMPS_KEY) } : null;

export default defineConfig(async () => {
  const plugins: PluginOption[] = [react(), phoneLink({ lan, https: ssl, tailnetName: realCert ? process.env.RSMPS_TS_NAME : undefined })];
  if (ssl && !realCert) {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
    plugins.push(basicSsl());
  }
  return {
    base: './',
    plugins,
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
      ...(lan ? { host: true, allowedHosts: true as const } : {}),
      ...(realCert ? { https: realCert } : {}),
    },
  };
});
