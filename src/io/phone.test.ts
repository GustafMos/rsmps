import { describe, expect, it } from 'vitest';
import { newToken, pickOrigin } from './phone';

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
