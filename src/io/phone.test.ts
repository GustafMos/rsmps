import { describe, expect, it } from 'vitest';
import { advanceProgress, newToken, phoneSteps, pickOrigin } from './phone';

describe('phone link helpers', () => {
  it('makes 128-bit hex tokens that differ', () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken()).not.toBe(a);
  });
  it('puts the page LAN origin in the QR code, else the first server address', () => {
    const origins = ['https://192.168.0.5:5173', 'https://10.0.0.7:5173'];
    expect(pickOrigin(origins, { hostname: 'localhost', origin: 'https://localhost:5173' })).toBe('https://192.168.0.5:5173');
    expect(pickOrigin(origins, { hostname: '10.0.0.7', origin: 'https://10.0.0.7:5173' })).toBe('https://10.0.0.7:5173');
    expect(pickOrigin([], { hostname: 'localhost', origin: 'https://localhost:5173' })).toBeNull();
  });
});

import { buildAddresses } from './phone';

describe('QR addresses', () => {
  const cands = [
    { address: '192.168.0.221', label: 'Wi-Fi 192.168.0.221', kind: 'lan' as const },
    { address: '100.82.76.63', label: 'Tailscale 100.82.76.63', kind: 'tailscale' as const },
  ];
  it('uses the protocol and port of the page that is open, never a hard-coded port', () => {
    const a = buildAddresses(cands, { protocol: 'https:', hostname: 'localhost', port: '5174', origin: 'https://localhost:5174' });
    expect(a.map((x) => x.url)).toEqual(['https://192.168.0.221:5174', 'https://100.82.76.63:5174']);
  });
  it('offers the page origin first when it was opened through a non-local host name', () => {
    const a = buildAddresses(cands, { protocol: 'https:', hostname: 'pc.tail1234.ts.net', port: '5173', origin: 'https://pc.tail1234.ts.net:5173' });
    expect(a[0]).toMatchObject({ url: 'https://pc.tail1234.ts.net:5173', kind: 'tailscale' });
    expect(a).toHaveLength(3);
  });
});

describe('phone progress ticks come from a typed progress, not from wording', () => {
  it('only moves forward', () => {
    expect(advanceProgress('waiting', 'reached')).toBe('reached');
    expect(advanceProgress('accepted', 'reached')).toBe('accepted');
    expect(advanceProgress('connected', 'waiting')).toBe('connected');
  });
  it('maps progress and state to the three ticks', () => {
    expect(phoneSteps('waiting', 'waiting')).toEqual([false, false, false]);
    expect(phoneSteps('reached', 'waiting')).toEqual([true, false, false]);
    expect(phoneSteps('accepted', 'waiting')).toEqual([true, true, false]);
    expect(phoneSteps('accepted', 'connected')).toEqual([true, true, true]);
    expect(phoneSteps('connected', 'disconnected')).toEqual([true, true, false]);
  });
});
