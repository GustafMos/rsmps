import { describe, expect, it } from 'vitest';
import { MemoryGovernor, defaultBudget, pressureOf, splitBudget, type GovernorTargets } from './memory';

const MB = 1024 * 1024;

describe('budget defaults and split', () => {
  it('chooses 768 MB for a discrete GPU and 384 MB for integrated or unknown', () => {
    expect(defaultBudget({ vendor: 'nvidia', description: 'NVIDIA GeForce RTX 3060' })).toBe(768 * MB);
    expect(defaultBudget({ vendor: 'amd', description: 'AMD Radeon RX 6700' })).toBe(768 * MB);
    expect(defaultBudget({ vendor: 'intel', architecture: 'gen-12lp', description: 'Intel(R) UHD Graphics' })).toBe(384 * MB);
    expect(defaultBudget({ vendor: 'apple' })).toBe(384 * MB);
    expect(defaultBudget({})).toBe(384 * MB);
    expect(defaultBudget({ vendor: 'nvidia', description: 'GeForce RTX', deviceMemoryGB: 4 })).toBe(384 * MB);
  });
  it('never hands out more than the total and shifts memory by mode', () => {
    for (const mode of ['paused', 'playing', 'export'] as const) {
      const s = splitBudget(800 * MB, mode);
      expect(s.engine + s.player + s.media + s.idle).toBeLessThan(800 * MB * 0.8); // the rest is the reserve for working textures
    }
    expect(splitBudget(800 * MB, 'playing').player).toBeGreaterThan(splitBudget(800 * MB, 'export').player);
    expect(splitBudget(800 * MB, 'paused').engine).toBeGreaterThan(splitBudget(800 * MB, 'playing').engine);
  });
  it('rates pressure', () => {
    expect(pressureOf(100, 1000)).toBe('ok');
    expect(pressureOf(800, 1000)).toBe('high');
    expect(pressureOf(1000, 1000)).toBe('critical');
  });
});

describe('MemoryGovernor', () => {
  function fake(allocated: { value: number }, idle: { value: number }) {
    const calls: string[] = [];
    const t = {
      gpu: {
        get allocatedBytes() {
          return allocated.value;
        },
        stats: () => ({ idleBytes: idle.value }),
        trimIdleTo: () => {
          allocated.value -= idle.value;
          idle.value = 0;
          calls.push('trim');
        },
        trim: () => calls.push('trimAll'),
      },
      exclusive: async (fn: () => unknown) => fn(),
      setEngineBudget: (b: number) => calls.push(`engine:${Math.round(b / MB)}`),
      clearEngine: async () => {
        calls.push('clearEngine');
        allocated.value -= 100 * MB;
      },
      setPlayerBudget: (b: number) => calls.push(`player:${Math.round(b / MB)}`),
      dropPlayerFrames: () => {
        calls.push('dropPlayer');
        allocated.value -= 50 * MB;
      },
      setMediaBudget: (b: number) => calls.push(`media:${Math.round(b / MB)}`),
      dropMediaFrames: () => {
        calls.push('dropMedia');
        allocated.value -= 50 * MB;
      },
      isPlaying: () => false,
    } as unknown as GovernorTargets;
    return { t, calls };
  }
  const noStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } as unknown as Storage;

  it('applies a split on creation and re-applies it when the total changes', () => {
    const { t, calls } = fake({ value: 0 }, { value: 0 });
    const g = new MemoryGovernor(t, 400 * MB, noStorage);
    expect(calls).toContain('engine:160');
    g.set(200 * MB);
    expect(g.get()).toBe(200 * MB);
    expect(calls).toContain('engine:80');
    g.auto();
    expect(g.get()).toBe(400 * MB);
  });

  it('enforces in order: idle textures, then frame caches, then media, then the engine cache', async () => {
    const allocated = { value: 600 * MB };
    const idle = { value: 100 * MB };
    const { t, calls } = fake(allocated, idle);
    const g = new MemoryGovernor(t, 300 * MB, noStorage);
    calls.length = 0;
    await g.enforce(); // 600 -> trim idle -> 500, still over: first step
    expect(calls.filter((c) => !c.includes(':'))).toEqual(['trim', 'trim', 'dropPlayer', 'trim']);
    await g.enforce();
    expect(calls).toContain('dropMedia');
    await g.enforce();
    expect(calls).toContain('clearEngine');
    expect(allocated.value).toBeLessThanOrEqual(300 * MB); // back within the budget
  });

  it('a requested mode (export) shifts the split and restores it afterwards', () => {
    const { t, calls } = fake({ value: 0 }, { value: 0 });
    const g = new MemoryGovernor(t, 1000 * MB, noStorage);
    calls.length = 0;
    const leave = g.enter('export');
    expect(calls).toContain('player:0');
    leave();
    expect(calls.at(-3)).toBe('engine:400');
  });
});
