import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOT_AFFILIATED } from './aboutCopy';

describe('About box wording', () => {
  it('is the same not-affiliated paragraph as the README (which the websites copy)', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const m = /\*\*Not affiliated\.\*\* ([^\n]+)/.exec(readme);
    expect(m).not.toBeNull();
    expect(NOT_AFFILIATED).toBe(m![1].trim());
    const main = readFileSync(new URL('../../desktop/main.mjs', import.meta.url), 'utf8');
    expect(main).toContain(JSON.stringify(NOT_AFFILIATED));
    expect(NOT_AFFILIATED).toMatch(/not affiliated with, sponsored by or endorsed by/);
  });
});
