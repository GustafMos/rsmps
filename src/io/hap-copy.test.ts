import { describe, expect, it } from 'vitest';
import { DesktopClient, parseHapConvertInfo, parseHapConvertStatus, type HapConvertStatus } from './desktop';
import { FAST_COPY_FORMATS, HAP_COPY_HINT, fastCopyChoices, isFastCopy, makeHapCopy } from './hap-copy';

describe('what the Fast copy panel offers', () => {
  it('the web version, and a desktop FFmpeg without HAP, offer H.264 only: no format choice is shown', () => {
    expect(fastCopyChoices(false, false).map((f) => f.value)).toEqual(['h264']);
    expect(fastCopyChoices(false, true).map((f) => f.value)).toEqual(['h264']);
    expect(fastCopyChoices(true, false).map((f) => f.value)).toEqual(['h264']);
    expect(fastCopyChoices(true, true).map((f) => f.value)).toEqual(['h264', 'hap', 'hap_q', 'hap_alpha']);
  });
  it('labels follow the rules of option labels: short, no parentheses', () => {
    for (const f of FAST_COPY_FORMATS) {
      expect(f.label.length, f.label).toBeLessThanOrEqual(24);
      expect(f.label).not.toMatch(/[()]/);
    }
  });
  it('the hint says when HAP is worth it and that the files are large', () => {
    for (const word of [/several clips/, /transparency/, /desktop graphics card/, /large/]) expect(HAP_COPY_HINT).toMatch(word);
  });
  it('knows a fast copy by its name or by being HAP', () => {
    expect(isFastCopy({ name: 'clip fast.mp4' })).toBe(true);
    expect(isFastCopy({ name: 'clip fast.webm' })).toBe(true);
    expect(isFastCopy({ name: 'clip fast.mov', codec: 'HAP Q' })).toBe(true);
    expect(isFastCopy({ name: 'loop.mov', codec: 'HAP' })).toBe(true);
    expect(isFastCopy({ name: 'clip.mp4', codec: 'H.264 (AVC)' })).toBe(false);
    expect(isFastCopy({ name: 'breakfast.mov', codec: 'Apple ProRes' })).toBe(false);
    expect(isFastCopy({ name: 'happy.mov', codec: 'HAPPY' })).toBe(false);
  });
});

describe('answers of the desktop app', () => {
  it('reads them carefully', () => {
    expect(parseHapConvertInfo({ available: true, hap: true })).toEqual({ available: true, hap: true });
    expect(parseHapConvertInfo({ available: false, hap: true })).toEqual({ available: false, hap: false });
    expect(parseHapConvertInfo(null)).toEqual({ available: false, hap: false });
    expect(parseHapConvertStatus({ state: 'running', fraction: 2, bytes: -1 })).toEqual({ state: 'running', fraction: 1, bytes: 0, error: null });
    expect(parseHapConvertStatus({ state: 'error', error: 'FFmpeg stopped' }).error).toBe('FFmpeg stopped');
    expect(parseHapConvertStatus({ state: 'nonsense' })).toMatchObject({ state: 'error', error: 'The conversion failed.' });
  });
  it('the web version never calls out', async () => {
    let calls = 0;
    const client = new DesktopClient(async () => (calls++, new Response('{}')), 'app://rsmps/__rsmps/', () => false);
    await expect(client.hapInfo()).rejects.toThrow(/desktop app/);
    await expect(client.hapRead('x', 0, 1)).rejects.toThrow(/desktop app/);
    expect(calls).toBe(0);
  });
});

