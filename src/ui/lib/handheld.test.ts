import { describe, expect, it } from 'vitest';
import { cameraSource, liveOrientOfNode } from '../../engine/lib/live-source';
import { cameraNodeFor, isHandheld } from './handheld';

describe('phones and tablets use their own camera', () => {
  it('recognises a phone or tablet', () => {
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36' })).toBe(true);
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(true);
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { mobile: true } })).toBe(true);
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true); // iPad
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isHandheld({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 })).toBe(false); // a touch laptop
    expect(isHandheld(undefined)).toBe(false);
  });
  it('Webcam starts on the back camera on a phone; Phone Camera becomes the Webcam where there is no phone link', () => {
    expect(cameraNodeFor('camera-in', true, false)).toEqual({ type: 'camera-in', params: { facing: 'back', mirror: false }, swapped: false });
    expect(cameraNodeFor('camera-in', true, false, { facing: 'front' }).params).toEqual({ facing: 'front', mirror: false });
    expect(cameraNodeFor('phone-camera', true, false)).toEqual({ type: 'camera-in', params: { facing: 'back', mirror: false }, swapped: true });
    expect(cameraNodeFor('phone-camera', true, true).type).toBe('phone-camera'); // a phone in the desktop app's own link: left alone
    expect(cameraNodeFor('camera-in', false, false)).toEqual({ type: 'camera-in', params: undefined, swapped: false });
    expect(cameraNodeFor('phone-camera', false, false).type).toBe('phone-camera');
    expect(cameraNodeFor('blur', true, false, { radius: 3 })).toEqual({ type: 'blur', params: { radius: 3 }, swapped: false });
  });
  it('the Side setting picks the camera, and the back camera is never mirrored', () => {
    expect(cameraSource({ device: '', facing: 'back' })).toMatchObject({ kind: 'camera', deviceId: '', facing: 'environment' });
    expect(cameraSource({ device: '', facing: 'front' })).toMatchObject({ facing: 'user' });
    expect('facing' in cameraSource({ device: '', facing: 'auto' })).toBe(false);
    expect('facing' in cameraSource({ device: 'abc', facing: 'back' })).toBe(false); // a camera picked by name wins
    expect(liveOrientOfNode('camera-in', { mirror: true, facing: 'back', device: '' }).mirror).toBe(false);
    expect(liveOrientOfNode('camera-in', { mirror: true, facing: 'front', device: '' }).mirror).toBe(true);
    expect(liveOrientOfNode('camera-in', { mirror: true, facing: 'auto', device: '' }).mirror).toBe(true);
    expect(liveOrientOfNode('camera-in', { mirror: true, facing: 'back', device: 'abc' }).mirror).toBe(true);
  });
});
