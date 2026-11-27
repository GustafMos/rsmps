import { useEffect, useState } from 'react';
import { DEFAULT_BODY, normalizeBodies } from '../../engine/lib/physics/sim';
import { MAX_BODIES, type BodyKind, type BodyShape, type BodySpec } from '../../engine/lib/physics/types';
import { scatterBodies } from '../../engine/lib/physics/wiring';
import { addableObjects, bodyLinks, findWorldAr, tidyableCount } from '../../engine/lib/physics/objects';
import type { NodeInstance } from '../../engine/types';
import { Icon } from '../components/Icon';
import { libraryAssetName, nodeDisplayName } from '../lib/nodeTitle';
import { useApp, useEd } from '../store/context';
import './physics.css';

const SHAPES: { value: BodyShape; label: string }[] = [
  { value: 'sphere', label: 'Ball' },
  { value: 'box', label: 'Box' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'cylinder', label: 'Cylinder' },
];
const KINDS: { value: BodyKind; label: string }[] = [
  { value: 'dynamic', label: 'Falls' },
  { value: 'fixed', label: 'Stays put' },
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
      inputMode="decimal"
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

/** The settings of one body, opened by tapping its row. */
function BodySettings({ index, body, update, startHere }: { index: number; body: BodySpec; update: (patch: Partial<BodySpec>) => void; startHere: (() => void) | null }) {
  const n = index + 1;
  return (
    <div className="rs-phys__detail">
      <div className="rs-phys__row rs-phys__row--one">
        <span>Moves</span>
        <select aria-label={`How object ${n} moves`} value={body.kind} onChange={(e) => update({ kind: e.target.value as BodyKind })}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <span>Shape</span>
        <select aria-label={`Shape used for bumping by object ${n}`} value={body.shape} onChange={(e) => update({ shape: e.target.value as BodyShape })}>
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>
      <div className="rs-phys__row rs-phys__row--one">
        {sizeFields(body).map((f) => (
          <div key={f.title} style={{ display: 'contents' }}>
            <span>{f.title}</span>
            <Num label={`${f.title} of object ${n}`} value={body.size[f.i]} step={0.05} min={0.01} onChange={(v) => update({ size: body.size.map((o, j) => (j === f.i ? Math.max(0.01, v) : o)) as [number, number, number] })} />
          </div>
        ))}
      </div>
      <Triple title="Starts at" label={`Start position of object ${n}`} v={body.pos} step={0.1} onChange={(pos) => update({ pos })} />
      <Triple title="Starts turned" label={`Start rotation of object ${n}`} v={body.rot} step={5} onChange={(rot) => update({ rot })} />
      <Triple title="Start speed" label={`Start velocity of object ${n}`} v={body.vel} step={0.5} onChange={(vel) => update({ vel })} />
      <Triple title="Start spin" label={`Start spin of object ${n}`} v={body.spin} step={10} onChange={(spin) => update({ spin })} />
      <div className="rs-phys__row rs-phys__row--one">
        <span>Bounciness</span>
        <Num label={`Bounciness of object ${n}`} value={body.bounce} step={0.05} min={0} max={1.5} onChange={(bounce) => update({ bounce: Math.min(1.5, Math.max(0, bounce)) })} />
        <span>Grip</span>
        <Num label={`Grip of object ${n}`} value={body.friction} step={0.05} min={0} onChange={(friction) => update({ friction: Math.max(0, friction) })} />
        <span>Weight</span>
        <Num label={`Weight of object ${n}`} value={body.mass} step={0.1} min={0.001} onChange={(mass) => update({ mass: Math.max(0.001, mass) })} />
      </div>
      {startHere && (
        <button className="rs-btn" onClick={startHere} title="Use where the object is now (its Move and Rotate) as the place it starts.">
          Start here
        </button>
      )}
    </div>
  );
}

/**
 * Inspector section of the Physics node, in plain words: what it does, the objects it moves (tap one for its settings), how to add one,
 * and the helpers for the floor and for projects wired the old way. The world settings follow below as ordinary settings groups.
 */
export function PhysicsPanel({ node }: { node: NodeInstance }) {
  const { ed, io } = useApp();
  const level = useEd((s) => s.level);
  const bodies = normalizeBodies(node.params.bodies);
  const links = bodyLinks(level, node.id);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [count, setCount] = useState(6);
  const [seed, setSeed] = useState(1);
  const assetName = libraryAssetName(io.library);
  const save = (next: BodySpec[]) => ed.setParam(node.id, 'bodies', next);
  const addable = addableObjects(level, ed.registry);
  const old = tidyableCount(level, ed.registry, node.id);
  const ar = findWorldAr(level);
  const full = bodies.length >= MAX_BODIES;
  const nameOf = (i: number): string => {
    const t = links[i]?.target;
    return t ? nodeDisplayName(t, ed.registry.get(t.type), assetName) : `Body ${i + 1} · ${bodies[i].shape === 'sphere' ? 'ball' : bodies[i].shape}`;
  };
  return (
    <div className="rs-insp__sec rs-phys" data-physics>
      <p className="rs-insp__hint rs-phys__lead">
        Physics moves the objects you add here: they fall, bump into each other and land on the floor.
        <br />
        Press play to watch. The picture in the viewer shows them as outlines.
      </p>
      <div className="rs-caps">Objects ({bodies.length} of {MAX_BODIES})</div>
      {bodies.length === 0 && <p className="rs-insp__hint">Nothing yet. Add an object below, or select a 3D object and choose Falls in its Physics section.</p>}
      {bodies.map((b, i) => {
        const link = links[i];
        const isOpen = open === i;
        return (
          <div key={i} className={`rs-phys__item${isOpen ? ' is-open' : ''}`} data-body={i + 1}>
            <div className="rs-phys__itemhead">
              <button className="rs-phys__tap" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)} title="Tap for this object's settings">
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                <span className="rs-phys__name">{nameOf(i)}</span>
                <span className="rs-phys__kind">{KINDS.find((k) => k.value === b.kind)?.label}</span>
              </button>
              {link?.target && (
                <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label={`Select ${nameOf(i)}`} title="Select this object" onClick={() => ed.select([link.target!.id])}>
                  <Icon name="eye" size={14} />
                </button>
              )}
              <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label={`Remove ${nameOf(i)} from physics`} title="Remove it from physics (the object stays)" onClick={() => { ed.removePhysicsBody(node.id, i); setOpen(null); }}>
                <Icon name="close" size={14} />
              </button>
            </div>
            {isOpen && (
              <BodySettings
                index={i}
                body={b}
                update={(patch) => ed.setBody(node.id, i, patch)}
                startHere={link?.target ? () => ed.startPhysicsHere(link.target!.id) : null}
              />
            )}
          </div>
        );
      })}
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary" data-add-object disabled={full} aria-expanded={adding} onClick={() => setAdding(!adding)} title="Pick a 3D object or SDF shape in this graph to let it fall">
          Add an object…
        </button>
        <button className="rs-btn" disabled={full} title="A body with no object: it falls and bumps like the others and you can read where it is, but nothing is drawn." onClick={() => save([...bodies, { ...DEFAULT_BODY, pos: [bodies.length * 0.4 - 1, 2 + bodies.length * 0.6, 0] }])}>
          Add an invisible body
        </button>
      </div>
      {adding && (
        <div className="rs-phys__pick" role="listbox" aria-label="Objects you can add">
          {addable.length === 0 && <p className="rs-insp__hint">No other 3D objects or shapes here. Add a 3D Object or an SDF Shape to this graph first.</p>}
          {addable.map((o) => (
            <button key={o.id} role="option" aria-selected={false} className="rs-btn" onClick={() => { ed.addObjectToPhysics(node.id, o.id); setAdding(false); }}>
              {nodeDisplayName(o, ed.registry.get(o.type), assetName)}
            </button>
          ))}
        </div>
      )}
      {old > 0 && (
        <div className="rs-phys__tidy">
          <p className="rs-insp__hint">{old === 1 ? '1 object is' : `${old} objects are`} wired the old way, with a Position wire and a Rotation wire each. They work as before.</p>
          <button className="rs-btn" data-tidy onClick={() => ed.tidyPhysicsWiring(node.id)} title="Replace each pair of wires with one Motion wire. Nothing moves differently.">
            Tidy wiring
          </button>
        </div>
      )}
      {ar && (
        <div className="rs-phys__tidy">
          <p className="rs-insp__hint">The real floor in the AR view is at minus the World AR Camera's Lift.</p>
          <button className="rs-btn" data-match-ar onClick={() => ed.matchPhysicsArFloor(node.id)} title="Sets Floor on and Floor height to minus the Lift of the World AR Camera, so things land on the real surface.">
            Match AR floor
          </button>
        </div>
      )}
      <details className="rs-phys__scatter-box">
        <summary>Scatter copies of the last object</summary>
        <div className="rs-phys__scatter">
          <button className="rs-btn" disabled={full || !bodies.length} title="Adds that many invisible copies of the last body at random places above the floor. The same seed always gives the same places." onClick={() => save(scatterBodies(bodies, bodies[bodies.length - 1] ?? null, { count, seed, spread: 1.5, low: 1.5, high: 1.5 + count * 0.7 }))}>
            Scatter
          </button>
          <label>
            copies <input type="number" inputMode="numeric" aria-label="Scatter copies" min={1} max={MAX_BODIES} value={count} onChange={(e) => setCount(Math.max(1, Math.min(MAX_BODIES, Math.round(Number(e.target.value) || 1))))} />
          </label>
          <label>
            seed <input type="number" inputMode="numeric" aria-label="Scatter seed" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </label>
        </div>
      </details>
    </div>
  );
}
