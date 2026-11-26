import { defineNode } from '../../define';

export default defineNode({
  id: 'combine-xyz',
  title: 'Combine XYZ',
  category: 'math',
  description: 'Bundle three numbers into one vector wire. Wire it into the vector socket of a position, rotation or any other X / Y / Z group of settings instead of dragging three wires.',
  keywords: ['vector', 'xyz', 'bundle', 'join', 'compose', 'pack', 'vec3', 'three numbers', 'position', 'rotation'],
  inputs: {},
  outputs: { vector: { type: 'vector', label: 'Vector' } },
  params: {
    x: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'X' },
    y: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Y' },
    z: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Z' },
  },
  summary: () => 'X · Y · Z',
  render(ctx) {
    const p = ctx.params;
    return { vector: [p.x, p.y, p.z] };
  },
});
