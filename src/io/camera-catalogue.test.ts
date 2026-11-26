import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { facingOfLabel, loadCatalogue, nameCameras, noteCamera, recordFromTrack, renameCamera, resetCatalogueCache } from './camera-catalogue';

function fakeStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  return data;
}
beforeEach(() => resetCatalogueCache());
afterEach(() => vi.unstubAllGlobals());

describe('camera labels', () => {
  it('reads the side from Android Chrome labels', () => {
    expect(facingOfLabel('camera2 0, facing back')).toBe('back');
    expect(facingOfLabel('camera2 1, facing front')).toBe('front');
  });
  it('says nothing for desktop and empty labels', () => {
    expect(facingOfLabel('HD Pro Webcam C920 (046d:082d)')).toBe('unknown');
    expect(facingOfLabel('')).toBe('unknown');
  });
});

describe('camera names', () => {
  it('names unmeasured cameras by side, numbering only when several face the same way', () => {
    const n = nameCameras([{ id: 'a', label: 'camera2 0, facing back' }, { id: 'b', label: 'camera2 2, facing back' }, { id: 'c', label: 'camera2 1, facing front' }], {});
    expect(n.map((x) => x.label)).toEqual(['Back camera 1', 'Back camera 2', 'Front camera']);
  });
  it('shows what a measured camera reported, as a range and never as a lens', () => {
    const cat = {
      a: { facing: 'back' as const, zoomMin: 0.6, zoomMax: 10, maxWidth: 4000, maxHeight: 3000 },
      b: { facing: 'back' as const, maxWidth: 3264, maxHeight: 2448 },
      c: { facing: 'front' as const, maxWidth: 4000, maxHeight: 3000 },
    };
    const n = nameCameras([{ id: 'a', label: 'camera2 0, facing back' }, { id: 'b', label: 'camera2 2, facing back' }, { id: 'c', label: 'camera2 1, facing front' }], cat);
    expect(n.map((x) => x.label)).toEqual(['Back 1 · zoom 0.6x–10x · 12 MP', 'Back 2 · 8 MP', 'Front · 12 MP']);
    expect(n.some((x) => /\b3x\b/.test(x.label))).toBe(false);
  });
  it('keeps a desktop label, and falls back to Camera N only when nothing is known', () => {
    const n = nameCameras([{ id: 'a', label: 'HD Pro Webcam C920 (046d:082d)' }, { id: 'b', label: '' }], {});
    expect(n.map((x) => x.label)).toEqual(['HD Pro Webcam C920 (046d:082d)', 'Camera 2']);
  });
  it('remembers the side of a camera whose label is gone', () => {
    const n = nameCameras([{ id: 'a', label: '' }], { a: { facing: 'front' } });
    expect(n[0].label).toBe('Front camera');
  });
  it('the owner\'s name wins', () => {
    expect(nameCameras([{ id: 'a', label: 'camera2 0, facing back' }], { a: { name: 'Wide' } })[0].label).toBe('Wide');
  });
  it('reads a measurement from an open track', () => {
    const r = recordFromTrack({ zoom: { min: 1, max: 8 }, width: { max: 4000 }, height: { max: 3000 }, frameRate: { max: 60 }, torch: true }, { facingMode: 'environment' });
    expect(r).toEqual({ facing: 'back', zoomMin: 1, zoomMax: 8, maxWidth: 4000, maxHeight: 3000, maxFps: 60, torch: true });
  });
});

describe('camera catalogue storage', () => {
  it('keeps names and measurements per camera between visits', () => {
    const data = fakeStorage();
    noteCamera('a', { facing: 'back', maxWidth: 4000, maxHeight: 3000 });
    renameCamera('a', '  Wide  ');
    expect(JSON.parse(data.get('rsmps.cameras.v1')!).a.name).toBe('Wide');
    resetCatalogueCache();
    expect(loadCatalogue().a).toMatchObject({ name: 'Wide', maxWidth: 4000 });
    renameCamera('a', '');
    expect(loadCatalogue().a.name).toBeUndefined();
  });
  it('storage that throws breaks nothing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadCatalogue()).toEqual({});
    expect(() => noteCamera('a', { facing: 'front' })).not.toThrow();
    expect(() => renameCamera('a', 'Me')).not.toThrow();
    expect(nameCameras([{ id: 'a', label: '' }])[0].label).toBe('Me'); // still works for this visit
  });
  it('damaged storage is ignored', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: () => undefined });
    expect(loadCatalogue()).toEqual({});
  });
});
