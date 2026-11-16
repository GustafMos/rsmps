/**
 * The phone's list of photos and what the computer says about them (pure: used by the thumbnail strip and unit-tested).
 * A photo goes: sending -> (received) -> scanning -> done | failed. Statuses arrive as `scan-status` messages.
 */
import type { ScanStatusMsg, ScanSummaryMsg } from './scan-protocol';

export type ThumbState = 'sending' | 'queued' | 'scanning' | 'done' | 'failed';
export type CapturePathName = 'takePhoto' | 'grabFrame' | 'nativeCamera';

export interface Thumb {
  id: number;
  name: string;
  state: ThumbState;
  /** Upload progress 0..1. */
  progress: number;
  size: number;
  path?: CapturePathName;
  sheet?: number;
  sheets?: number;
  frames?: [number, number];
  note?: string;
  retake?: boolean;
  /** The upload itself failed (not the scan): the photo is still on the phone and can be sent again. */
  uploadFailed?: boolean;
}

export function addThumb(list: readonly Thumb[], t: Pick<Thumb, 'id' | 'name' | 'size'> & Partial<Thumb>): Thumb[] {
  return [...list.filter((x) => x.id !== t.id), { state: 'sending', progress: 0, ...t }];
}

export function setProgress(list: readonly Thumb[], id: number, progress: number): Thumb[] {
  return list.map((t) => (t.id === id && t.state === 'sending' ? { ...t, progress: Math.max(0, Math.min(1, progress)) } : t));
}

/** The upload finished: the computer has the file and will scan it. */
export function setSent(list: readonly Thumb[], id: number): Thumb[] {
  return list.map((t) => (t.id === id && t.state === 'sending' ? { ...t, state: 'queued', progress: 1 } : t));
}

export function setUploadFailed(list: readonly Thumb[], id: number, reason: string): Thumb[] {
  return list.map((t) => (t.id === id ? { ...t, state: 'failed', note: reason, uploadFailed: true, retake: false } : t));
}

/** A status from the computer. Statuses never move a photo backwards (a late 'received' after 'done' is ignored). */
export function applyStatus(list: readonly Thumb[], s: ScanStatusMsg): Thumb[] {
  const rank: Record<ThumbState, number> = { sending: 0, queued: 1, scanning: 2, done: 3, failed: 3 };
  return list.map((t) => {
    if (t.id !== s.id) return t;
    const next: ThumbState = s.state === 'received' ? 'queued' : s.state;
    if (rank[next] < rank[t.state] && !(t.uploadFailed && next === 'queued')) return t;
    if (next === 'done') return { ...t, state: 'done', progress: 1, sheet: s.sheet, sheets: s.sheets, frames: s.frames, note: s.note, retake: false, uploadFailed: false };
    if (next === 'failed') return { ...t, state: 'failed', progress: 1, note: s.note ?? 'This photo could not be read.', retake: s.retake !== false, uploadFailed: false };
    return { ...t, state: next, progress: 1, uploadFailed: false };
  });
}

export function removeThumb(list: readonly Thumb[], id: number): Thumb[] {
  return list.filter((t) => t.id !== id);
}

/** Short line under a thumbnail. */
export function thumbLabel(t: Thumb): string {
  switch (t.state) {
    case 'sending':
      return `Sending ${Math.round(t.progress * 100)}%`;
    case 'queued':
      return 'Waiting';
    case 'scanning':
      return 'Scanning…';
    case 'done': {
      const where = t.sheet ? `Sheet ${t.sheet}${t.sheets ? ` of ${t.sheets}` : ''}` : 'Done';
      return t.frames ? `${where}, frames ${frameRange(t.frames)}` : where;
    }
    case 'failed':
      return t.uploadFailed ? `Not sent: ${t.note ?? 'upload failed'}` : `Failed: ${t.note ?? 'could not be read'}`;
  }
}

export const frameRange = (f: [number, number]): string => (f[0] === f[1] ? String(f[0]) : `${f[0]}–${f[1]}`);

/** "Sheet 4 not scanned yet" lines for the reshoot list. */
export function missingLines(s: Pick<ScanSummaryMsg, 'sheets' | 'missingSheets' | 'missingFrames'>): string[] {
  const out = s.missingSheets.map((n) => `Sheet ${n} not scanned yet`);
  if (!s.missingSheets.length && s.missingFrames.length) out.push(`Frame${s.missingFrames.length > 1 ? 's' : ''} ${compactRanges(s.missingFrames)} missing`);
  return out;
}

/** [1,2,3,7,9,10] -> "1–3, 7, 9–10". */
export function compactRanges(nums: readonly number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

/** The "Sheet 3 of 6" line shown above the thumbnails: the sheets that have a good photo so far. */
export function progressLine(list: readonly Thumb[], summary: Pick<ScanSummaryMsg, 'sheets'> | null): string {
  const done = new Set(list.filter((t) => t.state === 'done' && t.sheet).map((t) => t.sheet));
  const sheets = summary?.sheets || Math.max(0, ...list.map((t) => t.sheets ?? 0));
  if (!list.length) return 'No photos yet';
  if (sheets > 0) return `${done.size} of ${sheets} sheets scanned`;
  return `${list.length} photo${list.length === 1 ? '' : 's'} taken`;
}
