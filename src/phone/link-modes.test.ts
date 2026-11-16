import { describe, expect, it } from 'vitest';
import { modeFromSearch, parseHello, parseMode, parseModeMsg, sendsVideo, thirdStepLabel } from './link-modes';

describe('phone modes', () => {
  it('reads the mode from the link and defaults to the camera, as before', () => {
    expect(modeFromSearch('?token=' + 'a'.repeat(32))).toBe('camera');
    expect(modeFromSearch('?token=x&mode=scan')).toBe('scan');
    expect(modeFromSearch('?mode=controller&token=x')).toBe('controller');
    expect(modeFromSearch('?mode=explode')).toBe('camera');
    expect(parseMode(undefined)).toBe('camera');
  });
  it('validates hello and mode messages', () => {
    expect(parseHello({ type: 'hello', v: 1, mode: 'scan', media: 'none' })).toEqual({ type: 'hello', v: 1, mode: 'scan', media: 'none' });
    expect(parseHello({ type: 'hello', mode: 'camera', media: 'refused' })!.media).toBe('refused');
    expect(parseHello({ type: 'hello', mode: 'camera', media: 'weird' })!.media).toBe('none');
    expect(parseHello({ type: 'hello', mode: 'fly' })).toBeNull();
    expect(parseHello({ type: 'ice' })).toBeNull();
    expect(parseModeMsg({ type: 'mode', mode: 'scan' })).toEqual({ type: 'mode', mode: 'scan' });
    expect(parseModeMsg({ type: 'mode', mode: 'x' })).toBeNull();
  });
  it('only camera mode with a working camera sends a picture', () => {
    expect(sendsVideo({ mode: 'camera', media: 'video' })).toBe(true);
    expect(sendsVideo({ mode: 'camera', media: 'refused' })).toBe(false);
    expect(sendsVideo({ mode: 'camera', media: 'none' })).toBe(false);
    expect(sendsVideo({ mode: 'scan', media: 'video' })).toBe(false);
    expect(sendsVideo({ mode: 'controller', media: 'none' })).toBe(false);
  });
  it('names the third pairing step for what the link does', () => {
    expect(thirdStepLabel('camera', null)).toBe('Video connected');
    expect(thirdStepLabel('camera', 'video')).toBe('Video connected');
    expect(thirdStepLabel('scan', 'none')).toBe('Scan mode ready');
    expect(thirdStepLabel('controller', 'none')).toBe('Controller linked');
    expect(thirdStepLabel('camera', 'refused')).toBe('Phone linked (no picture)');
  });
});
