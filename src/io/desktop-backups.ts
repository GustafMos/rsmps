/**
 * Desktop app only: mirrors autosave backups into files in the user-data folder (so a damaged IndexedDB is not the end), and lists
 * / reads / reveals them. In the web version every function here does nothing (`isDesktop()` guards fetch).
 * The main-process half is desktop/backups.mjs, served under app://rsmps/__rsmps/backups.
 */
import type { GraphDoc } from '../engine/types';
import type { BackupEntry } from './backups';
import { desktopUrl, isDesktop } from './desktop';

export interface FileBackup {
  project: string;
  name: string;
  at: number;
  /** Path relative to the backups folder (opaque: pass it back to `readFileBackup`). */
  file: string;
  bytes: number;
}

export function parseFileBackups(raw: unknown): FileBackup[] {
  const list = raw && typeof raw === 'object' ? (raw as { backups?: unknown }).backups : undefined;
  if (!Array.isArray(list)) return [];
  const out: FileBackup[] = [];
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.file !== 'string' || typeof o.project !== 'string' || typeof o.at !== 'number') continue;
    out.push({ project: o.project, name: typeof o.name === 'string' ? o.name : 'Untitled', at: o.at, file: o.file, bytes: typeof o.bytes === 'number' ? o.bytes : 0 });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Fire and forget. */
export function mirrorBackup(project: string, entry: BackupEntry): void {
  if (!isDesktop()) return;
  void fetch(desktopUrl('backups'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, name: entry.name, at: entry.at, graph: entry.graph }),
  }).catch(() => undefined);
}

export async function listFileBackups(): Promise<FileBackup[]> {
  if (!isDesktop()) return [];
  try {
    const r = await fetch(desktopUrl('backups'));
    return r.ok ? parseFileBackups(await r.json()) : [];
  } catch {
    return [];
  }
}

export async function readFileBackup(file: string): Promise<GraphDoc | null> {
  if (!isDesktop()) return null;
  try {
    const r = await fetch(desktopUrl(`backups/file?name=${encodeURIComponent(file)}`));
    return r.ok ? ((await r.json()) as GraphDoc) : null;
  } catch {
    return null;
  }
}

/** Opens the backups folder in the file manager. Resolves the folder path, or null. */
export async function revealBackupsFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const r = await fetch(desktopUrl('backups/reveal'), { method: 'POST' });
    const j = (await r.json()) as { path?: unknown };
    return typeof j.path === 'string' ? j.path : null;
  } catch {
    return null;
  }
}
