import type { Io, ScanManualInput, ScanResult } from '../../io/api';

/**
 * Scan tab persistence, written against the names the IO layer is adding (`saveScanSession`, `loadScanSession`,
 * `io.scan.restore`, `createScanProject`). Every call is guarded: when the IO side lacks them the Scan tab still
 * works, it just is not saved across reloads.
 */
export interface ScanSessionDoc {
  /** The photos the user dropped, in order. */
  files: File[];
  /** Manual corner / layout fixes per page index. */
  manual: { pageIndex: number; input: ScanManualInput }[];
  /** Panel options and the last export settings. */
  options: Record<string, unknown>;
}

interface ScanStorage {
  createScanProject?(name?: string): Promise<{ id: string; name: string }>;
  saveScanSession?(id: string, session: ScanSessionDoc): Promise<void> | void;
  loadScanSession?(id: string): Promise<ScanSessionDoc | null>;
}

const store = (io: Io) => io.projects as unknown as ScanStorage;

export const canCreateScan = (io: Io): boolean => typeof store(io).createScanProject === 'function';
export const createScanProject = (io: Io, name?: string) => store(io).createScanProject!.call(io.projects, name);
export const saveSession = (io: Io, id: string, s: ScanSessionDoc): void => {
  try {
    void store(io).saveScanSession?.call(io.projects, id, s);
  } catch {
    /* storage unavailable */
  }
};
export const loadSession = (io: Io, id: string): Promise<ScanSessionDoc | null> => store(io).loadScanSession?.call(io.projects, id) ?? Promise.resolve(null);

/** Re-run the analysis for a saved session (photos, then the manual fixes in order). */
export async function restoreSession(io: Io, s: ScanSessionDoc): Promise<ScanResult> {
  const restore = (io.scan as unknown as { restore?(s: ScanSessionDoc): Promise<ScanResult> }).restore;
  if (restore) return restore.call(io.scan, s);
  let r = await io.scan.analyze(s.files);
  for (const m of s.manual) r = await r.reanalyzePage(m.pageIndex, m.input);
  return r;
}
