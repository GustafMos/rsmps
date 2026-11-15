import type { AnyNodeDef, Capability } from '../../engine/types';
import type { Io } from '../../io/api';

/** Plain-words copy for every host capability a node can require (`NodeDef.requires`). One place to edit. */
const COPY: Record<Capability, { label: string; command: string; explain: (where: 'web' | 'packaged' | 'local') => string }> = {
  'local-server': {
    label: 'Local build only',
    command: 'npm run dev:lan',
    explain: (where) => {
      const first = where === 'web' ? 'This is the web version.' : where === 'packaged' ? 'This is the packaged app.' : 'The app is running without its local server.';
      return `${first} This node needs the app running on your own computer with its local server. It does not work in the web version or the packaged app. Start it with npm run dev:lan.`;
    },
  },
};

function where(): 'web' | 'packaged' | 'local' {
  const { protocol, hostname } = location;
  if (protocol === 'app:') return 'packaged';
  if (protocol === 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') return 'web';
  return 'local';
}

export interface Missing {
  capability: Capability;
  label: string;
  explanation: string;
  command: string;
}

/** Capabilities the node needs that this running copy of the app does not have (empty when it can work). */
export function missingCapabilities(io: Io, def: AnyNodeDef | undefined): Missing[] {
  if (!def?.requires?.length) return [];
  const have = io.capabilities();
  return def.requires.filter((c) => !have.has(c) && COPY[c]).map((c) => ({ capability: c, label: COPY[c].label, explanation: COPY[c].explain(where()), command: COPY[c].command }));
}
