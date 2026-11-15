import type { AnyNodeDef, NodeInstance } from '../../engine/types';
import { KIND_ICON, KIND_SHORT, kindOptions } from '../lib/outputInfo';
import { useApp } from '../store/context';
import { Icon, type IconName } from './Icon';

/** Prominent export-type switch for an Output node: one icon button per kind. */
export function KindPicker({ node, def }: { node: NodeInstance; def: AnyNodeDef }) {
  const { ed } = useApp();
  const value = String(node.params.kind ?? 'auto');
  return (
    <div className="rs-kind" role="radiogroup" aria-label="Export type" data-nodrag>
      {kindOptions(def).map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`rs-kind__btn${value === o.value ? ' is-on' : ''}`}
          title={o.label}
          onClick={() => ed.setParam(node.id, 'kind', o.value)}
        >
          <Icon name={(KIND_ICON as Record<string, IconName>)[o.value] ?? 'file'} size={14} />
          <span>{KIND_SHORT[o.value] ?? o.label}</span>
        </button>
      ))}
    </div>
  );
}
