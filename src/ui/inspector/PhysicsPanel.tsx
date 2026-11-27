import { useEffect, useState } from 'react';
import { DEFAULT_BODY, normalizeBodies } from '../../engine/lib/physics/sim';
import { MAX_BODIES, type BodyKind, type BodyShape, type BodySpec } from '../../engine/lib/physics/types';
import { bodyPorts, drivableNodes, scatterBodies, sizeFromNode } from '../../engine/lib/physics/wiring';
import type { NodeInstance } from '../../engine/types';
import { useApp, useEd } from '../store/context';
import './physics.css';

const SHAPES: { value: BodyShape; label: string }[] = [
  { value: 'sphere', label: 'Sphere' },
  { value: 'box', label: 'Box' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'cylinder', label: 'Cylinder' },
];
const KINDS: { value: BodyKind; label: string }[] = [
  { value: 'dynamic', label: 'Falls' },
  { value: 'fixed', label: 'Fixed in place' },
  { value: 'kinematic', label: 'Moved by wires' },
];
const X3 = ['X', 'Y', 'Z'];

/** A number box that takes what you type when it makes sense and shows the stored value otherwise. */
function Num({ value, onChange, step = 0.1, min, max, label }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; label: string }) {
  const [text, setText] = useState(String(Number(value.toFixed(4))));
  useEffect(() => setText(String(Number(value.toFixed(4)))), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
      onBlur={() => setText(String(Number(value.toFixed(4))))}
    />
  );
}

function Triple({ title, v, onChange, step, label }: { title: string; v: [number, number, number]; onChange: (v: [number, number, number]) => void; step?: number; label: string }) {
  return (
    <div className="rs-phys__row">
      <span>{title}</span>
      {X3.map((a, i) => (
        <Num key={a} label={`${label} ${a}`} value={v[i]} step={step} onChange={(n) => onChange(v.map((o, j) => (j === i ? n : o)) as [number, number, number])} />
      ))}
    </div>
  );
}

/** Size boxes of a shape, named like the 3D nodes name them. */
function sizeFields(b: BodySpec): { title: string; i: number }[] {
  if (b.shape === 'sphere') return [{ title: 'Radius', i: 0 }];
  if (b.shape === 'box') return [{ title: 'Width', i: 0 }, { title: 'Height', i: 1 }, { title: 'Depth', i: 2 }];
  return [{ title: 'Radius', i: 0 }, { title: 'Height', i: 1 }];
}

