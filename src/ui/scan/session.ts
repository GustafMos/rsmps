import type { Io, ScanSession } from '../../io/api';

export type { ScanSession };

export const emptySession = (): ScanSession => ({ photos: [], manual: {}, options: {} });

export const createScanProject = (io: Io, name?: string) => io.projects.createScanProject(name);
export const saveSession = (io: Io, id: string, s: ScanSession): void => {
  try {
    io.projects.saveScanSession(id, s);
  } catch {
    /* storage unavailable */
  }
};
export const loadSession = async (io: Io, id: string): Promise<ScanSession> => (await io.projects.loadScanSession(id)) ?? emptySession();
export const photoFiles = (s: ScanSession): File[] => s.photos.map((p) => new File([p.blob], p.name, { type: p.blob.type }));
