/**
 * What the AR view needs from the editor to move ONE object instead of the whole placed frame. The view (loop.ts) owns the fingers,
 * the camera and the room; whatever knows about nodes (which objects are on this camera, their numbers, the undo steps) lives behind
 * this interface, in the UI layer (ui/store/arEdit.ts). The io layer never imports the editor.
 *
 * Numbers that cross it are in SCENE units and scene axes (the object frame the 3D nodes live in; see ar-pick.ts).
 */
import type { Vec3 } from '../../engine/lib/motion-math';
import type { WorldMoment } from '../../engine/lib/world-take';
import type { SceneFit } from '../../engine/lib/xr-math';

/** One object (or one shape of an SDF Scene), as it is right now. */
export interface ArSelected {
  id: string;
  /** The name shown in "Moving: ...". */
  name: string;
  /** Its middle, scene units. */
  centre: Vec3;
  /** A generous radius around it, scene units (for the ring). */
  radius: number;
  /** From its middle down to its lowest point, scene units (a guess; used by "put it back on the floor"). */
  half: number;
  /** A Physics node moves it: the gestures edit where its body starts, and the fall begins again when the finger lets go. */
  physics: boolean;
  /** What a wire decides. A locked gesture changes nothing. */
  locked: { move: boolean; turn: boolean; size: boolean };
}

/** What a gesture has done so far since it began (all relative to the numbers at its start). */
export interface ArChange {
  /** Its new middle, scene units. */
  move?: Vec3;
  /** Turned about the up axis by this many degrees in total, in the sense of the two-finger twist. */
  turn?: number;
  /** Resized by this factor in total. */
  scale?: number;
}

export interface ArEditHost {
  /** Is there anything to move one at a time? (More than one object, a scene with several shapes, or a Physics node.) */
  available(): boolean;
  /** How the scene sits on the placement (the camera node's Object size and Lift). Asked fresh each time. */
  fit(): SceneFit;
  /** The object under a ray of the scene (null = none). `moment` is what the view is showing now, for the live pose of falling objects. */
  pick(ray: { origin: Vec3; dir: Vec3 }, moment: WorldMoment, seconds: number): Promise<ArSelected | null>;
  /** The numbers of a picked object now (null = it is gone). */
  selected(id: string): ArSelected | null;
  /** A gesture starts on it: everything until `end` is one undo step. */
  begin(id: string): void;
  apply(id: string, change: ArChange): void;
  end(id: string): void;
}
