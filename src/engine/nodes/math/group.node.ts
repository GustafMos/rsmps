/**
 * Group nodes (and the boundary nodes shown inside an open group). These registered definitions are placeholders so documents with
 * groups load and validate; the real definition of each group node is built from its own params by `defOf` in src/engine/group.ts.
 * A group is never evaluated as a node: the engine flattens it (see docs/ENGINE.md, Pending rules, "Group nodes").
 */
import { GROUP_STATIC_DEFS } from '../../group';

export default GROUP_STATIC_DEFS;
