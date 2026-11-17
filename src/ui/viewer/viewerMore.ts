import type { MenuItem } from '../components/Menu';
import { createStore } from '../store/createStore';

/** The rows the viewer has folded away from its bar (or all of them on a phone). The phone's viewer header shows them in its own "…" menu. */
export const viewerMore = createStore<{ items: MenuItem[] }>({ items: [] });
