import { describe, expect, it } from 'vitest';
import { AddonsImpl } from './addons';
import { DesktopClient } from './desktop';

const json = (o: unknown) => new Response(JSON.stringify(o));

describe('AddonsImpl', () => {
  it('is unsupported and silent on the web', async () => {
    const a = new AddonsImpl(null);
    expect(a.supported).toBe(false);
    expect(await a.list()).toEqual([]);
    expect(await a.install('ffmpeg')).toMatchObject({ ok: false });
  });
  it('polls while installing and stops when done', async () => {
    let n = 0;
    const client = new DesktopClient(
      async (_u, init) => {
        if (init?.method === 'POST') return json({ id: 'ffmpeg', state: 'installing', progress: { phase: 'downloading', received: 0, total: 10 } });
        n++;
        return json({ id: 'ffmpeg', state: n < 3 ? 'installing' : 'installed', installed: { source: 'download', version: '9', path: 'p' } });
      },
      undefined,
      () => true,
    );
    const a = new AddonsImpl(client, 5);
    const seen: string[] = [];
    a.onChange((l) => seen.push(l[0].state));
    const r = await a.install('ffmpeg');
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 120));
    expect(seen.at(-1)).toBe('installed');
    const polls = n;
    await new Promise((res) => setTimeout(res, 40));
    expect(n).toBe(polls); // polling stopped
  });
  it('reports declined without an error', async () => {
    const client = new DesktopClient(async () => json({ id: 'ffmpeg', state: 'not-installed', declined: true }), undefined, () => true);
    const r = await new AddonsImpl(client).install('ffmpeg');
    expect(r).toMatchObject({ ok: false, declined: true });
    expect(r.error).toBeUndefined();
  });
});
