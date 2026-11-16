import { describe, expect, it } from 'vitest';
import { CLOSE, closeMessage, countdown } from './messages';

describe('phone messages', () => {
  it('translates every close code the server uses into plain words', () => {
    expect(closeMessage(CLOSE.unknown)?.text).toMatch(/not known to the computer.*Scan the QR code currently shown/);
    expect(closeMessage(CLOSE.expired)?.text).toMatch(/expired/);
    expect(closeMessage(CLOSE.busy)?.text).toMatch(/already connected/);
    expect(closeMessage(CLOSE.ended)?.text).toMatch(/closed this session/);
    expect(closeMessage(CLOSE.badToken)?.final).toBe(true);
    expect(closeMessage(1006)).toBeNull(); // a network drop is not final: the page reconnects
  });
  it('formats the countdown', () => {
    expect(countdown(null, 0)).toBe('');
    expect(countdown(125_000, 0)).toBe('2:05');
    expect(countdown(1000, 5000)).toBe('0:00');
  });
});
