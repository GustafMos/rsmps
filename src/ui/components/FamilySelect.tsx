import { useMemo } from 'react';
import type { NodeInstance } from '../../engine/types';
import { familyMembers } from '../lib/convert';
import { useApp } from '../store/context';
import { SelectField } from './fields';

/** "Type" dropdown of a node whose definition has a `family`: converts the node in place (one undo step). Renders nothing otherwise. */
export function FamilySelect({ node, large }: { node: NodeInstance; large?: boolean }) {
  const { ed } = useApp();
  const options = useMemo(() => familyMembers(ed.registry, node.type).map((m) => ({ value: m.id, label: m.title })), [ed, node.type]);
  if (options.length < 2) return null;
  return (
    <div className="rs-nodekind" data-nodrag>
      <SelectField large={large} value={node.type} options={options} onChange={(v) => ed.convertNodeType(node.id, v)} label="Type" title="Change what this node does. Its wires and shared settings stay." />
    </div>
  );
}
