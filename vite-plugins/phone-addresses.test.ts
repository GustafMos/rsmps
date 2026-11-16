import { describe, expect, it } from 'vitest';
import { isCgnat, rankAddresses } from './phone-addresses';

const nic = (name: string, address: string, extra: Record<string, unknown> = {}) => ({ name, address, family: 'IPv4', internal: false, ...extra });

describe('address ranking', () => {
  it('puts the physical Wi-Fi first on a machine with virtual adapters and Tailscale', () => {
    const r = rankAddresses([
      nic('vEthernet (WSL)', '172.24.16.1'),
      nic('Tailscale', '100.82.76.63'),
      nic('VirtualBox Host-Only Network', '192.168.56.1'),
      nic('Wi-Fi', '192.168.0.221'),
      nic('Loopback Pseudo-Interface 1', '127.0.0.1', { internal: true }),
      nic('Ethernet 2', '169.254.10.5'),
    ]);
    expect(r.map((c) => c.address)).toEqual(['192.168.0.221', '100.82.76.63', '172.24.16.1', '192.168.56.1']);
    expect(r.map((c) => c.kind)).toEqual(['lan', 'tailscale', 'other', 'other']);
    expect(r[0].label).toBe('Wi-Fi 192.168.0.221');
    expect(r[1].label).toBe('Tailscale 100.82.76.63');
    expect(r[2].label).toMatch(/virtual adapter/);
  });
  it('prefers 192.168 over 10.x over 172.16/12 among physical networks', () => {
    const r = rankAddresses([nic('Ethernet', '172.20.0.5'), nic('Ethernet 2', '10.0.0.7'), nic('Wi-Fi', '192.168.1.9')]);
    expect(r.map((c) => c.address)).toEqual(['192.168.1.9', '10.0.0.7', '172.20.0.5']);
  });
  it('skips IPv6, loopback and link-local', () => {
    expect(rankAddresses([{ name: 'Wi-Fi', address: 'fe80::1', family: 'IPv6' }, nic('lo', '127.0.0.1'), nic('x', '169.254.1.1')])).toEqual([]);
  });
  it('knows the carrier-grade NAT range Tailscale uses', () => {
    expect(isCgnat('100.64.0.1')).toBe(true);
    expect(isCgnat('100.127.255.1')).toBe(true);
    expect(isCgnat('100.128.0.1')).toBe(false);
    expect(isCgnat('100.63.0.1')).toBe(false);
  });
});
