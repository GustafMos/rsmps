import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { registerBuiltins } from '../../engine/nodes';
import { nodeDisplayName } from './nodeTitle';

const reg = new Registry();
registerBuiltins(reg);
const names: Record<string, string> = { a1: 'spaceship_final.glb', a2: 'cat.obj' };
const lookup = (id: string) => names[id];
const name = (type: string, params: Record<string, unknown> = {}, label?: string) => nodeDisplayName({ type, params, label }, reg.get(type), lookup);

describe('nodeDisplayName', () => {
  it('SDF shapes', () => {
    expect(name('sdf-shape')).toBe('SDF Shape Sphere');
    expect(name('sdf-shape', { shape: 'torus' })).toBe('SDF Shape Torus');
    expect(name('sdf-shape', { shape: 'rbox' })).toBe('SDF Shape Rounded box');
    expect(name('sdf-shape', { shape: 'image2d' })).toBe('SDF Shape Picture');
  });
  it('3D object: built-in shape, long and short model names, missing asset', () => {
    expect(name('object-3d', { shape: 'torus' })).toBe('3D Object Torus');
    expect(name('object-3d', { shape: 'custom', model: ['a1'] })).toBe('3D Object Spacesh');
    expect(name('object-3d', { shape: 'custom', model: ['a2'] })).toBe('3D Object Cat');
    expect(name('object-3d', { shape: 'custom', model: ['gone'] })).toBe('3D Object');
    expect(name('object-3d', { shape: 'custom', model: [] })).toBe('3D Object');
  });
  it('combine, modify, and nodes without a suffix', () => {
    expect(name('sdf-combine', { operation: 'subtract' })).toBe('SDF Combine Subtract');
    expect(name('sdf-modify')).toBe('SDF Modify Mirror');
    expect(name('blur')).toBe(reg.get('blur')!.title);
  });
  it('a renamed node keeps its own name', () => {
    expect(name('sdf-shape', { shape: 'torus' }, 'Ring')).toBe('Ring');
  });
});
