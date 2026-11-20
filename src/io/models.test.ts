import { describe, expect, it, vi } from 'vitest';
import { DEPTH_AI_MODEL } from '../engine/lib/depth-ai-bridge';
import { DEPTH_ANYTHING_V2_SMALL_ID, MODEL_CATALOGUE, STYLE_AI_MODEL_IDS, modelEntry, type ModelEntry } from './model-catalogue';
import { STYLE_AI_MODEL } from '../engine/lib/style-ai-bridge';
import { MemoryModelBackend, ModelStore, describeNetworkError } from './models';

const FILE = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
const ENTRY: ModelEntry = { ...MODEL_CATALOGUE[0], id: 'fake', bytes: FILE.length, sha256: 'GOODHASH', url: 'https://example.invalid/m.onnx' };
const fakeHash = async (d: Uint8Array) => (d.length === FILE.length && d.every((v, i) => v === FILE[i]) ? 'GOODHASH' : 'OTHERHASH');

/** A fake fetch: serves FILE in chunks, can break the connection after N bytes, ignore Range, fail with a status or a network error. */
function fakeFetch(o: { breakAfter?: number[]; ignoreRange?: boolean; status?: number; networkError?: boolean; body?: Uint8Array; chunk?: number } = {}) {
  const calls: { range: string | null }[] = [];
  const breaks = [...(o.breakAfter ?? [])];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    calls.push({ range });
    if (o.networkError) throw new TypeError('Failed to fetch');
    if (o.status && o.status !== 200) return new Response('no', { status: o.status, statusText: 'Nope' });
    const body = o.body ?? FILE;
    let from = 0;
    let status = 200;
    if (range && !o.ignoreRange) {
      from = Number(/bytes=(\d+)-/.exec(range)![1]);
      status = 206;
    }
    const cut = breaks.shift();
    const part = body.slice(from, cut === undefined ? body.length : from + cut);
    const chunk = o.chunk ?? 300;
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= part.length) {
          if (cut !== undefined && from + cut < body.length) c.error(new TypeError('network error'));
          else c.close();
          return;
        }
        c.enqueue(part.slice(at, at + chunk));
        at += chunk;
      },
    });
    return new Response(stream, { status });
  });
  return { fn: fn as unknown as typeof fetch, calls, spy: fn };
}

const make = (f: ReturnType<typeof fakeFetch>, backend = new MemoryModelBackend(), extra: Partial<ConstructorParameters<typeof ModelStore>[0]> = {}) =>
  ({ store: new ModelStore({ fetch: f.fn, backend, sha256: fakeHash, catalogue: [ENTRY], retryDelayMs: 0, ...extra }), backend });

