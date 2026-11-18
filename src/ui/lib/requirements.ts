import type { AnyNodeDef, Capability } from '../../engine/types';
import type { Io } from '../../io/api';

/** Plain-words copy for every host capability a node can require (`NodeDef.requires`). One place to edit. */
const COPY: Record<Capability, { label: string; command: string; explain: (where: 'web' | 'packaged' | 'local') => string }> = {
  'local-server': {
    label: 'Desktop app or local build',
    command: 'npm run dev:lan',
    explain: (where) => {
      if (where === 'packaged') return 'The phone link is not available in this build of the app. Restart the app; if it is still missing, please report it.';
      if (where === 'web') return 'This is the web version. This node needs the desktop app (which starts its phone link when you ask) or a copy running on your own computer with its local server: npm run dev:lan. To use the camera of the phone or tablet this page is open on, add a Webcam node instead.';
      return 'The app is running without its local server. This node needs it: start the app with npm run dev:lan, or use the desktop app.';
    },
  },
  desktop: {
    label: 'Desktop app only',
    command: '',
    explain: (where) => {
      if (where === 'packaged') return 'The add-on service did not start in this build of the app. Restart the app; if it is still missing, please report it.';
      return 'This node runs separate programs on your computer (COLMAP and Brush, optional add-ons), which a web page is not allowed to do. Use the RSMPS desktop app and install the add-ons in Plugins > Official add-ons.';
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
