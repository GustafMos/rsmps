import { describe, expect, it } from 'vitest';
import { outputOptions } from './AudioOutputSelect';

describe('where the sound plays', () => {
  it('lists the system default first, then the devices', () => {
    expect(outputOptions([{ id: 'a', label: 'Speakers' }, { id: 'b', label: 'CABLE Input' }], '').map((o) => o.id)).toEqual(['', 'a', 'b']);
  });
  it('keeps a chosen device that is not connected right now, so the choice is not silently lost', () => {
    const opts = outputOptions([{ id: 'a', label: 'Speakers' }], 'cable');
    expect(opts.map((o) => o.id)).toEqual(['', 'a', 'cable']);
    expect(opts[2].label).toMatch(/not connected/);
    expect(outputOptions([{ id: 'a', label: 'Speakers' }], 'a')).toHaveLength(2);
  });
});