function BodyCard({
  index,
  body,
  total,
  physId,
  update,
  duplicate,
  remove,
}: {
  index: number;
  body: BodySpec;
  total: number;
  physId: string;
  update: (b: BodySpec) => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const { ed } = useApp();
  const graph = useEd((s) => s.graph);
  const [more, setMore] = useState(false);
  const [target, setTarget] = useState('');
  const level = ed.level;
  void graph;
  const targets = drivableNodes(level, ed.registry, physId);
  const chosen = targets.find((t) => t.node.id === target) ?? null;
  const set = (patch: Partial<BodySpec>) => update({ ...body, ...patch });
  const ports = bodyPorts(index);
  const label = (n: NodeInstance) => n.label || ed.registry.get(n.type)?.title || n.type;
  return (
    <div className="rs-phys__body" data-body={index + 1}>
      <div className="rs-phys__head">
        <span className="rs-phys__no">{index + 1}</span>
        <select aria-label={`Shape of body ${index + 1}`} value={body.shape} onChange={(e) => set({ shape: e.target.value as BodyShape })}>
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select aria-label={`Kind of body ${index + 1}`} value={body.kind} onChange={(e) => set({ kind: e.target.value as BodyKind })}>
          {KINDS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button className="rs-btn" title="Add a copy of this body" disabled={total >= MAX_BODIES} onClick={duplicate}>Duplicate</button>
        <button className="rs-btn" title="Remove this body" onClick={remove}>Delete</button>
      </div>
      <div className="rs-phys__row rs-phys__row--one">
        {sizeFields(body).map((f) => (
          <div key={f.title} style={{ display: 'contents' }}>
            <span>{f.title}</span>
            <Num label={`${f.title} of body ${index + 1}`} value={body.size[f.i]} step={0.05} min={0.01} onChange={(n) => set({ size: body.size.map((o, j) => (j === f.i ? Math.max(0.01, n) : o)) as [number, number, number] })} />
          </div>
        ))}
      </div>
      <Triple title="Start at" label={`Start position of body ${index + 1}`} v={body.pos} step={0.1} onChange={(pos) => set({ pos })} />
      <Triple title="Start turn" label={`Start rotation of body ${index + 1}`} v={body.rot} step={5} onChange={(rot) => set({ rot })} />
      <button className="rs-phys__more" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Fewer settings' : 'More settings'}</button>
      {more && (
        <>
          <Triple title="Start speed" label={`Start velocity of body ${index + 1}`} v={body.vel} step={0.5} onChange={(vel) => set({ vel })} />
          <Triple title="Start spin" label={`Start spin of body ${index + 1}`} v={body.spin} step={10} onChange={(spin) => set({ spin })} />
          <div className="rs-phys__row rs-phys__row--one">
            <span>Mass</span>
            <Num label={`Mass of body ${index + 1}`} value={body.mass} step={0.1} min={0.001} onChange={(mass) => set({ mass: Math.max(0.001, mass) })} />
            <span>Bounciness</span>
            <Num label={`Bounciness of body ${index + 1}`} value={body.bounce} step={0.05} min={0} max={1.5} onChange={(bounce) => set({ bounce: Math.min(1.5, Math.max(0, bounce)) })} />
            <span>Friction</span>
            <Num label={`Friction of body ${index + 1}`} value={body.friction} step={0.05} min={0} onChange={(friction) => set({ friction: Math.max(0, friction) })} />
          </div>
        </>
      )}
      <div className="rs-phys__head">
        <select aria-label={`Node driven by body ${index + 1}`} value={target} onChange={(e) => setTarget(e.target.value)} title="The 3D node or SDF shape this body should move">
          <option value="">Drive a node...</option>
          {targets.map((t) => (
            <option key={t.node.id} value={t.node.id}>{label(t.node)}</option>
          ))}
        </select>
        <button
          className="rs-btn"
          disabled={!chosen}
          title={`Wires ${ports.pos === 'posExtra' ? 'Position of extra body' : 'Position ' + (index + 1)} into its Move XYZ and Rotation into its Rotate XYZ, in one undo step.`}
          onClick={() => {
            if (chosen) ed.driveWithBody(physId, index, chosen.node.id);
          }}
        >
          Drive
        </button>
        <button
          className="rs-btn"
          disabled={!chosen || !sizeFromNode(chosen.node)}
          title="Copies the size and shape of the chosen SDF Shape to this body, so it lands the way it looks."
          onClick={() => {
            const s = chosen ? sizeFromNode(chosen.node) : null;
            if (s) set(s);
          }}
        >
          Copy size
        </button>
      </div>
    </div>
  );
}

/** Inspector section of the Physics node: the list of bodies, Scatter, and the helper that wires a body to a 3D node. */
export function PhysicsPanel({ node }: { node: NodeInstance }) {
  const { ed } = useApp();
  const bodies = normalizeBodies(node.params.bodies);
  const [count, setCount] = useState(6);
  const [seed, setSeed] = useState(1);
  const save = (next: BodySpec[]) => ed.setParam(node.id, 'bodies', next);
  return (
    <div className="rs-insp__sec rs-phys" data-physics>
      <div className="rs-caps">Bodies ({bodies.length} of {MAX_BODIES})</div>
      <p className="rs-insp__hint">
        Sizes are in scene units, like the 3D nodes: a SDF Shape sphere radius 0.5 is a body of radius 0.5; a default 3D Object is about 2 across. Wire Position and Rotation of a body into a node (or press Drive) to make it fall.
      </p>
      {bodies.map((b, i) => (
        <BodyCard
          key={i}
          index={i}
          body={b}
          total={bodies.length}
          physId={node.id}
          update={(nb) => save(bodies.map((o, j) => (j === i ? nb : o)))}
          duplicate={() => save([...bodies.slice(0, i + 1), { ...b, pos: [b.pos[0] + 0.3, b.pos[1] + 1, b.pos[2]] as [number, number, number] }, ...bodies.slice(i + 1)].slice(0, MAX_BODIES))}
          remove={() => save(bodies.filter((_, j) => j !== i))}
        />
      ))}
      <div className="rs-insp__actions">
        <button className="rs-btn" disabled={bodies.length >= MAX_BODIES} onClick={() => save([...bodies, { ...DEFAULT_BODY, pos: [bodies.length * 0.4 - 1, 2 + bodies.length * 0.6, 0] as [number, number, number] }])}>
          Add body
        </button>
      </div>
      <div className="rs-phys__scatter">
        <button className="rs-btn" disabled={bodies.length >= MAX_BODIES} title="Adds that many copies of the last body at random places above the floor. The same seed always gives the same places." onClick={() => save(scatterBodies(bodies, bodies[bodies.length - 1] ?? null, { count, seed, spread: 1.5, low: 1.5, high: 1.5 + count * 0.7 }))}>
          Scatter
        </button>
        <label>
          copies <input type="number" aria-label="Scatter copies" min={1} max={MAX_BODIES} value={count} onChange={(e) => setCount(Math.max(1, Math.min(MAX_BODIES, Math.round(Number(e.target.value) || 1))))} />
        </label>
        <label>
          seed <input type="number" aria-label="Scatter seed" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        </label>
      </div>
      <p className="rs-insp__hint">
        Bodies 1 to 8 have their own Position and Rotation outputs. Any other body is reached through Extra body. Only bodies 1 to 4 can be moved by wires (Move body and Turn body inputs).
      </p>
    </div>
  );
}