/** The main process, played by a few lines: stores the upload, "converts" by reversing the bytes, hands the result back. */
function fakeDesktop(opts: { failWith?: string; steps?: number } = {}) {
  const log: string[] = [];
  let upload = new Uint8Array(0);
  let result = new Uint8Array(0);
  let polls = 0;
  const steps = opts.steps ?? 3;
  const routes = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.replace('app://rsmps/__rsmps/', '');
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (path === 'hap-convert/start') {
      log.push(`start ${String(init?.body)}`);
      return json({ id: 'j1', width: 1280, height: 720 });
    }
    if (path === 'hap-convert/j1/chunk') {
      const piece = new Uint8Array(init!.body as ArrayBuffer);
      const next = new Uint8Array(upload.length + piece.length);
      next.set(upload);
      next.set(piece, upload.length);
      upload = next;
      log.push(`chunk ${piece.length}`);
      return json({ bytes: upload.length });
    }
    const status = (): HapConvertStatus => {
      polls++;
      if (opts.failWith && polls > 1) return { state: 'error', fraction: 0, bytes: 0, error: opts.failWith };
      if (polls <= steps) return { state: 'running', fraction: polls / (steps + 1), bytes: 0, error: null };
      result = upload.slice().reverse();
      return { state: 'done', fraction: 1, bytes: result.length, error: null };
    };
    if (path === 'hap-convert/j1/run') return (log.push('run'), json(status()));
    if (path === 'hap-convert/j1') return json(status());
    if (path.startsWith('hap-convert/j1/result')) {
      const q = new URL(url.replace('app:', 'http:')).searchParams;
      const at = Number(q.get('at'));
      log.push(`read ${at}+${q.get('length')}`);
      return new Response(result.slice(at, at + Number(q.get('length'))));
    }
    if (path === 'hap-convert/j1/cancel') return (log.push('cancel'), json({ canceled: true }));
    return json({ error: 'nope' }, 404);
  };
  return { log, client: new DesktopClient(routes, 'app://rsmps/__rsmps/', () => true) };
}

const INFO = { width: 1920, height: 1080, fps: 30, duration: 4 };
const noWait = async () => undefined;

describe('making a HAP copy through the desktop app', () => {
  it('hands the clip over, waits for FFmpeg, reads the result back and tidies up', async () => {
    const { log, client } = fakeDesktop();
    const src = new Uint8Array(1000).map((_, i) => i % 251);
    const seen: number[] = [];
    const file = await makeHapCopy(new Blob([src]), 'holiday clip.MP4', INFO, { format: 'hap_q', maxSide: 1280, client, wait: noWait, onProgress: (f) => seen.push(f) });
    expect(file.name).toBe('holiday clip fast.mov');
    expect(file.type).toBe('video/quicktime');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(src.slice().reverse());
    expect(JSON.parse(log[0].slice(6))).toEqual({ format: 'hap_q', width: 1920, height: 1080, maxSide: 1280, duration: 4, fps: 30, ext: 'mp4' });
    expect(log.slice(1)).toEqual(['chunk 1000', 'run', 'read 0+1000', 'cancel']);
    // progress only ever goes forward and ends at 1
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('a failing FFmpeg is reported with its reason, and the work folder is still removed', async () => {
    const { log, client } = fakeDesktop({ failWith: 'FFmpeg could not read this clip.' });
    await expect(makeHapCopy(new Blob([new Uint8Array(10)]), 'a.mov', INFO, { format: 'hap', maxSide: 1280, client, wait: noWait })).rejects.toThrow('FFmpeg could not read this clip.');
    expect(log[log.length - 1]).toBe('cancel');
  });

  it('cancel stops between steps with an AbortError, and tidies up', async () => {
    const { log, client } = fakeDesktop({ steps: 50 });
    const ac = new AbortController();
    let waits = 0;
    const p = makeHapCopy(new Blob([new Uint8Array(10)]), 'a.mov', INFO, { format: 'hap', maxSide: 1280, client, signal: ac.signal, wait: async () => void (++waits === 2 && ac.abort()) });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(log[log.length - 1]).toBe('cancel');
    expect(log.some((l) => l.startsWith('read'))).toBe(false);
  });

  it('a clip of unknown size is refused before anything is sent', async () => {
    const { log, client } = fakeDesktop();
    await expect(makeHapCopy(new Blob([new Uint8Array(10)]), 'a.mov', { ...INFO, width: 0 }, { format: 'hap', maxSide: 1280, client })).rejects.toThrow(/size of this clip/);
    expect(log).toEqual([]);
  });
});
