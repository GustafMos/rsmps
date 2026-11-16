/**
 * `ScanImpl.append` (used by "Scan with phone"): only the new photos go through the pool, earlier pages keep their results.
 * In Node nothing can decode a picture, so every photo ends as the usual failed page; that is enough to see which photos were scanned.
 */
import { describe, expect, it } from 'vitest';
import type { MediaLibrary, ScanProgressEvent } from './api';
import { ScanImpl } from './scan';

const file = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], name, { type: 'image/jpeg' });

describe('ScanImpl.append', () => {
  it('scans only the new photos and keeps the old pages (by position), so reports and indices line up', async () => {
    const impl = new ScanImpl({} as MediaLibrary);
    const first = await impl.analyze([file('a.jpg'), file('b.jpg')]);
    expect(first.report.pages.map((p) => p.fileName).sort()).toEqual(['a.jpg', 'b.jpg']);
    const events: ScanProgressEvent[] = [];
    const next = await impl.append(first, [file('c.jpg')], {}, { onProgress: (e) => events.push(e) });
    // progress only mentions the one new photo
    expect(new Set(events.map((e) => e.fileName))).toEqual(new Set(['c.jpg']));
    expect(events.every((e) => e.total === 1 && e.index === 0)).toBe(true);
    expect(events.map((e) => e.state)).toContain('failed'); // nothing decodes in Node: the job ends as a failed page
    // the result has all three pages, each with its position in the combined list
    const pages = [...next.report.pages].sort((x, y) => x.index - y.index);
    expect(pages.map((p) => [p.index, p.fileName])).toEqual([[0, 'a.jpg'], [1, 'b.jpg'], [2, 'c.jpg']]);
    // and it can be extended again from the new result
    const again = await impl.append(next, [file('d.jpg'), file('e.jpg')]);
    expect(again.report.pages).toHaveLength(5);
    first.dispose();
    next.dispose();
    again.dispose();
  });

  it('appending nothing returns the same result; an unknown result is refused with a plain message', async () => {
    const impl = new ScanImpl({} as MediaLibrary);
    const r = await impl.analyze([file('a.jpg')]);
    expect(await impl.append(r, [])).toBe(r);
    const other = new ScanImpl({} as MediaLibrary);
    await expect(other.append(r, [file('b.jpg')])).rejects.toThrow(/cannot be extended/);
    r.dispose();
  });

  it('a result made by append can still be re-analysed page by page (the session carries over)', async () => {
    const impl = new ScanImpl({} as MediaLibrary);
    const r = await impl.analyze([file('a.jpg')]);
    const n = await impl.append(r, [file('b.jpg')]);
    await expect(n.reanalyzePage(5, {})).rejects.toThrow(/no page 5/);
    r.dispose();
    n.dispose();
  });
});
