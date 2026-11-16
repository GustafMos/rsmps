/**
 * Which address should the QR code point at? A Windows machine typically has several: the Wi-Fi adapter, Hyper-V / WSL /
 * VirtualBox virtual adapters (192.168.x or 172.x too!), a VPN, Tailscale (100.64/10). The first one in the list is often NOT
 * the one a phone can reach. Rank them and keep all of them so the UI can offer a choice.
 */

export interface Iface {
  name: string;
  address: string;
  family?: string | number;
  internal?: boolean;
}

export type AddressKind = 'lan' | 'tailscale' | 'other';

export interface Candidate {
  address: string;
  /** Adapter name. */
  adapter: string;
  kind: AddressKind;
  label: string;
}

const VIRTUAL = /vethernet|virtualbox|vmware|vmnet|vboxnet|hyper-v|wsl|docker|veth|br-|virbr|utun|tap|teredo|isatap|loopback|bluetooth|npcap|pseudo|host-only/i;

export function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.');
}

/** 100.64.0.0/10: Tailscale and other carrier-grade NAT ranges. */
export function isCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function looksVirtual(name: string): boolean {
  return VIRTUAL.test(name);
}

function score(c: Candidate): number {
  const [a, b] = c.address.split('.').map(Number);
  if (c.kind === 'lan') {
    // Physical adapters first; among them the usual home/office ranges, and names that sound like Wi-Fi / Ethernet.
    let s = 0;
    if (a === 192 && b === 168) s -= 3;
    else if (a === 10) s -= 2;
    else s -= 1;
    if (/wi-?fi|wlan|wireless|en0|wlp|eth|ethernet|en\d/i.test(c.adapter)) s -= 1;
    return s;
  }
  if (c.kind === 'tailscale') return 10;
  return 20;
}

/** Ranked candidates: physical private networks, then Tailscale, then everything else. Loopback and link-local are skipped. */
export function rankAddresses(ifaces: Iface[]): Candidate[] {
  const out: Candidate[] = [];
  for (const i of ifaces) {
    const family = String(i.family);
    if (i.internal || (family !== 'IPv4' && family !== '4')) continue;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(i.address) || i.address.startsWith('127.') || isLinkLocal(i.address)) continue;
    const virtual = looksVirtual(i.name);
    let kind: AddressKind = 'other';
    if (isCgnat(i.address) || /tailscale/i.test(i.name)) kind = 'tailscale';
    else if (isPrivate(i.address) && !virtual) kind = 'lan';
    const label = kind === 'tailscale' ? `Tailscale ${i.address}` : kind === 'lan' ? `${i.name} ${i.address}` : `${i.name} ${i.address}${virtual ? ' (virtual adapter)' : ''}`;
    out.push({ address: i.address, adapter: i.name, kind, label });
  }
  return out.sort((a, b) => score(a) - score(b));
}
