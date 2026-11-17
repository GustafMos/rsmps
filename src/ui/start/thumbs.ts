/**
 * Template thumbnails: rendered once on demand with the engine at a small size, then cached in a small IndexedDB of their own
 * (`rsmps-templates`; the app's presets store is left alone). Never runs at startup: the start screen asks for them one at a time
 * after it has appeared. A template with no picture yet (it needs media) gets none and shows an icon.
 */
import { imageToBlob } from '../../io/encode';
import type { ImageValue } from '../../engine/types';
import { templateGraph, templateHash, type Template } from '../../io/templates';
import type { AppCtx } from '../store/context';

const DB = 'rsmps-templates';
const STORE = 'thumbs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function get(key: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as Blob | undefined);
    r.onerror = () => resolve(undefined);
  });
}
async function put(key: string, blob: Blob): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const urls = new Map<string, string>();
let chain: Promise<unknown> = Promise.resolve();

/** Object URL of the template's thumbnail, or null (needs media / could not render). Calls are serialized. */
export function templateThumb(app: AppCtx, t: Template): Promise<string | null> {
  const key = `${t.id}:${templateHash(t)}`;
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  const job = chain.then(async () => {
    try {
      const cached = await get(key);
      if (cached) {
        const u = URL.createObjectURL(cached);
        urls.set(key, u);
        return u;
      }
      if (t.needs) return null;
      const g = templateGraph(t);
      const out = g.nodes.find((n) => app.io.registry.get(n.type)?.category === 'output');
      if (!out) return null;
      const v = (await app.io.evaluate(g, out.id, { proxy: Math.min(1, 240 / Math.max(g.project.width, g.project.height)), seconds: 0 })) as ImageValue | null;
      if (!v || v.kind !== 'image') return null;
      const blob = await imageToBlob(app.io.engine.gpu, v, 'image/webp', 0.8);
      await put(key, blob);
      const u = URL.createObjectURL(blob);
      urls.set(key, u);
      return u;
    } catch {
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, 120)); // breathe between renders
    }
  });
  chain = job.catch(() => undefined);
  return job;
}
