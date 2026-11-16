// npm run dev:lan — opt-in LAN mode: https, reachable from a phone. Plain `npm run dev` is unchanged (http, localhost only).
//
//   npm run dev:lan                        self-signed certificate (the phone shows a "not private" warning once)
//   npm run dev:lan -- --tailscale         browser-trusted certificate for this machine's Tailscale name (no warning)
//   RSMPS_CERT=cert.pem RSMPS_KEY=key.pem npm run dev:lan      use your own certificate
//   npm run dev:lan -- --port=5174         another port
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';

process.env.RSMPS_LAN = '1';
const args = process.argv.slice(2);
const port = Number(args.find((a) => a.startsWith('--port='))?.slice(7)) || undefined;
const wantTailscale = args.includes('--tailscale');

function tailscaleStatus() {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { ok: false, reason: r.error ? 'The "tailscale" command was not found on PATH.' : (r.stderr || r.stdout || 'tailscale status failed').trim() };
  try {
    const s = JSON.parse(r.stdout);
    const name = String(s.Self?.DNSName ?? '').replace(/\.$/, '');
    if (s.BackendState !== 'Running') return { ok: false, reason: `Tailscale is not connected (state: ${s.BackendState}). Start it and log in.` };
    if (!name) return { ok: false, reason: 'Tailscale reports no DNS name for this machine. Enable MagicDNS in the Tailscale admin console.' };
    return { ok: true, name };
  } catch {
    return { ok: false, reason: 'Could not read "tailscale status --json".' };
  }
}

if (wantTailscale && !(process.env.RSMPS_CERT && process.env.RSMPS_KEY)) {
  const st = tailscaleStatus();
  if (!st.ok) {
    console.error(`\n  Tailscale: ${st.reason}\n  Continuing with the self-signed certificate.\n`);
  } else {
    const dir = resolve('.certs'); // git-ignored; certificates are never committed
    mkdirSync(dir, { recursive: true });
    const cert = resolve(dir, `${st.name}.crt`);
    const key = resolve(dir, `${st.name}.key`);
    console.log(`\n  Tailscale: asking for a certificate for ${st.name} ...`);
    const r = spawnSync('tailscale', ['cert', '--cert-file', cert, '--key-file', key, st.name], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && existsSync(cert) && existsSync(key)) {
      process.env.RSMPS_CERT = cert;
      process.env.RSMPS_KEY = key;
      process.env.RSMPS_TS_NAME = st.name;
      console.log('  Tailscale certificate ready: phones on your tailnet will not show a warning.');
    } else {
      console.error(
        `\n  "tailscale cert" failed:\n  ${(r.stderr || r.stdout || r.error?.message || '').trim()}\n\n  HTTPS certificates must be enabled for your tailnet: open https://login.tailscale.com/admin/dns, turn on MagicDNS and press\n  "Enable HTTPS". Then run this again. Continuing with the self-signed certificate.\n`,
      );
    }
  }
} else if (!wantTailscale && !(process.env.RSMPS_CERT && process.env.RSMPS_KEY)) {
  const st = tailscaleStatus();
  if (st.ok) console.log(`\n  Tip: Tailscale is running. "npm run dev:lan -- --tailscale" gets a trusted certificate for ${st.name} (no warning on the phone).`);
}

const server = await createServer(port ? { server: { port } } : {});
await server.listen();
server.printUrls();
