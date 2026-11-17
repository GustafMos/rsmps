import { describe, expect, it, vi } from 'vitest';
import { applyDeviceDefaults, deviceDefaults, deviceTier, parsePreviewScale } from './deviceDefaults';

const MB = 1024 * 1024;
const mem = (kv: Record<string, string> = {}) => {
  const m = new Map(Object.entries(kv));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const fakeIo = () => ({ player: { setProxy: vi.fn() }, memoryBudget: { set: vi.fn(), ramBudget: { set: vi.fn() } } }) as never as Parameters<typeof applyDeviceDefaults>[0] & { player: { setProxy: ReturnType<typeof vi.fn> }; memoryBudget: { set: ReturnType<typeof vi.fn>; ramBudget: { set: ReturnType<typeof vi.fn> } } };

describe('deviceTier', () => {
  it('reads a low-memory phone as low', () => {
    expect(deviceTier({ deviceMemory: 2, cls: 'phone', coarse: true })).toBe('low');
    expect(deviceTier({ deviceMemory: 4, cls: 'phone', coarse: true })).toBe('low');
  });
  it('treats a phone that reports nothing (Safari, Firefox) as mid, never high', () => {
    expect(deviceTier({ cls: 'phone', coarse: true })).toBe('mid');
    expect(deviceTier({ cores: 8, cls: 'phone', coarse: true })).toBe('mid');
  });
  it('a capable phone can be high; a desktop with plenty of everything is high', () => {
    expect(deviceTier({ deviceMemory: 8, cores: 8, cls: 'phone', coarse: true })).toBe('high');
    expect(deviceTier({ deviceMemory: 8, cores: 16, cls: 'desktop', coarse: false })).toBe('high');
    expect(deviceTier({ cls: 'desktop', coarse: false })).toBe('high');
  });
  it('a 4 GB desktop is mid, not low', () => {
    expect(deviceTier({ deviceMemory: 4, cls: 'desktop', coarse: false })).toBe('mid');
  });
});

describe('deviceDefaults', () => {
  it('lowers the preview scale and budgets on a low phone', () => {
    expect(deviceDefaults('low', 'phone')).toEqual({ previewScale: 0.5, gpuBudgetMB: 256, ramBudgetMB: 384 });
  });
  it('leaves desktops alone', () => {
    expect(deviceDefaults('high', 'desktop')).toEqual({ previewScale: 'auto', gpuBudgetMB: null, ramBudgetMB: null });
    expect(deviceDefaults('mid', 'desktop').previewScale).toBe('auto');
  });
});

describe('applyDeviceDefaults', () => {
  it('applies the phone defaults once, and records that it did', () => {
    const io = fakeIo();
    const st = mem();
    const r = applyDeviceDefaults(io, { deviceMemory: 4, cls: 'phone', coarse: true }, st);
    expect(r).toEqual({ scale: 0.5, budgets: true });
    expect(io.player.setProxy).toHaveBeenCalledWith(0.5);
    expect(io.memoryBudget.set).toHaveBeenCalledWith(256 * MB);
    expect(io.memoryBudget.ramBudget.set).toHaveBeenCalledWith(384 * MB);
    const io2 = fakeIo();
    applyDeviceDefaults(io2, { deviceMemory: 4, cls: 'phone', coarse: true }, st);
    expect(io2.memoryBudget.set).not.toHaveBeenCalled(); // once only
    expect(io2.player.setProxy).toHaveBeenCalledWith(0.5); // the preview scale is applied every start
  });
  it('never overrides a budget or preview scale the user chose', () => {
    const io = fakeIo();
    const st = mem({ rsmpsMemoryBudgetMB: '1024', rsmpsRamBudgetMB: '2048', 'rsmps.ui.previewScale': '1' });
    const r = applyDeviceDefaults(io, { deviceMemory: 2, cls: 'phone', coarse: true }, st);
    expect(r.scale).toBe(1);
    expect(io.memoryBudget.set).not.toHaveBeenCalled();
    expect(io.memoryBudget.ramBudget.set).not.toHaveBeenCalled();
  });
  it('an explicit Auto choice leaves the proxy to the player', () => {
    const io = fakeIo();
    applyDeviceDefaults(io, { deviceMemory: 2, cls: 'phone', coarse: true }, mem({ 'rsmps.ui.previewScale': 'auto' }));
    expect(io.player.setProxy).not.toHaveBeenCalled();
  });
  it('does nothing on a desktop', () => {
    const io = fakeIo();
    expect(applyDeviceDefaults(io, { deviceMemory: 8, cores: 16, cls: 'desktop', coarse: false }, mem())).toEqual({ scale: 'auto', budgets: false });
    expect(io.player.setProxy).not.toHaveBeenCalled();
  });
});

describe('parsePreviewScale', () => {
  it('accepts auto and sane fractions only', () => {
    expect(parsePreviewScale('auto')).toBe('auto');
    expect(parsePreviewScale('0.5')).toBe(0.5);
    expect(parsePreviewScale('7')).toBeNull();
    expect(parsePreviewScale('x')).toBeNull();
    expect(parsePreviewScale(null)).toBeNull();
  });
});
