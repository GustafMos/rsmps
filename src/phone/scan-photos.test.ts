import { describe, expect, it } from 'vitest';
import { addThumb, applyStatus, compactRanges, missingLines, progressLine, setProgress, setSent, setUploadFailed, thumbLabel, type Thumb } from './scan-photos';

const base = (): Thumb[] => addThumb([], { id: 1, name: 'a.jpg', size: 10 });

describe('thumbnail statuses', () => {
  it('goes sending -> waiting -> scanning -> done with the sheet and frames', () => {
    let l = base();
    expect(thumbLabel(l[0])).toBe('Sending 0%');
    l = setProgress(l, 1, 0.456);
    expect(thumbLabel(l[0])).toBe('Sending 46%');
    l = setSent(l, 1);
    expect(thumbLabel(l[0])).toBe('Waiting');
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'scanning' });
    expect(thumbLabel(l[0])).toBe('Scanning…');
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'done', sheet: 3, sheets: 6, frames: [13, 18] });
    expect(thumbLabel(l[0])).toBe('Sheet 3 of 6, frames 13–18');
    expect(l[0].retake).toBe(false);
  });
  it('a failed photo says why and offers a retake', () => {
    let l = setSent(base(), 1);
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'failed', note: 'Corner marker not found', retake: true });
    expect(thumbLabel(l[0])).toBe('Failed: Corner marker not found');
    expect(l[0].retake).toBe(true);
  });
  it('never moves a photo backwards (a late "received" after "done")', () => {
    let l = setSent(base(), 1);
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'done', sheet: 1, frames: [1, 1] });
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'received' });
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'scanning' });
    expect(l[0].state).toBe('done');
  });
  it('a later result can still change a done photo (better duplicate) and statuses for other ids are ignored', () => {
    let l = addThumb(setSent(base(), 1), { id: 2, name: 'b.jpg', size: 5 });
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'done', sheet: 1, frames: [1, 6] });
    l = applyStatus(l, { type: 'scan-status', id: 1, state: 'done', sheet: 1, frames: [1, 6], note: 'Not used' });
    l = applyStatus(l, { type: 'scan-status', id: 99, state: 'failed' });
    expect(l[0].note).toBe('Not used');
    expect(l[1].state).toBe('sending');
  });
  it('an upload that failed is not a scan failure and can be sent again', () => {
    let l = setUploadFailed(base(), 1, 'The computer did not answer');
    expect(thumbLabel(l[0])).toBe('Not sent: The computer did not answer');
    expect(l[0].retake).toBe(false);
    l = addThumb(l, { id: 1, name: 'a.jpg', size: 10 }); // resend replaces it
    expect(l).toHaveLength(1);
    expect(l[0].state).toBe('sending');
  });
});

describe('what is missing', () => {
  it('lists sheets, else frames, in plain words', () => {
    expect(missingLines({ sheets: 6, missingSheets: [4, 6], missingFrames: [19, 20] })).toEqual(['Sheet 4 not scanned yet', 'Sheet 6 not scanned yet']);
    expect(missingLines({ sheets: 6, missingSheets: [], missingFrames: [3, 4, 5, 9] })).toEqual(['Frames 3–5, 9 missing']);
    expect(missingLines({ sheets: 6, missingSheets: [], missingFrames: [7] })).toEqual(['Frame 7 missing']);
    expect(missingLines({ sheets: 6, missingSheets: [], missingFrames: [] })).toEqual([]);
  });
  it('compacts ranges', () => {
    expect(compactRanges([1, 2, 3, 7, 9, 10, 3])).toBe('1–3, 7, 9–10');
  });
  it('counts sheets that have a good photo', () => {
    let l = addThumb([], { id: 1, name: 'a', size: 1 });
    l = addThumb(l, { id: 2, name: 'b', size: 1 });
    l = applyStatus(setSent(setSent(l, 1), 2), { type: 'scan-status', id: 1, state: 'done', sheet: 3, sheets: 6, frames: [1, 2] });
    expect(progressLine(l, { sheets: 6 })).toBe('1 of 6 sheets scanned');
    expect(progressLine([], null)).toBe('No photos yet');
    expect(progressLine(l, null)).toBe('1 of 6 sheets scanned');
  });
});
