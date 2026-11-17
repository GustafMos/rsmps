/**
 * Mounts the workflow features next to the editor's own dialogs: Share, Render queue, Templates, Stop-motion, the "Open shared graph?"
 * confirmation for `#g=` links, the start screen and the queue badge. One small, marked mount in App.tsx; the editor store is untouched.
 */
import { useEffect } from 'react';
import { ShareError, decodeShareLink, readShareHash } from '../io/share';
import { QueueBadge, QueueDialog } from './queue/QueueDialog';
import { IncomingShareDialog, ShareDialog } from './share/ShareDialogs';
import { StartScreen, TemplatesDialog } from './start/StartScreen';
import { StopMotionDialog } from './stopmotion/StopMotionDialog';
import { useApp } from './store/context';
import { featureStore, setIncoming } from './store/features';
import { useSelector } from './store/createStore';

/** A `#g=` fragment (on load, or pasted into the address bar later) becomes a confirmation, never an automatic open. */
function useShareLinks(): void {
  const { io } = useApp();
  useEffect(() => {
    const check = () => {
      let payload: string | null = null;
      try {
        payload = readShareHash(location.hash);
      } catch {
        return;
      }
      if (payload === null) return;
      try {
        const { graph, report } = decodeShareLink(payload, io.registry);
        setIncoming({ graph, report, source: 'link' });
      } catch (err) {
        setIncoming({ source: 'link', error: err instanceof ShareError || err instanceof Error ? err.message : 'The link could not be read.' });
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [io]);
}

export function FeatureHost() {
  useShareLinks();
  const dialog = useSelector(featureStore, (s) => s.dialog);
  return (
    <>
      {dialog === 'share' && <ShareDialog />}
      {dialog === 'queue' && <QueueDialog />}
      {dialog === 'templates' && <TemplatesDialog />}
      {dialog === 'stopmotion' && <StopMotionDialog />}
      <IncomingShareDialog />
      <StartScreen />
      <QueueBadge />
    </>
  );
}
