/**
 * UI state of the workflow features (Share, Queue, Templates, Stop-motion). Kept outside the Editor store on purpose: these panels are
 * mounted by <FeatureHost /> next to the editor's own dialogs, so they need no change to editor.ts.
 */
import { createStore } from './createStore';
import type { GraphDoc } from '../../engine/types';
import type { ShareReport } from '../../io/share';

export type FeatureDialog = 'share' | 'queue' | 'templates' | 'stopmotion' | null;

export interface IncomingShare {
  /** A decoded and sanitized shared graph waiting for the user's yes. */
  graph?: GraphDoc;
  report?: ShareReport;
  /** Where it came from. */
  source: 'link' | 'file';
  error?: string;
}

export interface FeatureState {
  dialog: FeatureDialog;
  incoming: IncomingShare | null;
  /** The start screen was dismissed for this session. */
  startDismissed: boolean;
}

export const featureStore = createStore<FeatureState>({ dialog: null, incoming: null, startDismissed: false });

export const openFeature = (dialog: FeatureDialog): void => featureStore.set((s) => ({ ...s, dialog }));
export const setIncoming = (incoming: IncomingShare | null): void => featureStore.set((s) => ({ ...s, incoming }));
export const dismissStart = (): void => featureStore.set((s) => ({ ...s, startDismissed: true }));
