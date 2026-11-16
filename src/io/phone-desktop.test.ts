import { describe, expect, it } from 'vitest';
import { DesktopClient } from './desktop';
import { PhoneLink } from './phone';

const cand = { address: '192.168.0.5', adapter: 'Wi-Fi', kind: 'lan', label: 'Wi-Fi 192.168.0.5', url: 'https://192.168.0.5:20001' };
const off = { lan: false, desktop: true, state: 'off', origins: [cand.url], candidates: [cand], ws: 'wss://127.0.0.1:20001', port: 20001 };

function link(answer: (path: string) => unknown) {
  const paths: string[] = [];
  const client = new DesktopClient(
    async (u) => {
      paths.push(u.replace('app://rsmps/__rsmps/', ''));
      return new Response(JSON.stringify(answer(paths.at(-1)!)));
    },
    undefined,
    () => true,
  );
  return { phone: new PhoneLink(client), paths };
}

describe('phone link in the desktop app', () => {
  it('is available on demand while the server is still off, with addresses from the candidates', async () => {
    const { phone } = link(() => off);
    await phone.init();
    expect(phone.available).toBe(true);
    expect(await phone.addresses()).toEqual([{ url: cand.url, label: cand.label, kind: 'lan' }]);
  });
  it('is unavailable when the desktop has no phone service', async () => {
    const { phone } = link(() => ({ lan: false, desktop: true, state: 'off', origins: [], candidates: [], ws: '' }));
    await phone.init();
    expect(phone.available).toBe(false);
  });
  it('starts the server, and reports a refusal as declined', async () => {
    const a = link((p) => (p === 'lan-start' ? { ...off, lan: true, state: 'on' } : off));
    await a.phone.init();
    expect(await a.phone.startServer()).toEqual({ ok: true });
    const b = link((p) => (p === 'lan-start' ? { ...off, declined: true } : off));
    await b.phone.init();
    expect(await b.phone.startServer()).toMatchObject({ ok: false, declined: true });
    const c = link((p) => (p === 'lan-start' ? { ...off, state: 'error', error: 'Port in use' } : off));
    await c.phone.init();
    expect(await c.phone.startServer()).toEqual({ ok: false, error: 'Port in use' });
  });
});
