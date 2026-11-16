// Self-signed certificate for the on-demand phone server. Generated on first use, stored in the app's userData folder
// (the private key file is created readable by the owner only), regenerated when this machine's addresses change or
// after about 11 months (browsers on phones reject certificates valid for longer than 398 days; ours is valid for 365).
import { X509Certificate, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from 'selfsigned';

const RENEW_AFTER_MS = 330 * 24 * 3600 * 1000;

/** sha256 of the DER certificate, base64: the same form Chromium reports as "sha256/<base64>". */
export function fingerprintOf(pem) {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('base64');
}

/**
 * @param {string} dir userData folder
 * @param {string[]} addresses LAN IPv4 addresses that go into the certificate's subject alternative names
 * @returns {Promise<{ cert: string, key: string, fingerprint: string, created: boolean }>}
 */
export async function ensureCertificate(dir, addresses) {
  mkdirSync(dir, { recursive: true });
  const certFile = join(dir, 'phone-cert.pem');
  const keyFile = join(dir, 'phone-key.pem');
  const metaFile = join(dir, 'phone-cert.json');
  const want = [...new Set(addresses)].sort();
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (existsSync(certFile) && existsSync(keyFile) && Date.now() - meta.created < RENEW_AFTER_MS && JSON.stringify(meta.addresses) === JSON.stringify(want)) {
      const cert = readFileSync(certFile, 'utf8');
      return { cert, key: readFileSync(keyFile, 'utf8'), fingerprint: fingerprintOf(cert), created: false };
    }
  } catch {
    /* none yet, or unreadable: make a new one */
  }
  const now = new Date();
  const pems = await generate([{ name: 'commonName', value: 'RSMPS phone link' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - 3600_000),
    notAfterDate: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          ...want.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  // The key is written with mode 0600 (owner only). On Windows the mode is ignored, but userData is already inside the user's profile.
  writeFileSync(keyFile, pems.private, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* not supported on this platform */
  }
  writeFileSync(certFile, pems.cert);
  writeFileSync(metaFile, JSON.stringify({ created: now.getTime(), addresses: want }));
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert), created: true };
}
