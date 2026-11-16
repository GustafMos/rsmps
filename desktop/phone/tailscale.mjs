// Optional: a browser-trusted certificate for this machine's Tailscale name (`tailscale cert`). Only used when the user
// turns it on in the Phone menu. Every failure returns { ok: false, reason } and the self-signed certificate is used.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (args, timeout) =>
  new Promise((resolve) => {
    execFile('tailscale', args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });

/** @returns {Promise<{ ok: true, name: string, cert: string, key: string } | { ok: false, reason: string }>} */
export async function tailscaleCertificate(dir) {
  const st = await run(['status', '--json'], 8000);
  if (st.err) return { ok: false, reason: 'The "tailscale" command was not found or did not answer.' };
  let name = '';
  try {
    const s = JSON.parse(st.stdout);
    if (s.BackendState !== 'Running') return { ok: false, reason: `Tailscale is not connected (state: ${s.BackendState}).` };
    name = String(s.Self?.DNSName ?? '').replace(/\.$/, '');
  } catch {
    return { ok: false, reason: 'Could not read the Tailscale status.' };
  }
  if (!/^[a-z0-9][a-z0-9.-]*\.ts\.net$/i.test(name)) return { ok: false, reason: 'Tailscale reports no MagicDNS name for this machine.' };
  mkdirSync(dir, { recursive: true });
  const certFile = join(dir, 'tailscale.crt');
  const keyFile = join(dir, 'tailscale.key');
  const r = await run(['cert', '--cert-file', certFile, '--key-file', keyFile, name], 60000);
  if (r.err || !existsSync(certFile) || !existsSync(keyFile)) return { ok: false, reason: 'Tailscale could not issue a certificate. Enable HTTPS certificates for your tailnet in the Tailscale admin console (DNS page).' };
  return { ok: true, name, cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
}