describe('model catalogue', () => {
  it('pins every model by revision, size and checksum, with a permissive licence, and offers nothing non-commercial', () => {
    expect(MODEL_CATALOGUE.map((m) => m.id)).toEqual([DEPTH_ANYTHING_V2_SMALL_ID, STYLE_AI_MODEL.encoder, STYLE_AI_MODEL.decoder]);
    for (const m of MODEL_CATALOGUE) {
      expect(m.revision, m.id).toMatch(/^[0-9a-f]{40}$/);
      expect(m.sha256, m.id).toMatch(/^[0-9a-f]{64}$/);
      expect(m.url, m.id).toBe(`${m.sourceUrl}/resolve/${m.revision}/${m.file}`);
      expect(m.url.startsWith('https://huggingface.co/'), m.id).toBe(true);
      expect(['Apache-2.0', 'MIT'], m.id).toContain(m.license.name);
      expect(m.license.url, m.id).toMatch(/^https:\/\//);
      expect(m.attribution, m.id).toContain(m.license.name);
    }
    const m = modelEntry(DEPTH_ANYTHING_V2_SMALL_ID)!;
    expect(m.revision).toBe(DEPTH_AI_MODEL.revision);
    expect(m.bytes).toBeGreaterThan(40_000_000);
    expect(m.license.name).toBe('Apache-2.0');
    expect(m.attribution).toBe('Depth Anything V2 Small © the Depth Anything authors, Apache-2.0');
    expect(JSON.stringify(MODEL_CATALOGUE)).not.toMatch(/base|large|giant|CC-BY-NC/i);
  });

  it('the style transfer model is two MIT files from one pinned revision, checked on the real files', () => {
    expect(STYLE_AI_MODEL_IDS).toEqual([STYLE_AI_MODEL.encoder, STYLE_AI_MODEL.decoder]);
    const enc = modelEntry(STYLE_AI_MODEL.encoder)!;
    const dec = modelEntry(STYLE_AI_MODEL.decoder)!;
    expect([enc.revision, dec.revision]).toEqual([STYLE_AI_MODEL.revision, STYLE_AI_MODEL.revision]);
    expect([enc.file, enc.bytes, enc.sha256]).toEqual(['adain-vgg.onnx', 14025860, 'ac62bbef78a38bd952364c6db91048ab9703ebc7ee45ebb06e6438e5f5da4de4']);
    expect([dec.file, dec.bytes, dec.sha256]).toEqual(['adain-decoder.onnx', 14026124, 'a549863dfcf18f747d615794cb58a663d2fc829fa36c3fef18355c1e7f4843db']);
    expect([enc.license.name, dec.license.name]).toEqual(['MIT', 'MIT']);
    // the encoder is VGG-19's first layers: its authors are credited too
    expect(enc.attribution).toMatch(/Naoto Inoue, MIT.*Visual Geometry Group.*CC BY 4\.0/);
    // the picture goes in as it is: no mean / spread correction on our side
    expect([enc.mean, enc.std, enc.inputMultiple]).toEqual([[0, 0, 0], [1, 1, 1], STYLE_AI_MODEL.stride]);
  });
});

describe('model store', () => {
  it('never downloads by itself: creating, refreshing and reading the status fetch nothing', async () => {
    const f = fakeFetch();
    const { store } = make(f);
    expect(store.status('fake')).toEqual({ state: 'absent' });
    await store.refresh('fake');
    expect(await store.bytes('fake')).toBeNull();
    expect(await store.read('fake')).toBeNull();
    expect(f.spy).not.toHaveBeenCalled();
  });

  it('downloads with progress, verifies the whole file, then stores it', async () => {
    const f = fakeFetch();
    const { store, backend } = make(f);
    const seen: number[] = [];
    store.subscribe(() => {
      const s = store.status('fake');
      if (s.state === 'downloading' && s.phase === 'downloading') seen.push(s.received);
    });
    const s = await store.download('fake');
    expect(s).toEqual({ state: 'ready', bytes: 1000 });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1000);
    expect(backend.files.get('fake')?.size).toBe(1000);
    expect(Array.from((await store.read('fake'))!)).toEqual(Array.from(FILE));
    expect(f.spy).toHaveBeenCalledTimes(1);
    // the request carries no cookies and no referrer
    expect(f.spy.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('refuses a file whose checksum does not match and stores nothing', async () => {
    const bad = FILE.slice();
    bad[500] ^= 0xff;
    const { store, backend } = make(fakeFetch({ body: bad }));
    const s = await store.download('fake');
    expect(s.state).toBe('failed');
    expect((s as { error: string }).error).toMatch(/checksum/i);
    expect(backend.files.size).toBe(0);
    expect(await store.bytes('fake')).toBeNull();
  });

  it('refuses a file of the wrong size and stores nothing', async () => {
    const { store, backend } = make(fakeFetch({ body: FILE.slice(0, 900) }), new MemoryModelBackend(), { retries: 0 });
    const s = await store.download('fake');
    expect(s.state).toBe('failed');
    expect(backend.files.size).toBe(0);
  });

  it('resumes a broken connection with a Range request and still checks the whole file', async () => {
    const f = fakeFetch({ breakAfter: [400, 300] });
    const { store, backend } = make(f);
    const s = await store.download('fake');
    expect(s).toEqual({ state: 'ready', bytes: 1000 });
    expect(f.calls.map((c) => c.range)).toEqual([null, 'bytes=400-', 'bytes=700-']);
    expect(Array.from(new Uint8Array(await backend.files.get('fake')!.arrayBuffer()))).toEqual(Array.from(FILE));
  });

  it('restarts from zero when the server ignores Range, and gives up with a plain message after the retries', async () => {
    const f = fakeFetch({ breakAfter: [400], ignoreRange: true });
    const { store } = make(f);
    expect((await store.download('fake')).state).toBe('ready');
    expect(f.calls.map((c) => c.range)).toEqual([null, 'bytes=400-']);

    const dead = fakeFetch({ networkError: true });
    const { store: s2, backend } = make(dead, new MemoryModelBackend(), { retries: 2 });
    const r = await s2.download('fake');
    expect((r as { error: string }).error).toMatch(/Could not reach .*internet connection/);
    expect(dead.spy).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(backend.files.size).toBe(0);
  });

  it('reports a server error plainly and allows a retry that succeeds', async () => {
    const down = fakeFetch({ status: 503 });
    const backend = new MemoryModelBackend();
    const a = make(down, backend, { retries: 0 }).store;
    const r = await a.download('fake');
    expect((r as { error: string }).error).toMatch(/answered 503/);
    const b = make(fakeFetch(), backend).store;
    expect((await b.download('fake')).state).toBe('ready');
  });

  it('cancel leaves nothing behind and the status goes back to absent', async () => {
    const f = fakeFetch({ chunk: 10 });
    const { store, backend } = make(f);
    const p = store.download('fake');
    store.subscribe(() => {
      const s = store.status('fake');
      if (s.state === 'downloading' && s.received > 100) store.cancel('fake');
    });
    expect((await p).state).toBe('absent');
    expect(backend.files.size).toBe(0);
  });

  it('remove deletes the stored file; refresh finds an existing one and drops a half-written one', async () => {
    const f = fakeFetch();
    const { store, backend } = make(f);
    await store.download('fake');
    await store.remove('fake');
    expect(store.status('fake')).toEqual({ state: 'absent' });
    expect(backend.files.size).toBe(0);
    await backend.put('fake', new Blob([FILE]));
    expect((await store.refresh('fake')).state).toBe('ready');
    await backend.put('fake', new Blob([FILE.slice(0, 10)]));
    expect((await store.refresh('fake')).state).toBe('absent');
    expect(backend.files.size).toBe(0);
  });

  it('a second download while one runs does not start another request', async () => {
    const f = fakeFetch();
    const { store } = make(f);
    const [a, b] = await Promise.all([store.download('fake'), store.download('fake')]);
    expect(a.state).toBe('ready');
    expect(b.state === 'ready' || b.state === 'downloading').toBe(true);
    expect(f.spy).toHaveBeenCalledTimes(1);
  });

  it('writes network errors as sentences', () => {
    expect(describeNetworkError(new TypeError('Failed to fetch'), 'huggingface.co')).toBe('Could not reach huggingface.co. Check your internet connection and try again.');
    expect(describeNetworkError(new Error('boom'), 'x')).toBe('boom');
  });
});
