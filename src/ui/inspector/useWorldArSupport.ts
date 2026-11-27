import { useEffect, useState } from 'react';
import type { WorldArSupport } from '../../io/world-ar/support';
import { useApp } from '../store/context';

/** Can this device do AR: asks the browser once (no permission question, nothing shown). */
export function useWorldArSupport(): WorldArSupport {
  const { io } = useApp();
  const [support, setSupport] = useState<WorldArSupport>({ state: 'checking', message: 'Checking whether this device can do AR.' });
  useEffect(() => {
    let live = true;
    void io.worldAr?.support().then((s) => live && setSupport(s));
    if (!io.worldAr) setSupport({ state: 'unsupported', message: 'The AR view is not available in this version of the app.' });
    return () => {
      live = false;
    };
  }, [io]);
  return support;
}
