import { MOTION_PORT } from '../../engine/define';
import { canBePhysical, colliderFor, physicsOf } from '../../engine/lib/physics/objects';
import { normalizeBodies } from '../../engine/lib/physics/sim';
import type { BodyShape } from '../../engine/lib/physics/types';
import type { NodeInstance } from '../../engine/types';
import { NumberField } from '../components/NumberField';
import { nodeDisplayName } from '../lib/nodeTitle';
import { useApp, useEd } from '../store/context';
import './physics.css';

const MODES = [
  { id: 'off', label: 'Off', title: 'This object is not moved by physics.' },
  { id: 'falls', label: 'Falls', title: 'It falls, bounces and lands on the floor.' },
  { id: 'fixed', label: 'Stays put', title: 'It stays where it is, and the things that fall hit it.' },
] as const;

const SHAPES: { value: BodyShape; label: string }[] = [
  { value: 'sphere', label: 'Ball' },
  { value: 'box', label: 'Box' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'cylinder', label: 'Cylinder' },
];

/**
 * "Physics" section in the inspector of every node physics can move (the ones with the standard Move / Rotate settings).
 * One choice sets everything up: the Physics node, a body shaped like this object, and ONE wire (see lib/physics/objects.ts).
 */
export function ObjectPhysics({ node }: { node: NodeInstance }) {
  const { ed } = useApp();
  const level = useEd((s) => s.level);
  if (!canBePhysical(node, ed.registry)) return null;
  const have = physicsOf(level, node.id);
  const body = have ? normalizeBodies(have.phys.params.bodies)[have.index] : undefined;
  const otherDriver = !have && level.edges.some((e) => e.to.node === node.id && e.to.port === MOTION_PORT);
  const mode = !have || !body ? 'off' : body.kind === 'fixed' ? 'fixed' : 'falls';
  const pick = (m: 'off' | 'falls' | 'fixed') => {
    if (m !== mode) ed.setObjectPhysics(node.id, m);
  };
  const note = body && have ? colliderFor(node).note : null;
  const physName = have ? nodeDisplayName(have.phys, ed.registry.get(have.phys.type)) : '';
  const set = (patch: Parameters<typeof ed.setBody>[2]) => {
    if (have) ed.setBody(have.phys.id, have.index, patch);
  };
  return (
    <div className="rs-insp__sec rs-objphys" data-object-physics>
      <div className="rs-caps">Physics</div>
      <div className="rs-objphys__seg" role="radiogroup" aria-label="Physics for this object">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className={`rs-btn${mode === m.id ? ' is-on' : ''}`} data-physics-mode={m.id} title={m.title} disabled={otherDriver} onClick={() => pick(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {otherDriver && <p className="rs-insp__hint">Another node already drives this object's Motion, so physics cannot move it. Disconnect that wire first.</p>}
      {!have && !otherDriver && <p className="rs-insp__hint">Choose Falls to let it fall and land on a floor, or Stays put so that other things hit it. Everything is set up for you.</p>}
      {have && body && (
        <>
          <p className="rs-insp__hint">
            {mode === 'fixed' ? 'It stays where it is; things that fall hit it.' : 'It falls from where it is now. Press play to watch.'} Drag it on the picture at the start to change where it starts.
          </p>
          <div className="rs-objphys__fields">
            <NumberField large label="Bounciness" min={0} max={1.5} softMax={1} step={0.05} value={body.bounce} defaultValue={0.5} onChange={(v) => set({ bounce: v })} />
            <NumberField large label="Grip" min={0} max={5} softMax={2} step={0.05} value={body.friction} defaultValue={0.6} onChange={(v) => set({ friction: v })} />
            <NumberField large label="Weight" min={0.001} max={100000} softMax={100} step={0.1} value={body.mass} defaultValue={1} onChange={(v) => set({ mass: v })} />
          </div>
          <div className="rs-insp__actions">
            <button className="rs-btn" data-physics-start-here title="Use where this object is now (its Move and Rotate) as the place it starts." onClick={() => ed.startPhysicsHere(node.id)}>
              Start here
            </button>
          </div>
          <details className="rs-objphys__shape">
            <summary>Shape used for bumping: {SHAPES.find((s) => s.value === body.shape)?.label ?? body.shape}</summary>
            {note && <p className="rs-insp__hint">{note}</p>}
            <div className="rs-objphys__row">
              <select aria-label="Shape used for bumping" value={body.shape} onChange={(e) => set({ shape: e.target.value as BodyShape })}>
                {SHAPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <button className="rs-btn" title="Take the shape and size from this object again." onClick={() => set(colliderFor(node).spec)}>
                Match the object
              </button>
            </div>
            <div className="rs-objphys__fields">
              {(body.shape === 'box' ? ['Width', 'Height', 'Depth'] : body.shape === 'sphere' ? ['Radius'] : ['Radius', 'Height']).map((title, i) => (
                <NumberField key={title} large label={title} min={0.01} max={100} step={0.05} value={body.size[i]} onChange={(v) => set({ size: body.size.map((o, j) => (j === i ? Math.max(0.01, v) : o)) as [number, number, number] })} />
              ))}
            </div>
          </details>
          <div className="rs-objphys__driven">
            <span>Driven by Physics</span>
            <button className="rs-btn" data-open-physics onClick={() => ed.select([have.phys.id])} title={`Select ${physName}`}>
              Open physics settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}
